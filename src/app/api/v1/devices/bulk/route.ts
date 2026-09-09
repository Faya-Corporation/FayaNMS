import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/bulk — bulk device actions.
 * Body: { action: "backup_now", deviceIds: string[] } (1..100 ids).
 *
 * Enqueues one CONFIG_BACKUP JobExecution per eligible device (each with its
 * own correlationId), skips UNMANAGED devices, writes CONFIG_BACKUP_QUEUED
 * audit events and returns the created jobs + skip report.
 */

const bulkSchema = z.object({
  action: z.literal("backup_now"),
  deviceIds: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "At least one device is required")
    .max(100, "Bulk actions are capped at 100 devices"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { deviceIds } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): bulk device actions require the
  // "device.write" permission; the audit rows are attributed to the session
  // principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  // De-duplicate while preserving order.
  const uniqueIds = Array.from(new Set(deviceIds));

  const devices = await db.device.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, hostname: true, status: true },
  });

  const foundIds = new Set(devices.map((device) => device.id));
  const notFound = uniqueIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ deviceId: id, reason: "NOT_FOUND" }));

  const eligible = devices.filter((device) => device.status !== "UNMANAGED");
  const skipped = [
    ...notFound,
    ...devices
      .filter((device) => device.status === "UNMANAGED")
      .map((device) => ({ deviceId: device.id, hostname: device.hostname, reason: "UNMANAGED" })),
  ];

  if (eligible.length === 0) {
    return ok({ queued: 0, jobs: [], skipped }, { message: "No eligible devices to back up" });
  }

  const correlationIds = eligible.map(() => newJobCorrelationId());

  const [jobs, auditCount] = await db.$transaction([
    db.jobExecution.createMany({
      data: eligible.map((device, index) => ({
        type: "CONFIG_BACKUP",
        targetType: "DEVICE",
        targetId: device.id,
        status: "QUEUED",
        progress: 0,
        priority: 5,
        maxAttempts: 3,
        payloadJson: JSON.stringify({ deviceId: device.id }),
        correlationId: correlationIds[index],
      })),
    }),
    db.auditEvent.createMany({
      data: eligible.map((device, index) => ({
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "CONFIG_BACKUP_QUEUED",
        resourceType: "Device",
        resourceId: device.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId: correlationIds[index],
      })),
    }),
  ]);

  return ok(
    {
      queued: jobs.count,
      // createMany does not return rows — echo the queue entries explicitly.
      jobs: eligible.map((device, index) => ({
        deviceId: device.id,
        hostname: device.hostname,
        type: "CONFIG_BACKUP",
        status: "QUEUED",
        correlationId: correlationIds[index],
      })),
      skipped,
    },
    { requested: uniqueIds.length, auditEvents: auditCount.count }
  );
}
