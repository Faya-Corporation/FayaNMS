import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok, requestContext } from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { isValidTargetVersion } from "@/lib/firmware/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/firmware/upgrade — guarded firmware-upgrade enqueue
 * (Phase 13-b). Body: { deviceId, targetVersion }.
 *
 * Guards, in order:
 *   404 DEVICE_NOT_FOUND        — unknown device
 *   409 DEVICE_UNMANAGED        — UNMANAGED devices are never touched
 *                                 (same eligibility rule as backup_now)
 *   409 DEVICE_OFFLINE          — nothing can be staged on an unreachable box
 *   409 ALREADY_AT_TARGET       — the device already runs the target version
 *   422 INVALID_TARGET_VERSION  — target fails the vendor-family version
 *                                 format (src/lib/firmware/lifecycle.ts)
 *   409 UPGRADE_IN_PROGRESS     — a FIRMWARE_UPGRADE job for this device is
 *                                 already QUEUED or RUNNING
 *
 * On success it enqueues exactly one FIRMWARE_UPGRADE JobExecution through
 * the same mechanism POST /api/v1/devices/bulk uses for CONFIG_BACKUP
 * (QUEUED row + correlationId + FIRMWARE_UPGRADE_QUEUED audit in one
 * transaction); the worker picks it up on its next claim (types list now
 * includes FIRMWARE_UPGRADE) and the actual device mutation happens
 * Next-side in /api/v1/worker/firmware-upgrade when the simulated stages
 * finish. Returns ok({ jobId, correlationId }).
 */

const upgradeSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  targetVersion: z.string().trim().min(1).max(32),
});

export async function POST(request: Request) {
  const ctx = requestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
  }

  const parsed = upgradeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
  }
  const { deviceId, targetVersion } = parsed.data;

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      firmware: true,
      status: true,
      vendor: { select: { key: true, name: true } },
    },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The device does not exist", 404, ctx);
  }
  if (device.status === "UNMANAGED") {
    return fail(
      "DEVICE_UNMANAGED",
      `${device.hostname} is UNMANAGED — firmware upgrades are only queued for managed devices`,
      409,
      ctx
    );
  }
  if (device.status === "OFFLINE") {
    return fail(
      "DEVICE_OFFLINE",
      `${device.hostname} is OFFLINE — the upgrade cannot be staged until it is reachable`,
      409,
      ctx
    );
  }
  if (device.firmware === targetVersion) {
    return fail(
      "ALREADY_AT_TARGET",
      `${device.hostname} already runs ${targetVersion}`,
      409,
      ctx
    );
  }
  if (!isValidTargetVersion(device.vendor.key, device.firmware, targetVersion)) {
    return fail(
      "INVALID_TARGET_VERSION",
      `Target "${targetVersion}" does not match the ${device.vendor.name} firmware version format`,
      422,
      ctx
    );
  }

  const openJob = await db.jobExecution.findFirst({
    where: {
      type: "FIRMWARE_UPGRADE",
      targetType: "DEVICE",
      targetId: device.id,
      status: { in: ["QUEUED", "RUNNING"] },
    },
    select: { id: true, correlationId: true },
  });
  if (openJob) {
    return fail(
      "UPGRADE_IN_PROGRESS",
      `${device.hostname} already has a firmware upgrade in progress (${openJob.correlationId})`,
      409,
      ctx
    );
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }
  const actorName = actor?.name ?? "Admin";
  const correlationId = newJobCorrelationId();

  const [job] = await db.$transaction(
    async (tx) => {
      const created = await tx.jobExecution.create({
        data: {
          type: "FIRMWARE_UPGRADE",
          targetType: "DEVICE",
          targetId: device.id,
          status: "QUEUED",
          progress: 0,
          priority: 5,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            deviceId: device.id,
            targetVersion,
          }),
          correlationId,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor?.id,
          actorName,
          action: "FIRMWARE_UPGRADE_QUEUED",
          resourceType: "Device",
          resourceId: device.id,
          resourceLabel: device.hostname,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            deviceId: device.id,
            firmware: device.firmware,
          }),
          afterJson: JSON.stringify({ targetVersion }),
        },
      });

      return [created];
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      jobId: job.id,
      correlationId,
      deviceId: device.id,
      hostname: device.hostname,
      fromVersion: device.firmware,
      targetVersion,
      type: "FIRMWARE_UPGRADE",
      status: "QUEUED",
    },
    { actor: actorName },
    200,
    ctx
  );
}
