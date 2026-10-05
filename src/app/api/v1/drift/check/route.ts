import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission, requireSiteScope, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/drift/check — manual drift trigger (Task 3-c).
 *
 * Body: { deviceId?: string }
 *   - with deviceId: a single device. It must exist (404) and be inside the
 *     session's site scope (403 SITE_SCOPE_FORBIDDEN — F-031 wave-10, audit
 *     13-c F-8; the gate runs BEFORE the baseline check so NO_BASELINE 409
 *     is never an out-of-scope baseline-existence oracle) and have an
 *     approved baseline (409 NO_BASELINE).
 *   - without: the whole baseline-covered fleet, skipping devices that
 *     already have a QUEUED/RUNNING DRIFT_CHECK in flight (capped at 50) —
 *     the candidate device pool is INTERSECTED with the session scope
 *     (scopedDeviceWhere), so sites-limited sessions check only their own
 *     devices; wildcard keeps the byte-unchanged where.
 *
 * Creates QUEUED DRIFT_CHECK JobExecutions with triggeredBy "MANUAL" and
 * returns { enqueued, correlationId, jobs }. One summary DRIFT_CHECK_QUEUED
 * audit event per request (DFT- correlation id) — never one per job.
 */

const checkSchema = z.object({
  deviceId: z.string().trim().min(1).max(64).optional(),
});

const FLEET_CAP = 50;

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = checkSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { deviceId } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): manual drift checks require the
  // "config.baseline" permission; the audit row is attributed to the
  // session principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.baseline");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  // Summary correlation id for the audit event (jobs keep their JOB- ids).
  const correlationId = newCorrelationId("DFT");

  if (deviceId) {
    const device = await db.device.findUnique({
      where: { id: deviceId },
      select: { id: true, hostname: true, site: { select: { code: true } } },
    });
    if (!device) {
      return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
    }

    // F-031 wave-10 (audit 13-c F-8): scope gate BEFORE the baseline probe —
    // NO_BASELINE must never answer for an out-of-scope device (existence
    // oracle on cross-site baseline coverage).
    try {
      await requireSiteScope(request, device.site?.code ?? null);
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }

    const baseline = await db.configBaseline.findFirst({
      where: { deviceId: device.id },
      select: { id: true },
    });
    if (!baseline) {
      return fail(
        "NO_BASELINE",
        `${device.hostname} has no approved baseline — approve a snapshot as baseline first`,
        409
      );
    }

    const jobCorrelationId = newJobCorrelationId();
    const [job] = await db.$transaction(
      async (tx) => {
        const created = await tx.jobExecution.create({
          data: {
            type: "DRIFT_CHECK",
            targetType: "DEVICE",
            targetId: device.id,
            status: "QUEUED",
            progress: 0,
            priority: 5,
            maxAttempts: 3,
            payloadJson: JSON.stringify({
              deviceId: device.id,
              hostname: device.hostname,
              triggeredBy: "MANUAL",
            }),
            correlationId: jobCorrelationId,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Unknown user",
            action: "DRIFT_CHECK_QUEUED",
            resourceType: "DEVICE",
            resourceId: device.id,
            resourceLabel: device.hostname,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              triggeredBy: "MANUAL",
              scope: "single-device",
              enqueued: 1,
            }),
          },
        });
        return [created];
      },
      { maxWait: 5_000, timeout: 20_000 }
    );

    return ok(
      {
        enqueued: 1,
        correlationId,
        jobs: [{ jobId: job.id, deviceId: device.id, hostname: device.hostname }],
      },
      undefined,
      201
    );
  }

  // Fleet scope: every baseline-covered device, minus in-flight checks.
  const baselineDevices = await db.configBaseline.findMany({
    select: { deviceId: true },
    distinct: ["deviceId"],
  });
  if (baselineDevices.length === 0) {
    return fail(
      "NO_BASELINES",
      "No device has an approved baseline — nothing to check",
      409
    );
  }

  const inFlight = await db.jobExecution.findMany({
    where: { type: "DRIFT_CHECK", status: { in: ["QUEUED", "RUNNING"] } },
    select: { targetId: true },
  });
  const skip = new Set(
    inFlight.map((j) => j.targetId).filter((id): id is string => Boolean(id))
  );

  const candidates = baselineDevices
    .map((b) => b.deviceId)
    .filter((id) => !skip.has(id))
    .slice(0, FLEET_CAP);
  if (candidates.length === 0) {
    return ok({ enqueued: 0, correlationId, jobs: [] });
  }

  // F-031 wave-10 (audit 13-c F-8): fleet mode intersects the candidate
  // device pool with the session scope at the device fetch (wildcard keeps
  // the byte-unchanged where) — sites-limited sessions enqueue only their
  // own devices; the enqueued count follows.
  const scopeClaims = await sessionScopeFor(request);
  const devices = await db.device.findMany({
    where: scopedDeviceWhere(scopeClaims, { id: { in: candidates } }),
    select: { id: true, hostname: true },
    orderBy: { hostname: "asc" },
  });
  if (devices.length === 0) {
    return ok({ enqueued: 0, correlationId, jobs: [] });
  }

  const jobs = await db.$transaction(
    async (tx) => {
      const created = await tx.jobExecution.createMany({
        data: devices.map((d) => ({
          type: "DRIFT_CHECK",
          targetType: "DEVICE",
          targetId: d.id,
          status: "QUEUED",
          progress: 0,
          priority: 5,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            deviceId: d.id,
            hostname: d.hostname,
            triggeredBy: "MANUAL",
          }),
          correlationId: newJobCorrelationId(),
        })),
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: "DRIFT_CHECK_QUEUED",
          resourceType: "DriftRecord",
          resourceLabel: "fleet",
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            triggeredBy: "MANUAL",
            scope: "fleet",
            enqueued: created.count,
          }),
        },
      });
      return created;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      enqueued: jobs.count,
      correlationId,
      jobs: devices.map((d) => ({ deviceId: d.id, hostname: d.hostname })),
    },
    undefined,
    201
  );
}
