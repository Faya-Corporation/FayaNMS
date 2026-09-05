import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/complete — worker-facing job completion + persistence.
 *
 * Body: { jobId, outcome: "SUCCEEDED"|"FAILED", result?, error? }
 *
 * SUCCEEDED (CONFIG_BACKUP) — single transaction:
 *   1. next per-device snapshot version = max(version)+1
 *   2. demote the device's previous CURRENT snapshot to HISTORICAL
 *   3. create ConfigSnapshot (sha256 over rawText, sizeBytes, source from
 *      payload.source ?? "SCHEDULED", status CURRENT, jobId link)
 *   4. device lastBackupAt/lastSeen = now, backupCompliance = COMPLIANT
 *   5. AuditEvent CONFIG_BACKUP (actor system:backup-worker) with the job's
 *      correlationId
 *   6. JobExecution → SUCCEEDED + resultJson
 *
 * SUCCEEDED (DISCOVERY, 2-c) — persistence-free demo pattern: the scan
 *   result ({ candidates[], scannedSubnets, durationMs }) is stored verbatim
 *   in the job's resultJson. No Device/Audit rows are written here — the
 *   import flow (POST /api/v1/discovery/import) turns candidates into real
 *   devices with their own audit trail.
 *
 * FAILED — Next.js decides retry vs dead-letter:
 *   attempts < maxAttempts → back to QUEUED with
 *   scheduledAt = now + 30s * attempts (exponential-ish backoff);
 *   otherwise terminal FAILED (dead-letter) + AuditEvent CONFIG_BACKUP
 *   FAILURE so the failed-backup story is traceable in the audit trail.
 *
 * Completes for jobs that are not RUNNING are acknowledged with
 * { updated: false } instead of erroring — a late/duplicate post from a
 * retried worker must never crash the loop.
 */

