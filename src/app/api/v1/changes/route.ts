import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import {
  DEFAULT_CHANGE_STEPS,
  fetchRiskDevices,
  nextChangeNumber,
  scoreChangeServerSide,
} from "../_lib/change";
import { resolveActingUser } from "../_lib/actor";
import { requirePermission, authErrorToFail } from "@/lib/auth/session";
import { approvalLevelsFor, BUSINESS_HOURS_POLICY_VERSION, BUSINESS_HOURS_TIMEZONE } from "@/lib/change/risk";
import { quorumRequiredFor } from "@/lib/change/approval-policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/changes
 * Filters: status (csv multi), type (csv multi), riskLevel (csv multi),
 *          q (number/title contains), requesterId (user id; "me" resolves
 *          to the authenticated session principal — P19 SEC-001).
 * Row fields from Phase 1 are preserved; `pendingApprovals` was added in
 * Task 4-a and meta now carries a light `summary` for the KPI mini-row.
 * Ordered newest first.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  type: z.string().optional(),
  riskLevel: z.string().optional(),
  q: z.string().trim().max(120).optional(),
  requesterId: z.string().trim().max(64).optional(),
  /** Calendar window (Task 4-a): changes whose schedule window overlaps. */
  scheduledFrom: z.coerce.date().optional(),
  scheduledTo: z.coerce.date().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    riskLevel: url.searchParams.get("riskLevel") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    requesterId: url.searchParams.get("requesterId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize, q, riskLevel, requesterId } = parsed.data;
  const statuses = csvParam(parsed.data.status);
  const types = csvParam(parsed.data.type);
  const riskLevels = csvParam(riskLevel);
  const scheduledFrom = parsed.data.scheduledFrom ?? null;
  const scheduledTo = parsed.data.scheduledTo ?? null;

  // "me" resolves to the authenticated principal (server-authoritative,
  // P19 SEC-001 — previously the seeded admin). 401 on dead sessions.
  let requesterFilter: string | undefined = requesterId;
  if (requesterId === "me") {
    const me = await resolveActingUser(request);
    if (!me) {
      return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
    }
    requesterFilter = me.id;
  }

  const where = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      types ? { type: { in: types } } : {},
      riskLevels ? { riskLevel: { in: riskLevels } } : {},
      requesterFilter ? { requesterId: requesterFilter } : {},
      q
        ? {
            OR: [
              { number: { contains: q } },
              { title: { contains: q } },
            ],
          }
        : {},
      // Schedule-window overlap (calendar): start <= to AND
      // (end >= from OR start >= from — end falls back to start when unset).
      scheduledTo
        ? { scheduledStart: { lte: scheduledTo as Date } }
        : {},
      scheduledFrom
        ? {
            OR: [
              { scheduledEnd: { gte: scheduledFrom as Date } },
              { scheduledStart: { gte: scheduledFrom as Date } },
            ],
          }
        : {},
    ],
  };

  const [total, rows, awaitingApproval, executingNow] = await Promise.all([
    db.changeRequest.count({ where }),
    db.changeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        title: true,
        type: true,
        status: true,
        riskScore: true,
        riskLevel: true,
        scheduledStart: true,
        scheduledEnd: true,
        createdAt: true,
        requester: { select: { id: true, name: true, email: true } },
        site: { select: { name: true, code: true } },
        _count: { select: { devices: true, steps: true } },
        approvals: {
          where: { status: "PENDING" },
          select: { id: true },
        },
      },
    }),
    db.changeRequest.count({ where: { status: "AWAITING_APPROVAL" } }),
    db.changeRequest.count({
      where: { status: { in: ["PRE_CHECK", "EXECUTING", "VALIDATING"] } },
    }),
  ]);

  // 30-day success rate over changes that reached a terminal state.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const terminalStatuses = [
    "SUCCESSFUL",
    "PARTIAL_SUCCESS",
    "CLOSED",
    "FAILED",
    "ROLLBACK",
    "ROLLBACK_FAILED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
  ];
  const successStatuses = ["SUCCESSFUL", "PARTIAL_SUCCESS", "CLOSED"];
  const [closedSuccess, closedTotal] = await Promise.all([
    db.changeRequest.count({
      where: {
        status: { in: successStatuses },
        updatedAt: { gte: thirtyDaysAgo },
      },
    }),
    db.changeRequest.count({
      where: { status: { in: terminalStatuses }, updatedAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  const shaped = rows.map(({ approvals, ...row }) => ({
    ...row,
    pendingApprovals: approvals.length,
  }));

  return ok(shaped, {
    ...pageMeta(page, pageSize, total),
    summary: {
      awaitingApproval,
      executingNow,
      successRate30d:
        closedTotal > 0 ? Math.round((closedSuccess / closedTotal) * 100) : null,
      closedChanges30d: closedTotal,
    },
  });
}

/* ------------------------------------------------------------------ */
/* POST — create a change request (wizard, Task 4-a)                   */
/* ------------------------------------------------------------------ */

const stepSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(["CHECK", "BACKUP", "APPLY", "VALIDATE", "ROLLBACK"]),
});

const createSchema = z.object({
  title: z.string().trim().min(6, "Title must be at least 6 characters").max(200),
  description: z.string().trim().max(4000).optional(),
  type: z.enum(["STANDARD", "NORMAL", "EMERGENCY"]),
  siteId: z.string().trim().max(64).optional(),
  scheduledStart: z.coerce.date().optional(),
  scheduledEnd: z.coerce.date().optional(),
  implementationPlan: z.string().trim().max(8000).optional(),
  validationPlan: z.string().trim().max(8000).optional(),
  rollbackPlan: z.string().trim().max(8000).optional(),
  deviceIds: z.array(z.string().trim().min(1).max(64)).min(1, "Select at least one device").max(20, "At most 20 devices per change"),
  steps: z.array(stepSchema).min(1).max(20).optional(),
  /** Submit for approval immediately → AWAITING_APPROVAL + PENDING approvals. */
  submit: z.boolean().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  if (data.scheduledStart && data.scheduledEnd && data.scheduledEnd <= data.scheduledStart) {
    return fail("SCHEDULE_INVALID", "scheduledEnd must be after scheduledStart", 400);
  }

  const { devices, missing } = await fetchRiskDevices(data.deviceIds);
  if (missing.length > 0) {
    return fail(
      "DEVICE_NOT_FOUND",
      `Unknown device id(s): ${missing.slice(0, 5).join(", ")}`,
      400
    );
  }

  if (data.siteId) {
    const site = await db.site.findUnique({ where: { id: data.siteId }, select: { id: true } });
    if (!site) return fail("SITE_NOT_FOUND", "The selected site does not exist", 400);
  }

  // Deduplicate device ids + steps while preserving order.
  const deviceIds = Array.from(new Set(data.deviceIds));
  const steps = (data.steps ?? DEFAULT_CHANGE_STEPS).map((step, index) => ({
    order: index + 1,
    name: step.name,
    type: step.type,
  }));

  // Authoritative risk score (shared pure engine — mirrors the wizard preview).
  const risk = scoreChangeServerSide(devices, {
    type: data.type,
    hasRollbackPlan: Boolean(data.rollbackPlan && data.rollbackPlan.length > 0),
    hasValidationPlan: Boolean(data.validationPlan && data.validationPlan.length > 0),
    scheduledStart: data.scheduledStart ?? null,
  });

  const submit = data.submit === true;
  const status = submit ? "AWAITING_APPROVAL" : "DRAFT";
  const correlationId = newCorrelationId("CHG");

  // Phase 19-C (audit AUTHZ-101D): change authoring is permission-gated —
  // the seeded matrix grants change.create to engineer (admin via wildcard);
  // operator/manager/viewer/auditor are denied server-side (403).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "change.create");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  // RT-014 — the number is allocated INSIDE the transaction via the tx
  // client, and a @@unique([number]) collision (two concurrent creations
  // read the same max) retries ONCE with a fresh read — the repo's cmdb
  // pattern. A second consecutive conflict answers a typed 409 so the
  // wizard shows a retryable error instead of a raw P2002/500; the failed
  // tx rolls back atomically (devices/steps/approvals included).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const change = await db.$transaction(
        async (tx) => {
          const number = await nextChangeNumber(tx);
          const created = await tx.changeRequest.create({
            data: {
              number,
              title: data.title,
              description: data.description ?? null,
              type: data.type,
              status,
              riskScore: risk.score,
              riskLevel: risk.level,
              requesterId: actor.id,
              ownerId: actor.id,
              siteId: data.siteId ?? null,
              scheduledStart: data.scheduledStart ?? null,
              scheduledEnd: data.scheduledEnd ?? null,
              implementationPlan: data.implementationPlan ?? null,
              validationPlan: data.validationPlan ?? null,
              rollbackPlan: data.rollbackPlan ?? null,
            },
          });

          await tx.changeDevice.createMany({
            data: deviceIds.map((deviceId) => ({
              changeId: created.id,
              deviceId,
              result: "PENDING",
            })),
          });

          await tx.changeStep.createMany({
            data: steps.map((step) => ({
              changeId: created.id,
              order: step.order,
              name: step.name,
              type: step.type,
              status: "PENDING",
            })),
          });

          if (submit) {
            // One PENDING approval per policy level, each stamped with its
            // quorum (POL-001 — CAB on CRITICAL changes requires two distinct
            // approvers). Fresh change ⇒ no existing rows, so no skipDuplicates
            // needed (unsupported on SQLite anyway).
            await tx.changeApproval.createMany({
              data: approvalLevelsFor(risk.level).map((level) => ({
                changeId: created.id,
                level,
                status: "PENDING",
                quorumRequired: quorumRequiredFor(level, risk.level),
              })),
            });
          }

          await tx.auditEvent.create({
            data: {
              actorId: actor.id,
              actorName: actor.name ?? "Unknown user",
              action: "CHANGE_CREATED",
              resourceType: "ChangeRequest",
              resourceId: created.id,
              resourceLabel: created.number,
              result: "SUCCESS",
              correlationId,
              afterJson: JSON.stringify({
                changeNumber: created.number,
                type: data.type,
                status,
                riskScore: risk.score,
                riskLevel: risk.level,
                riskPolicyVersion: BUSINESS_HOURS_POLICY_VERSION,
                riskTimezone: BUSINESS_HOURS_TIMEZONE,
                deviceCount: deviceIds.length,
                stepCount: steps.length,
                submit,
              }),
            },
          });

          if (submit) {
            await tx.auditEvent.create({
              data: {
                actorId: actor.id,
                actorName: actor.name ?? "Unknown user",
                action: "CHANGE_SUBMITTED",
                resourceType: "ChangeRequest",
                resourceId: created.id,
                resourceLabel: created.number,
                result: "SUCCESS",
                correlationId,
                afterJson: JSON.stringify({
                  changeNumber: created.number,
                  riskLevel: risk.level,
                  approvalLevels: approvalLevelsFor(risk.level),
                }),
              },
            });
          }

          return created;
        },
        { maxWait: 5_000, timeout: 20_000 }
      );

      return ok(
        {
          change: {
            id: change.id,
            number: change.number,
            title: change.title,
            type: change.type,
            status: change.status,
            riskScore: change.riskScore,
            riskLevel: change.riskLevel,
          },
          message: submit
            ? "Change submitted — PENDING approvals created per the risk policy."
            : "Change request created as a draft.",
          audit: { action: "CHANGE_CREATED", correlationId },
        },
        undefined,
        201
      );
    } catch (error) {
      // Unique violation on number → another create took the number: retry once.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const target = error.meta?.target;
        const targetText = Array.isArray(target)
          ? target.join(",")
          : String(target ?? "");
        if (targetText.includes("number")) {
          if (attempt === 0) continue;
          return fail(
            "CHANGE_NUMBER_CONFLICT",
            "Concurrent change creation exhausted the number retry — retry the request",
            409
          );
        }
      }
      throw error;
    }
  }

  // Unreachable — the loop returns or throws on every path; defensive
  // fall-through keeps the type checker happy (mirrors cmdb items route).
  return fail(
    "CHANGE_NUMBER_CONFLICT",
    "Concurrent change creation exhausted the number retry — retry the request",
    409
  );
}
