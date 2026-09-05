import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../_lib/api";
import {
  DEFAULT_CHANGE_STEPS,
  fetchRiskDevices,
  scoreChangeServerSide,
} from "../../_lib/change";
import { approvalLevelsFor } from "@/lib/change/risk";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/changes/[id] — full change detail (Task 4-a):
 *   header + plans + parsed preChecks + devices (joined) + ordered steps
 *   + approvals (joined approver) + linked snapshots (ConfigSnapshot.changeId)
 *   + linked incidents + the approval levels the risk policy requires.
 *
 * PATCH /api/v1/changes/[id] — three modes in one endpoint:
 *   1. Field edit (any editable field present, no action): DRAFT only —
 *      409 NOT_EDITABLE otherwise. Full replace of children (devices +
 *      steps) in one short transaction; risk recomputed server-side.
 *   2. { action: "SUBMIT" }: DRAFT only → AWAITING_APPROVAL + PENDING
 *      ChangeApproval rows per approvalLevelsFor(riskLevel) (existing rows
 *      preserved; skipDuplicates keeps it idempotent) + CHANGE_SUBMITTED audit.
 *   3. { action: "CANCEL" }: allowed from DRAFT | AWAITING_APPROVAL |
 *      APPROVED | SCHEDULED (execution states are NOT cancellable — the
 *      execution engine owns those from 4-b on) → CANCELLED +
 *      CHANGE_CANCELLED audit.
 *   4. { action: "CLOSE" }: SUCCESSFUL only → CLOSED + CHANGE_CLOSED audit
 *      (Task 4-b — closes out a successful execution; no POST_REVIEW flow).
 *
 * Field edit + action may be combined in one call (edit applied first).
 */

const ID_MAX = 64;

const stepSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(["CHECK", "BACKUP", "APPLY", "VALIDATE", "ROLLBACK"]),
});

const patchSchema = z.object({
  action: z.enum(["SUBMIT", "CANCEL", "CLOSE"]).optional(),
  title: z.string().trim().min(6, "Title must be at least 6 characters").max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  type: z.enum(["STANDARD", "NORMAL", "EMERGENCY"]).optional(),
  siteId: z.string().trim().max(64).nullable().optional(),
  scheduledStart: z.coerce.date().nullable().optional(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  implementationPlan: z.string().trim().max(8000).nullable().optional(),
  validationPlan: z.string().trim().max(8000).nullable().optional(),
  rollbackPlan: z.string().trim().max(8000).nullable().optional(),
  deviceIds: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "Select at least one device")
    .max(20, "At most 20 devices per change")
    .optional(),
  steps: z.array(stepSchema).min(1).max(20).optional(),
});

/** Statuses from which a change may still be cancelled (pre-execution). */
const CANCELLABLE_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SCHEDULED"];