/** CONFIG_BACKUP result — snapshot text payload. */
const backupResultSchema = z.object({
  rawText: z.string(),
  normalizedText: z.string().optional(),
  configFlavor: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

/** DISCOVERY result — candidate list (persistence-free, stored verbatim). */
const discoveryResultSchema = z.object({
  candidates: z
    .array(
      z.object({
        ip: z.string().min(1),
        hostname: z.string().min(1),
        vendorGuess: z.string().min(1),
        modelGuess: z.string().optional(),
        mgmtPort: z.number().int().optional(),
        protocols: z.array(z.string()).optional(),
        confidence: z.number().int().min(0).max(100).optional(),
        osFingerprint: z.string().optional(),
        discoveredAt: z.string().optional(),
      })
    )
    .min(1),
  scannedSubnets: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/** DRIFT_CHECK result (3-c) — evaluation already persisted by
 * /worker/drift-evaluate; the outcome summary is stored verbatim. */
const driftCheckResultSchema = z.object({
  outcome: z.enum(["skipped", "no-drift", "drift"]),
  reason: z.string().max(500).optional(),
  recordId: z.string().optional(),
  baselineVersion: z.number().int().optional(),
  currentVersion: z.number().int().optional(),
  resolved: z.number().int().nonnegative().optional(),
  triggeredBy: z.string().max(50).optional(),
  stats: z
    .object({
      added: z.number().int(),
      removed: z.number().int(),
      changed: z.number().int(),
      unchanged: z.number().int(),
    })
    .optional(),
});

const completeSchema = z.object({
  jobId: z.string().trim().min(1),
  outcome: z.enum(["SUCCEEDED", "FAILED"]),
  // Shape depends on the job type and is validated per-branch below
  // (CONFIG_BACKUP keeps its original error-for-missing-rawText behavior).
  result: z.unknown().optional(),
  error: z.string().max(2000).optional(),
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const { jobId, outcome, result, error } = parsed.data;
  const now = new Date();

  const job = await db.jobExecution.findUnique({ where: { id: jobId } });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }

  // ── SUCCEEDED ────────────────────────────────────────────────────────────
  if (outcome === "SUCCEEDED") {
    if (job.status !== "RUNNING") {
      return ok({ jobId, updated: false, reason: `job status is ${job.status}` });
    }

    // ── DISCOVERY (2-c): store the scan result verbatim in resultJson ──
    if (job.type === "DISCOVERY") {
      const parsedDiscovery = discoveryResultSchema.safeParse(result);
      if (!parsedDiscovery.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED DISCOVERY completion requires result.candidates",
          400
        );
      }
      const discovery = parsedDiscovery.data;
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify({
            candidates: discovery.candidates,
            scannedSubnets: discovery.scannedSubnets ?? null,
            durationMs: discovery.durationMs ?? null,
          }),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        candidates: discovery.candidates.length,
      });
    }

    // ── DRIFT_CHECK (3-c): evaluation persisted by drift-evaluate —
    // store the outcome summary verbatim in resultJson ──
    if (job.type === "DRIFT_CHECK") {
      const parsedDrift = driftCheckResultSchema.safeParse(result);
      if (!parsedDrift.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED DRIFT_CHECK completion requires result.outcome (skipped|no-drift|drift)",
          400
        );
      }
      const drift = parsedDrift.data;
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(drift),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: drift.outcome,
      });
    }

    // ── CONFIG_BACKUP: validate the snapshot payload (unchanged behavior) ──
    const parsedBackup = backupResultSchema.safeParse(result);
    if (!parsedBackup.success) {
      return fail(
        "INVALID_RESULT",
        "SUCCEEDED completion requires result.rawText",
        400
      );
    }
    const backupResult = parsedBackup.data;

    const payload = safeParseJson(job.payloadJson);
    const deviceId =
      typeof payload.deviceId === "string" && payload.deviceId
        ? payload.deviceId
        : job.targetId;

    if (!deviceId) {
      // Device went missing between claim and completion — dead-letter the
      // job with a clear error instead of leaving it stuck in RUNNING.
      const dead = await db.jobExecution.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: now, error: "Target device missing at completion" },
      });
      return ok({ jobId, updated: true, status: dead.status, requeued: false });
    }

    const sha256 = createHash("sha256").update(backupResult.rawText).digest("hex");
    const sizeBytes = Buffer.byteLength(backupResult.rawText, "utf8");
    const source =
      typeof payload.source === "string" && payload.source
        ? payload.source
        : "SCHEDULED";

    const persisted = await db.$transaction(async (tx) => {
      const device = await tx.device.findUnique({
        where: { id: deviceId },
        select: { id: true, hostname: true },
      });
      if (!device) {
        return { deviceMissing: true as const };
      }

      const prev = await tx.configSnapshot.findFirst({
        where: { deviceId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = (prev?.version ?? 0) + 1;

      // Demote the previous CURRENT snapshot. "SUPERSEDED" is not part of the
      // schema's documented status domain (CURRENT | HISTORICAL | BASELINE),
      // so HISTORICAL is used — consistent with the seeded chains.
      await tx.configSnapshot.updateMany({
        where: { deviceId, status: "CURRENT" },
        data: { status: "HISTORICAL" },
      });

      const snapshot = await tx.configSnapshot.create({
        data: {
          deviceId,
          version,
          source,
          configType: "RUNNING",
          rawText: backupResult.rawText,
          normalizedText: backupResult.normalizedText ?? null,
          sha256,
          sizeBytes,
          jobId: job.id,
          status: "CURRENT",
        },
      });

      await tx.device.update({
        where: { id: deviceId },
        data: { lastBackupAt: now, lastSeen: now, backupCompliance: "COMPLIANT" },
      });

      await tx.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action: "CONFIG_BACKUP",
          resourceType: "ConfigSnapshot",
          resourceId: deviceId,
          resourceLabel: device.hostname,
          result: "SUCCESS",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({
            snapshotId: snapshot.id,
            version,
            sha256,
            sizeBytes,
            source,
            configFlavor: backupResult.configFlavor ?? null,
          }),
        },
      });

      await tx.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify({
            snapshotId: snapshot.id,
            version,
            sha256,
            sizeBytes,
            configFlavor: backupResult.configFlavor ?? null,
            source,
          }),
        },
      });

      return {
        deviceMissing: false as const,
        snapshotId: snapshot.id,
        version,
        sha256,
        sizeBytes,
        hostname: device.hostname,
      };
    }, { maxWait: 5_000, timeout: 20_000 });

    if (persisted.deviceMissing) {
      const dead = await db.jobExecution.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: now, error: "Target device missing at completion" },
      });
      return ok({ jobId, updated: true, status: dead.status, requeued: false });
    }

    return ok({
      jobId,
      updated: true,
      status: "SUCCEEDED",
      snapshotId: persisted.snapshotId,
      version: persisted.version,
      sha256: persisted.sha256,
      sizeBytes: persisted.sizeBytes,
      device: persisted.hostname,
    });
  }

  // ── FAILED ───────────────────────────────────────────────────────────────
  if (job.status !== "RUNNING") {
    return ok({ jobId, updated: false, reason: `job status is ${job.status}` });
  }

  const message = error ?? "Unknown worker error";
  const requeue = job.attempts < job.maxAttempts;
  const payload = safeParseJson(job.payloadJson);
  const deviceId =
    typeof payload.deviceId === "string" && payload.deviceId
      ? payload.deviceId
      : job.targetId;

  await db.$transaction(async (tx) => {
    await tx.jobExecution.update({
      where: { id: job.id },
      data: requeue
        ? {
            status: "QUEUED",
            progress: 0,
            error: message,
            scheduledAt: new Date(now.getTime() + 30_000 * job.attempts),
          }
        : {
            status: "FAILED",
            progress: 0,
            error: message,
            finishedAt: now,
          },
    });

    // Audit only terminal failures (retries are visible via attempts/scheduledAt).
    if (!requeue) {
      let hostname: string | null = null;
      if (deviceId) {
        const dev = await tx.device.findUnique({
          where: { id: deviceId },
          select: { hostname: true },
        });
        hostname = dev?.hostname ?? null;
      }
      await tx.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action: "CONFIG_BACKUP",
          resourceType: "ConfigSnapshot",
          resourceId: deviceId ?? null,
          resourceLabel: hostname ?? "unknown device",
          result: "FAILURE",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({ error: message, attempts: job.attempts }),
        },
      });
    }
  });

  return ok({
    jobId,
    updated: true,
    status: requeue ? "QUEUED" : "FAILED",
    requeue,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    ...(requeue
      ? { nextScheduledAt: new Date(now.getTime() + 30_000 * job.attempts).toISOString() }
      : {}),
  });
}
