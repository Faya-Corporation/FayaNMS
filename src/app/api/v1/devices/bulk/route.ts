import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/bulk — bulk device actions.
 * Body: { action: "backup_now", deviceIds: string[] } (1..100 ids).
 *
 * Enqueues one CONFIG_BACKUP JobExecution per eligible device (each with its
 * own correlationId), skips UNMANAGED devices, writes CONFIG_BACKUP_QUEUED
 * audit events and returns the created jobs + skip report.
 *
 * RT-012 / F-014: jobs + audit rows are written per-device inside one
 * interactive transaction so every audit row is stamped into the hash chain
 * by the db extension at creation (createMany would bypass the stamp and
 * leave unhashed rows behind; the extension now refuses that verb).
 *
 * F-031 (site scoping — device-domain wave 7): the target devices are
 * fetched in ONE findMany composed through the scope —
 * `scopedDeviceWhere(sessionScopeFor(request), { id: { in: … } })` — so a
 * device hidden from the caller's site scope is indistinguishable from a
 * missing one: it lands in the SAME notFound bucket (`reason:
 * "NOT_FOUND"`, no hostname, no out-of-scope detail) and NEVER reaches the
 * eligible queue loop (no JobExecution, no CONFIG_BACKUP_QUEUED audit row).
 * The whole request is NOT 403'd — the per-id batch keeps its per-id
 * report. Wildcard sessions resolve the base where by identity, so their
 * bucket shape is byte-unchanged. authorization-matrix.md §5.1.
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

  // F-031 wave-7: ONE scoped findMany — the scope filter composes through
  // scopedDeviceWhere (wildcard → base where identity; sites mode →
  // `site.code IN (…)`), so out-of-scope ids are absent from the result
  // and fall into the SAME notFound bucket as missing ids (leak-free).
  const devices = await db.device.findMany({
    where: scopedDeviceWhere(await sessionScopeFor(request), {
      id: { in: uniqueIds },
    }),
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

  // RT-012 / F-014: the audit hash-chain extension (src/lib/db.ts) stamps
  // ONLY per-row `auditEvent.create` — a batched `createMany` would write
  // CONFIG_BACKUP_QUEUED rows with null hash/prevHash (outside the link
  // graph, mutable, verify verdict degraded). Each job + its audit row are
  // therefore written per-device inside ONE interactive transaction; every
  // audit row is born hash-chained (and inherits the extension's P2002
  // tail-conflict retry). ≤ 100 rows per call keeps the transaction well
  // inside the route budget.
  const jobs = await db.$transaction(
    async (tx) => {
      const created: Array<{ id: string }> = [];
      for (const [index, device] of eligible.entries()) {
        const job = await tx.jobExecution.create({
          data: {
            type: "CONFIG_BACKUP",
            targetType: "DEVICE",
            targetId: device.id,
            status: "QUEUED",
            progress: 0,
            priority: 5,
            maxAttempts: 3,
            payloadJson: JSON.stringify({ deviceId: device.id }),
            correlationId: correlationIds[index],
          },
        });
        created.push(job);
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Unknown user",
            action: "CONFIG_BACKUP_QUEUED",
            resourceType: "Device",
            resourceId: device.id,
            resourceLabel: device.hostname,
            result: "SUCCESS",
            correlationId: correlationIds[index],
          },
        });
      }
      return created;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      queued: jobs.length,
      // Echo the queue entries explicitly (stable response contract).
      jobs: eligible.map((device, index) => ({
        deviceId: device.id,
        hostname: device.hostname,
        type: "CONFIG_BACKUP",
        status: "QUEUED",
        correlationId: correlationIds[index],
      })),
      skipped,
    },
    { requested: uniqueIds.length, auditEvents: jobs.length }
  );
}