function parsePreChecks(
  raw: string | null
): { name: string; status: string; detail?: string }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null
        )
        .map((entry) => ({
          name: typeof entry.name === "string" ? entry.name : "Pre-check",
          status: typeof entry.status === "string" ? entry.status : "PENDING",
          detail: typeof entry.detail === "string" ? entry.detail : undefined,
        }));
    }
  } catch {
    // fall through — corrupt JSON degrades to an empty list
  }
  return [];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid change id", 400);
  }

  const change = await db.changeRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, name: true, email: true } },
      owner: { select: { id: true, name: true } },
      technicalOwner: { select: { id: true, name: true } },
      site: { select: { id: true, name: true, code: true } },
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }

  const [deviceLinks, steps, approvals, snapshots, incidents] = await Promise.all([
    db.changeDevice.findMany({
      where: { changeId: change.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        result: true,
        device: {
          select: {
            id: true,
            hostname: true,
            model: true,
            status: true,
            criticality: true,
            role: true,
            site: { select: { name: true, code: true } },
            vendor: { select: { key: true } },
          },
        },
      },
    }),
    db.changeStep.findMany({
      where: { changeId: change.id },
      orderBy: { order: "asc" },
    }),
    db.changeApproval.findMany({
      where: { changeId: change.id },
      orderBy: { level: "asc" },
      include: { approver: { select: { name: true, email: true } } },
    }),
    db.configSnapshot.findMany({
      where: { changeId: change.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        deviceId: true,
        version: true,
        status: true,
        source: true,
        createdAt: true,
        device: { select: { hostname: true } },
      },
    }),
    db.incident.findMany({
      where: { changeId: change.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        status: true,
      },
    }),
  ]);

  const payload = {
    id: change.id,
    number: change.number,
    title: change.title,
    description: change.description,
    type: change.type,
    status: change.status,
    riskScore: change.riskScore,
    riskLevel: change.riskLevel,
    requester: change.requester,
    owner: change.owner,
    technicalOwner: change.technicalOwner,
    site: change.site,
    scheduledStart: change.scheduledStart,
    scheduledEnd: change.scheduledEnd,
    implementationPlan: change.implementationPlan,
    validationPlan: change.validationPlan,
    rollbackPlan: change.rollbackPlan,
    preChecks: parsePreChecks(change.preChecksJson),
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    devices: deviceLinks.map((link) => ({
      linkId: link.id,
      deviceId: link.device.id,
      hostname: link.device.hostname,
      model: link.device.model,
      status: link.device.status,
      criticality: link.device.criticality,
      role: link.device.role,
      siteName: link.device.site?.name ?? null,
      siteCode: link.device.site?.code ?? null,
      vendorKey: link.device.vendor?.key ?? null,
      result: link.result,
    })),
    steps: steps.map((step) => ({
      id: step.id,
      order: step.order,
      name: step.name,
      type: step.type,
      status: step.status,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      level: approval.level,
      status: approval.status,
      approverName: approval.approver?.name ?? approval.approver?.email ?? null,
      decidedAt: approval.decidedAt,
      comment: approval.comment,
    })),
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      deviceId: snapshot.deviceId,
      hostname: snapshot.device.hostname,
      version: snapshot.version,
      status: snapshot.status,
      source: snapshot.source,
      createdAt: snapshot.createdAt,
    })),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      number: incident.number,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
    })),
  };

  return ok(payload);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid change id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const existing = await db.changeRequest.findUnique({ where: { id } });
  if (!existing) {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }

  const hasFieldEdits =
    data.title !== undefined ||
    data.description !== undefined ||
    data.type !== undefined ||
    data.siteId !== undefined ||
    data.scheduledStart !== undefined ||
    data.scheduledEnd !== undefined ||
    data.implementationPlan !== undefined ||
    data.validationPlan !== undefined ||
    data.rollbackPlan !== undefined ||
    data.deviceIds !== undefined ||
    data.steps !== undefined;

  const wantsEdit = hasFieldEdits && data.action === undefined;
  const wantsEditAndSubmit = hasFieldEdits && data.action === "SUBMIT";

  // Field edits are DRAFT-only (409 otherwise).
  if ((wantsEdit || wantsEditAndSubmit) && existing.status !== "DRAFT") {
    return fail(
      "NOT_EDITABLE",
      `Only draft changes can be edited — this change is ${existing.status}`,
      409
    );
  }

  // SUBMIT is DRAFT-only.
  if (data.action === "SUBMIT" && existing.status !== "DRAFT") {
    return fail(
      "NOT_EDITABLE",
      `Only draft changes can be submitted for approval — this change is ${existing.status}`,
      409
    );
  }

  // CANCEL is allowed only before execution begins.
  if (data.action === "CANCEL" && !CANCELLABLE_STATUSES.includes(existing.status)) {
    return fail(
      "NOT_CANCELLABLE",
      `A change in status ${existing.status} cannot be cancelled — execution states are owned by the change engine`,
      409
    );
  }

  // CLOSE is the post-success sign-off — SUCCESSFUL only (Task 4-b).
  if (data.action === "CLOSE" && existing.status !== "SUCCESSFUL") {
    return fail(
      "NOT_CLOSABLE",
      `Only SUCCESSFUL changes can be marked closed — this change is ${existing.status}`,
      409
    );
  }

  if (
    data.scheduledStart &&
    data.scheduledEnd &&
    data.scheduledEnd <= data.scheduledStart
  ) {
    return fail("SCHEDULE_INVALID", "scheduledEnd must be after scheduledStart", 400);
  }

  const correlationId = newCorrelationId("CHG");
  const actor = await db.user.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  /* ------------------------- field-edit path ------------------------- */
  if (hasFieldEdits) {
    const deviceIds = data.deviceIds ? Array.from(new Set(data.deviceIds)) : null;
    let devices: Awaited<ReturnType<typeof fetchRiskDevices>>["devices"] = [];
    if (deviceIds) {
      const fetched = await fetchRiskDevices(deviceIds);
      if (fetched.missing.length > 0) {
        return fail(
          "DEVICE_NOT_FOUND",
          `Unknown device id(s): ${fetched.missing.slice(0, 5).join(", ")}`,
          400
        );
      }
      devices = fetched.devices;
    }

    if (data.siteId) {
      const site = await db.site.findUnique({
        where: { id: data.siteId },
        select: { id: true },
      });
      if (!site) return fail("SITE_NOT_FOUND", "The selected site does not exist", 400);
    }

    // Recompute risk from the NEW state (values fall back to the existing row).
    const effectiveType = data.type ?? (existing.type as "STANDARD" | "NORMAL" | "EMERGENCY");
    const effectiveRollback =
      data.rollbackPlan !== undefined ? data.rollbackPlan : existing.rollbackPlan;
    const effectiveValidation =
      data.validationPlan !== undefined ? data.validationPlan : existing.validationPlan;
    const effectiveStart =
      data.scheduledStart !== undefined ? data.scheduledStart : existing.scheduledStart;

    let riskDevices = devices;
    if (!deviceIds) {
      const links = await db.changeDevice.findMany({
        where: { changeId: existing.id },
        select: { deviceId: true },
      });
      riskDevices = (await fetchRiskDevices(links.map((l) => l.deviceId))).devices;
    }

    const risk = scoreChangeServerSide(riskDevices, {
      type: effectiveType,
      hasRollbackPlan: Boolean(effectiveRollback && effectiveRollback.length > 0),
      hasValidationPlan: Boolean(effectiveValidation && effectiveValidation.length > 0),
      scheduledStart: effectiveStart,
    });

    const steps = (data.steps ?? DEFAULT_CHANGE_STEPS).map((step, index) => ({
      order: index + 1,
      name: step.name,
      type: step.type,
    }));

    await db.$transaction(
      async (tx) => {
        await tx.changeRequest.update({
          where: { id: existing.id },
          data: {
            title: data.title ?? existing.title,
            description:
              data.description !== undefined ? data.description : existing.description,
            type: effectiveType,
            siteId: data.siteId !== undefined ? data.siteId : existing.siteId,
            scheduledStart:
              data.scheduledStart !== undefined
                ? data.scheduledStart
                : existing.scheduledStart,
            scheduledEnd:
              data.scheduledEnd !== undefined ? data.scheduledEnd : existing.scheduledEnd,
            implementationPlan:
              data.implementationPlan !== undefined
                ? data.implementationPlan
                : existing.implementationPlan,
            validationPlan:
              data.validationPlan !== undefined
                ? data.validationPlan
                : existing.validationPlan,
            rollbackPlan:
              data.rollbackPlan !== undefined ? data.rollbackPlan : existing.rollbackPlan,
            riskScore: risk.score,
            riskLevel: risk.level,
          },
        });

        // Full replace of children (simple + safe on DRAFT — no results yet).
        if (deviceIds) {
          await tx.changeDevice.deleteMany({ where: { changeId: existing.id } });
          await tx.changeDevice.createMany({
            data: deviceIds.map((deviceId) => ({
              changeId: existing.id,
              deviceId,
              result: "PENDING",
            })),
          });
        }

        await tx.changeStep.deleteMany({ where: { changeId: existing.id } });
        await tx.changeStep.createMany({
          data: steps.map((step) => ({
            changeId: existing.id,
            order: step.order,
            name: step.name,
            type: step.type,
            status: "PENDING",
          })),
        });

        await tx.auditEvent.create({
          data: {
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? "Admin",
            action: "CHANGE_UPDATED",
            resourceType: "ChangeRequest",
            resourceId: existing.id,
            resourceLabel: existing.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({
              title: existing.title,
              status: existing.status,
              riskScore: existing.riskScore,
              riskLevel: existing.riskLevel,
            }),
            afterJson: JSON.stringify({
              title: data.title ?? existing.title,
              riskScore: risk.score,
              riskLevel: risk.level,
              deviceCount: deviceIds ? deviceIds.length : undefined,
              stepCount: steps.length,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
  }

  /* --------------------------- action paths -------------------------- */
  if (data.action === "SUBMIT") {
    const current = await db.changeRequest.findUnique({ where: { id } });
    if (!current) {
      return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
    }
    const levels = approvalLevelsFor(current.riskLevel);
    // Only create rows for levels that do not exist yet (skipDuplicates is
    // unsupported on SQLite — @@unique(changeId, level) guarded here instead).
    const existingLevels = await db.changeApproval.findMany({
      where: { changeId: current.id },
      select: { level: true },
    });
    const existingSet = new Set(existingLevels.map((row) => row.level));
    const newLevels = levels.filter((level) => !existingSet.has(level));

    await db.$transaction(
      async (tx) => {
        await tx.changeRequest.update({
          where: { id: current.id },
          data: { status: "AWAITING_APPROVAL" },
        });

        if (newLevels.length > 0) {
          await tx.changeApproval.createMany({
            data: newLevels.map((level) => ({
              changeId: current.id,
              level,
              status: "PENDING",
            })),
          });
        }

        await tx.auditEvent.create({
          data: {
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? "Admin",
            action: "CHANGE_SUBMITTED",
            resourceType: "ChangeRequest",
            resourceId: current.id,
            resourceLabel: current.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: current.status }),
            afterJson: JSON.stringify({
              status: "AWAITING_APPROVAL",
              riskLevel: current.riskLevel,
              approvalLevels: levels,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
  }

  if (data.action === "CANCEL") {
    const current = await db.changeRequest.findUnique({ where: { id } });
    if (!current) {
      return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
    }
    if (!CANCELLABLE_STATUSES.includes(current.status)) {
      return fail(
        "NOT_CANCELLABLE",
        `A change in status ${current.status} cannot be cancelled`,
        409
      );
    }

    await db.$transaction(
      async (tx) => {
        await tx.changeRequest.update({
          where: { id: current.id },
          data: { status: "CANCELLED" },
        });

        await tx.auditEvent.create({
          data: {
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? "Admin",
            action: "CHANGE_CANCELLED",
            resourceType: "ChangeRequest",
            resourceId: current.id,
            resourceLabel: current.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: current.status }),
            afterJson: JSON.stringify({ status: "CANCELLED" }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
  }

  if (data.action === "CLOSE") {
    const current = await db.changeRequest.findUnique({ where: { id } });
    if (!current) {
      return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
    }
    if (current.status !== "SUCCESSFUL") {
      return fail(
        "NOT_CLOSABLE",
        `Only SUCCESSFUL changes can be marked closed — this change is ${current.status}`,
        409
      );
    }

    await db.$transaction(
      async (tx) => {
        await tx.changeRequest.update({
          where: { id: current.id },
          data: { status: "CLOSED" },
        });

        await tx.auditEvent.create({
          data: {
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? "Admin",
            action: "CHANGE_CLOSED",
            resourceType: "ChangeRequest",
            resourceId: current.id,
            resourceLabel: current.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: current.status }),
            afterJson: JSON.stringify({ status: "CLOSED" }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
  }

  const updated = await db.changeRequest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      riskScore: true,
      riskLevel: true,
      type: true,
    },
  });

  const actionTaken =
    data.action === "SUBMIT"
      ? "submitted"
      : data.action === "CANCEL"
        ? "cancelled"
        : data.action === "CLOSE"
          ? "closed"
          : hasFieldEdits
            ? "updated"
            : "unchanged";

  return ok({
    change: updated,
    message: `Change ${actionTaken}.`,
    audit: {
      action:
        data.action === "SUBMIT"
          ? "CHANGE_SUBMITTED"
          : data.action === "CANCEL"
            ? "CHANGE_CANCELLED"
            : data.action === "CLOSE"
              ? "CHANGE_CLOSED"
              : "CHANGE_UPDATED",
      correlationId,
    },
  });
}
