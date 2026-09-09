import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { isValidTargetVersion } from "@/lib/firmware/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/firmware-upgrade — firmware upgrade persistence
 * service (Phase 13-b). Evaluate-in-Next completion endpoint, called BY the
 * worker mini-service after it has walked the simulated upgrade stages
 * (image download → staging → activation → post-check); the worker never
 * opens SQLite. All the state mutation lives here:
 *
 *   1. Resolve the job (must exist, be a RUNNING FIRMWARE_UPGRADE job) and
 *      the target device from its payload ({ deviceId, targetVersion } —
 *      enriched at claim time with the device header).
 *   2. Validate the target version against the device family's
 *      vendor-appropriate format (src/lib/firmware/lifecycle.ts — the same
 *      matrix POST /api/v1/firmware/upgrade validates against at enqueue).
 *      OFFLINE devices are rejected (the worker pre-flights the same check).
 *   3. Idempotency: when the device already reports the target version the
 *      call answers { alreadyAtTarget: true } without re-writing or
 *      re-auditing — a retried attempt after a partial run cannot duplicate
 *      audit rows.
 *   4. Otherwise, in one transaction: device.firmware = targetVersion and
 *      an AuditEvent FIRMWARE_UPGRADED (actor system:firmware-worker) with
 *      beforeJson/afterJson carrying the before/after versions and the job
 *      correlationId — the same hash-chained audit path as every route.
 *
 * The job row itself is NOT touched here — the worker's regular
 * /worker/complete call marks it SUCCEEDED with the returned summary.
 */

const upgradeSchema = z.object({
  jobId: z.string().trim().min(1),
});

function safeParseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request);
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = upgradeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const job = await db.jobExecution.findUnique({
    where: { id: parsed.data.jobId },
    select: {
      id: true,
      type: true,
      status: true,
      targetId: true,
      payloadJson: true,
      correlationId: true,
    },
  });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }
  if (job.type !== "FIRMWARE_UPGRADE") {
    return fail(
      "INVALID_JOB_TYPE",
      `firmware-upgrade expects a FIRMWARE_UPGRADE job (received ${job.type})`,
      400
    );
  }
  if (job.status !== "RUNNING") {
    return fail(
      "JOB_NOT_RUNNING",
      `firmware-upgrade requires a RUNNING job (status is ${job.status})`,
      409
    );
  }

  const payload = safeParseJson(job.payloadJson);
  const deviceId =
    typeof payload.deviceId === "string" && payload.deviceId
      ? payload.deviceId
      : job.targetId;
  const targetVersion =
    typeof payload.targetVersion === "string" ? payload.targetVersion.trim() : "";

  if (!deviceId || !targetVersion) {
    return fail(
      "INVALID_PAYLOAD",
      "FIRMWARE_UPGRADE job payload carries no deviceId/targetVersion",
      400
    );
  }

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      vendor: { select: { key: true } },
      firmware: true,
      status: true,
    },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The target device no longer exists", 404);
  }

  if (device.status === "OFFLINE") {
    return fail(
      "DEVICE_OFFLINE",
      `Device ${device.hostname} is OFFLINE — firmware upgrade aborted`,
      409
    );
  }

  const vendorKey = device.vendor?.key ?? "generic";
  if (!isValidTargetVersion(vendorKey, device.firmware, targetVersion)) {
    return fail(
      "INVALID_TARGET_VERSION",
      `Target version "${targetVersion}" does not match the ${vendorKey} firmware version format`,
      422
    );
  }

  // Idempotent answer for a retried attempt landing on an already-upgraded
  // device — no re-write, no duplicate audit row.
  if (device.firmware === targetVersion) {
    return ok({
      deviceId: device.id,
      hostname: device.hostname,
      fromVersion: device.firmware,
      toVersion: targetVersion,
      alreadyAtTarget: true,
      correlationId: job.correlationId,
    });
  }

  const fromVersion = device.firmware;
  const upgradedAt = new Date();

  await db.$transaction(
    async (tx) => {
      await tx.device.update({
        where: { id: device.id },
        data: { firmware: targetVersion },
      });

      await tx.auditEvent.create({
        data: {
          actorName: "system:firmware-worker",
          action: "FIRMWARE_UPGRADED",
          resourceType: "Device",
          resourceId: device.id,
          resourceLabel: device.hostname,
          result: "SUCCESS",
          correlationId: job.correlationId,
          beforeJson: JSON.stringify({
            deviceId: device.id,
            firmware: fromVersion,
          }),
          afterJson: JSON.stringify({
            deviceId: device.id,
            firmware: targetVersion,
          }),
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok({
    deviceId: device.id,
    hostname: device.hostname,
    fromVersion,
    toVersion: targetVersion,
    alreadyAtTarget: false,
    upgradedAt: upgradedAt.toISOString(),
    correlationId: job.correlationId,
  });
}
