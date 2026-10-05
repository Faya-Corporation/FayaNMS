import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  newJobCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { authErrorToFail, requirePermission, requireSessionRead, requireSiteScope, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/jobs        — recent job executions (status csv filter, newest first).
 * POST /api/v1/jobs        — queue a job. Body: { type: "CONFIG_BACKUP", deviceId }.
 * Creates a QUEUED JobExecution + a CONFIG_BACKUP_QUEUED audit event and
 * returns both. The Phase 2 worker mini-service will pick these up.
 *
 * Wave 10 (F-031, audit 13-b F-4): the list composes the session's site
 * scope — JobExecution is DEVICE-keyed (targetType/targetId, no site FK),
 * so a sites-limited session sees only DEVICE-targeted jobs whose device
 * is inside its scope (deny-all scope → `in: []` → no rows; non-device
 * targets are hidden fail-closed, the AI plane's executeJobs shape).
 * Wildcard sessions keep the pre-wave-10 where shape byte-identical. The
 * POST gates the target device's site through requireSiteScope → 403
 * SITE_SCOPE_FORBIDDEN before anything is queued. F-6: the create type
 * enum is CONFIG_BACKUP only — REPORT_RUN never had a user-facing mint
 * path (the handler always queued CONFIG_BACKUP); REPORT_GENERATION rows
 * are minted by the report engine, not this route.
 */

const listSchema = paginationSchema.extend({
  status: z.string().optional(),
  deviceId: z.string().trim().min(1).optional(),
});

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const url = new URL(request.url);
  const parsed = listSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize, deviceId } = parsed.data;
  const statuses = csvParam(parsed.data.status);

  // F-4 (wave 10): the session's in-scope device ids (sites-mode only;
  // null = wildcard — the byte-parity path).
  const scopeClaims = await sessionScopeFor(request);
  const scopeDeviceIds =
    sessionSiteScope(scopeClaims).mode === "wildcard"
      ? null
      : (
          await db.device.findMany({
            where: scopedDeviceWhere(scopeClaims, {}),
            select: { id: true },
          })
        ).map((row) => row.id);

  const where = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      deviceId ? { targetId: deviceId, targetType: "DEVICE" } : {},
      // F-031 (wave 10): DEVICE-keyed scope leg — a deny-all scope yields
      // `in: []` (no rows); non-device targets stay hidden for scoped
      // sessions (fail-closed, mirroring the AI jobs executor).
      ...(scopeDeviceIds === null
        ? []
        : [{ targetType: "DEVICE", targetId: { in: scopeDeviceIds } }]),
    ],
  };

  const [total, rows] = await Promise.all([
    db.jobExecution.count({ where }),
    db.jobExecution.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return ok(rows, pageMeta(page, pageSize, total), 200);
}

const createSchema = z.object({
  // F-6 (wave 10, audit 13-b): CONFIG_BACKUP only — the handler always
  // queued a CONFIG_BACKUP regardless of this enum, so REPORT_RUN was a
  // dishonest contract entry (REPORT_GENERATION has no user mint path).
  type: z.enum(["CONFIG_BACKUP"]),
  deviceId: z.string().trim().min(1, "deviceId is required"),
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

  // Phase 19-C (audit AUTHZ-001 sweep): queueing jobs requires the
  // "job.run" permission and the audit row is attributed to the session
  // principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "job.run");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const { deviceId } = parsed.data;
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      status: true,
      site: { select: { code: true } },
    },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  // F-4 (wave 10, audit 13-b): the target device's site must be inside the
  // session's scope BEFORE anything is queued — 403 SITE_SCOPE_FORBIDDEN
  // (the documented mutation contract; a site-less device is an unscoped
  // resource and bypasses per the assertSiteScope(null) rule; wildcard
  // sessions are byte-unchanged).
  try {
    await requireSiteScope(request, device.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  if (device.status === "UNMANAGED") {
    return fail(
      "DEVICE_UNMANAGED",
      "Backup cannot be queued for an unmanaged device",
      409
    );
  }

  const correlationId = newJobCorrelationId();

  const [job, audit] = await db.$transaction([
    db.jobExecution.create({
      data: {
        type: "CONFIG_BACKUP",
        targetType: "DEVICE",
        targetId: device.id,
        status: "QUEUED",
        progress: 0,
        priority: 5,
        maxAttempts: 3,
        payloadJson: JSON.stringify({ deviceId: device.id }),
        correlationId,
      },
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "CONFIG_BACKUP_QUEUED",
        resourceType: "DEVICE",
        resourceId: device.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
      },
    }),
  ]);

  return ok({ job, audit }, { correlationId }, 201);
}
