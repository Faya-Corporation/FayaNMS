import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { getHostKeyPin } from "@/lib/ssh/host-keys";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/claim — worker-facing atomic job claim.
 *
 * Body: { types: string[], limit: number(1..10) }
 *
 * Transaction: selects the oldest QUEUED JobExecutions whose type is in
 * `types` and whose scheduledAt is null or due, then flips each one
 * QUEUED→RUNNING with an optimistic `status: "QUEUED"` guard (updateMany),
 * incrementing attempts and stamping startedAt. The VALIDATION job seeded in
 * the DB is never touched because the worker only claims CONFIG_BACKUP.
 *
 * For CONFIG_BACKUP jobs the returned `payload` object is enriched with the
 * target device ({ deviceId, hostname, name, vendor, model, platform,
 * firmware, managementIp, status }) so the worker never needs a second
 * lookup. Raw stored payload stays available as `payloadJson`.
 *
 * CHANGE_EXECUTE jobs (Task 4-b) are enriched with the change header
 * ({ changeNumber, changeTitle, changeStatus, riskLevel }) the same way,
 * plus F-044's claim-time budget input: `stepsTotal` (the change's step
 * count) — the worker derives the driver's race budget from it
 * (src/lib/change/job-budget.ts) instead of racing a static constant.
 */

const claimSchema = z.object({
  // 13 job types are claimed (RT-002 rollup + RT-003 queue retention added
  // two) — the cap keeps one tick ahead so the runner's list always fits.
  types: z.array(z.string().trim().min(1)).min(1).max(14),
  limit: z.number().int().min(1).max(10).default(3),
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
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const { types, limit } = parsed.data;
  const now = new Date();

  const claimed = await db.$transaction(async (tx) => {
    const candidates = await tx.jobExecution.findMany({
      where: {
        status: "QUEUED",
        type: { in: types },
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: limit,
    });

    const out: Array<Record<string, unknown>> = [];

    for (const job of candidates) {
      // Optimistic flip — updateMany on a conditional where is atomic on
      // SQLite and silently returns count 0 if another claimant won.
      const flipped = await tx.jobExecution.updateMany({
        where: { id: job.id, status: "QUEUED" },
        data: {
          status: "RUNNING",
          startedAt: now,
          progress: 0,
          attempts: { increment: 1 },
        },
      });
      if (flipped.count !== 1) continue;

      let payload = safeParseJson(job.payloadJson);
      const deviceId =
        typeof payload.deviceId === "string" ? payload.deviceId : job.targetId;

      if (job.type === "CONFIG_BACKUP" && deviceId) {
        const device = await tx.device.findUnique({
          where: { id: deviceId },
          select: {
            id: true,
            hostname: true,
            displayName: true,
            vendor: { select: { key: true } },
            model: true,
            platform: true,
            firmware: true,
            mgmtIp: true,
            status: true,
            // Phase 22 slice 1 — data-plane routing + credential REFERENCE
            // fields. The secretRef is a vault POINTER (never a secret): the
            // worker resolves it against its own environment at connect time.
            dataSource: true,
            credentialProfile: { select: { username: true, port: true, secretRef: true } },
          },
        });
        if (device) {
          // SAFE-001 — the enrolled host-key pin travels with the payload;
          // an UNENROLLED live device stays pin-less and the worker refuses
          // the connection (SSH_HOSTKEY_UNENROLLED) — fail-closed.
          const sshHostKeyPin =
            device.dataSource === "LIVE_SSH" && device.credentialProfile && device.mgmtIp
              ? await getHostKeyPin(device.mgmtIp, device.credentialProfile.port)
              : null;
          payload = {
            ...payload,
            deviceId: device.id,
            hostname: device.hostname,
            name: device.displayName ?? device.hostname,
            vendor: device.vendor.key,
            model: device.model,
            platform: device.platform,
            firmware: device.firmware,
            managementIp: device.mgmtIp,
            status: device.status,
            // LIVE_SSH devices carry the credential block; SIMULATOR devices
            // keep payload.credential absent (the worker routes on dataSource).
            dataSource: device.dataSource,
            credential: device.credentialProfile
              ? {
                  username: device.credentialProfile.username,
                  port: device.credentialProfile.port,
                  secretRef: device.credentialProfile.secretRef,
                }
              : null,
            // SAFE-001: { fingerprint } | null (fail-closed when unenrolled).
            sshHostKeyPin,
          };
        }
      }

      // CHANGE_EXECUTE (Task 4-b): enrich with the change header so the
      // driver can post human-readable progress without extra lookups.
      if (job.type === "CHANGE_EXECUTE" && job.targetId) {
        const change = await tx.changeRequest.findUnique({
          where: { id: job.targetId },
          select: { number: true, title: true, riskLevel: true, status: true },
        });
        if (change) {
          // F-044 — claim-time budget input: the plan's step count, so the
          // worker derives the driver budget as
          //   min(stepsTotal, loop bound) × per-iteration cost + margin
          // (src/lib/change/job-budget.ts). The FULL plan is counted (not
          // the remaining steps) on purpose: a resumed attempt may still
          // trigger appended rollback steps, and an over-generous budget
          // can never race a live driver — an under-count could.
          const stepsTotal = await tx.changeStep.count({
            where: { changeId: job.targetId },
          });
          payload = {
            ...payload,
            changeNumber: change.number,
            changeTitle: change.title,
            changeStatus: change.status,
            riskLevel: change.riskLevel,
            stepsTotal,
          };
        }
      }

      // FIRMWARE_UPGRADE (Phase 13-b): enrich with the device header so the
      // staged upgrade can post readable progress and pre-flight the
      // OFFLINE guard without a second lookup (same pattern as CONFIG_BACKUP).
      if (job.type === "FIRMWARE_UPGRADE" && deviceId) {
        const device = await tx.device.findUnique({
          where: { id: deviceId },
          select: {
            id: true,
            hostname: true,
            displayName: true,
            vendor: { select: { key: true } },
            model: true,
            firmware: true,
            mgmtIp: true,
            status: true,
          },
        });
        if (device) {
          payload = {
            ...payload,
            deviceId: device.id,
            hostname: device.hostname,
            name: device.displayName ?? device.hostname,
            vendor: device.vendor.key,
            model: device.model,
            fromVersion: device.firmware,
            managementIp: device.mgmtIp,
            status: device.status,
          };
        }
      }

      out.push({
        id: job.id,
        type: job.type,
        targetType: job.targetType,
        targetId: job.targetId,
        payloadJson: job.payloadJson,
        payload,
        attempts: job.attempts + 1,
        maxAttempts: job.maxAttempts,
        correlationId: job.correlationId,
      });
    }

    return out;
  }, { maxWait: 5_000, timeout: 20_000 });

  // Liveness marker for GET /api/v1/worker/status: timestamp of the most
  // recent claim that actually returned at least one job.
  if (claimed.length > 0) {
    await db.setting
      .upsert({
        where: { key: "worker.lastClaimAt" },
        update: { valueJson: JSON.stringify(now.toISOString()) },
        create: {
          key: "worker.lastClaimAt",
          valueJson: JSON.stringify(now.toISOString()),
        },
      })
      .catch(() => {});
  }

  return ok(claimed);
}
