import { db } from "@/lib/db";
import { createSnapshot, type TxClient } from "@/lib/config/create-snapshot";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
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
 *   (Steps 1–5 are delegated to the shared createSnapshot() lib —
 *   src/lib/config/create-snapshot.ts — which the Task 4-b change-step
 *   executor also uses, so both paths stay byte-identical.)
 *
 * SUCCEEDED (DISCOVERY) — the bounded scan result and reconciliation summary
 *   are stored in resultJson after the worker has persisted each normalized
 *   wire observation through /worker/discovery/reconcile. A matched device is
 *   linked only by exact management IP; reverse DNS remains evidence, not
 *   identity. Candidate import remains an explicit operator action.
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
        subnet: z.string().max(64).optional(),
        vendorGuess: z.string().min(1),
        modelGuess: z.string().optional(),
        mgmtPort: z.number().int().optional(),
        openPorts: z.array(z.number().int().min(1).max(65_535)).max(4).optional(),
        protocols: z.array(z.string()).optional(),
        confidence: z.number().int().min(0).max(100).optional(),
        osFingerprint: z.string().optional(),
        discoveredAt: z.string().optional(),
      })
    )
    .min(0),
  scannedSubnets: z.number().int().nonnegative().optional(),
  scannedTargets: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  reconciliation: z.object({
    observed: z.number().int().nonnegative(),
    matchedDevices: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    lastSeenUpdated: z.number().int().nonnegative(),
  }).optional(),
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

    // ── CHANGE_EXECUTE (4-b): the change-step engine persisted all change
    // state (steps/devices/snapshots/audits) — store the outcome verbatim.
    // The JOB is SUCCEEDED even when the change outcome is FAILED; the
    // change outcome lives here + in the change rows. ──
    if (job.type === "CHANGE_EXECUTE") {
      const outcomeShape = z.object({
        outcome: z.string().max(50),
        changeStatus: z.string().max(50).nullable().optional(),
        suggestIncident: z.boolean().optional(),
        stepsTotal: z.number().int().nonnegative().optional(),
        stepsCompleted: z.number().int().nonnegative().optional(),
        failAt: z.string().nullable().optional(),
      });
      const parsedExecution = outcomeShape.safeParse(result);
      if (!parsedExecution.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED CHANGE_EXECUTE completion requires result.outcome",
          400
        );
      }
      const execution = parsedExecution.data;
      await db.$transaction([
        db.jobExecution.update({
          where: { id: job.id },
          data: {
            status: "SUCCEEDED",
            progress: 100,
            finishedAt: now,
            error: null,
            resultJson: JSON.stringify(execution),
          },
        }),
        // SAFE-003 — the execution reached its terminal state: release the
        // change's single-flight lease.
        db.changeExecutionLease.deleteMany({ where: { jobId: job.id } }),
      ]);
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: execution.outcome,
        changeStatus: execution.changeStatus ?? null,
      });
    }

    // ── ALERT_EVALUATION (5-a): the evaluate-in-Next engine persisted all
    // alert/incident/notification/audit state and returns its summary; the
    // job stores it verbatim as resultJson (Job Center shows the counts). ──
    if (job.type === "ALERT_EVALUATION") {
      const summaryShape = z.object({
        evaluatedAt: z.string().optional(),
        triggeredBy: z.string().max(40).optional(),
        rulesEvaluated: z.number().int().nonnegative().optional(),
        devicesConsidered: z.number().int().nonnegative().optional(),
        fired: z.number().int().nonnegative().optional(),
        deduped: z.number().int().nonnegative().optional(),
        reactivated: z.number().int().nonnegative().optional(),
        suppressed: z.number().int().nonnegative().optional(),
        childrenSuppressed: z.number().int().nonnegative().optional(),
        resolved: z.number().int().nonnegative().optional(),
        incidentsCreated: z.number().int().nonnegative().optional(),
        notificationsCreated: z.number().int().nonnegative().optional(),
        caps: z.record(z.string(), z.boolean()).optional(),
      });
      const parsedSummary = summaryShape.safeParse(result ?? {});
      if (!parsedSummary.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED ALERT_EVALUATION completion requires the evaluation summary object",
          400
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedSummary.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        summary: parsedSummary.data,
      });
    }

    // ── METRIC_RETENTION (6-a): the prune endpoint persisted the deletes,
    // the Setting bookkeeping and the audit — store the counts verbatim as
    // resultJson. outcome "throttled" is a graceful no-op (a manual prune
    // ran within the 60 s guard). ──
    if (job.type === "METRIC_RETENTION") {
      const retentionShape = z.object({
        outcome: z.enum(["pruned", "throttled"]),
        metricSamplesDeleted: z.number().int().nonnegative().optional(),
        rollup5MDeleted: z.number().int().nonnegative().optional(),
        rollup1HDeleted: z.number().int().nonnegative().optional(),
        rollup1DDeleted: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        reason: z.string().max(300).optional(),
      });
      const parsedRetention = retentionShape.safeParse(result);
      if (!parsedRetention.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED METRIC_RETENTION completion requires result.outcome (pruned|throttled)",
          400
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedRetention.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedRetention.data.outcome,
      });
    }

    if (job.type === "FLOW_RETENTION") {
      const flowRetentionShape = z.object({
        outcome: z.enum(["pruned", "disabled"]),
        flowRecordsDeleted: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        retentionDays: z.number().int().min(1).max(3650),
        cutoff: z.string().datetime(),
        correlationId: z.string().trim().min(1).max(120),
        triggeredBy: z.string().trim().min(1).max(40).optional(),
        prunedAt: z.string().datetime().optional(),
      }).strict();
      const parsedFlowRetention = flowRetentionShape.safeParse(result);
      if (!parsedFlowRetention.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED FLOW_RETENTION completion requires a valid prune summary",
          400,
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedFlowRetention.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedFlowRetention.data.outcome,
      });
    }

    // ── ROLLUP_AGGREGATION (RT-002): the aggregate endpoint persisted the
    // upserts + audit — store the summary verbatim as resultJson. outcome
    // "throttled" is a graceful no-op (another run was in flight). ──
    if (job.type === "ROLLUP_AGGREGATION") {
      const rollupShape = z.object({
        outcome: z.enum(["aggregated", "throttled"]),
        groupsComputed: z.number().int().nonnegative().optional(),
        groupsUpserted: z.number().int().nonnegative().optional(),
        remaining: z.number().int().nonnegative().optional(),
        bounded: z.boolean().optional(),
        byGranularity: z.record(z.string(), z.number().int().nonnegative()).optional(),
        durationMs: z.number().int().nonnegative().optional(),
        reason: z.string().max(300).optional(),
      });
      const parsedRollup = rollupShape.safeParse(result);
      if (!parsedRollup.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED ROLLUP_AGGREGATION completion requires result.outcome (aggregated|throttled)",
          400
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedRollup.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedRollup.data.outcome,
      });
    }

    // ── FIRMWARE_UPGRADE (Phase 13-b): the upgrade endpoint persisted the
    // device.firmware flip + FIRMWARE_UPGRADED audit — store the summary
    // verbatim in resultJson (Job Center shows before → after). ──
    if (job.type === "FIRMWARE_UPGRADE") {
      const upgradeShape = z.object({
        outcome: z.literal("upgraded"),
        deviceId: z.string().optional(),
        hostname: z.string().optional(),
        fromVersion: z.string().nullable().optional(),
        toVersion: z.string().optional(),
        alreadyAtTarget: z.boolean().optional(),
        upgradedAt: z.string().optional(),
      });
      const parsedUpgrade = upgradeShape.safeParse(result);
      if (!parsedUpgrade.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED FIRMWARE_UPGRADE completion requires result.outcome = \"upgraded\" and toVersion",
          400
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedUpgrade.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: "upgraded",
      });
    }

    // ── ZTP_PROVISION (Phase 14-b): the provisioning endpoint persisted the
    // Device creation + claim flip + audit — store the summary verbatim in
    // resultJson (Job Center shows the claim → device outcome). ──
    if (job.type === "ZTP_PROVISION") {
      const ztpShape = z.object({
        outcome: z.enum(["provisioned", "failed"]),
        claimId: z.string().optional(),
        serial: z.string().optional(),
        hostname: z.string().optional(),
        deviceId: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
        provisionedAt: z.string().optional(),
        alreadyResolved: z.boolean().optional(),
      });
      const parsedZtp = ztpShape.safeParse(result);
      if (!parsedZtp.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED ZTP_PROVISION completion requires result.outcome (provisioned|failed)",
          400
        );
      }
      await db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(parsedZtp.data),
        },
      });
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedZtp.data.outcome,
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

    const source =
      typeof payload.source === "string" && payload.source
        ? payload.source
        : "SCHEDULED";

    const persisted = await db.$transaction(async (tx) => {
      const snapshot = await createSnapshot(tx as unknown as TxClient, {
        deviceId,
        rawText: backupResult.rawText,
        source,
        normalizedText: backupResult.normalizedText ?? null,
        jobId: job.id,
        correlationId: job.correlationId,
        configFlavor: backupResult.configFlavor ?? null,
      }, now);
      if (!snapshot.ok) {
        return { deviceMissing: true as const };
      }

      await tx.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify({
            snapshotId: snapshot.id,
            version: snapshot.version,
            sha256: snapshot.sha256,
            sizeBytes: snapshot.sizeBytes,
            configFlavor: backupResult.configFlavor ?? null,
            source,
          }),
        },
      });

      return {
        deviceMissing: false as const,
        snapshotId: snapshot.id,
        version: snapshot.version,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.sizeBytes,
        hostname: snapshot.hostname,
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

    // SAFE-003 — terminal FAILED releases the change's execution lease;
    // a requeued retry is the SAME execution, so its lease STAYS (one
    // queued/running execution per change, retries included).
    if (!requeue) {
      await tx.changeExecutionLease.deleteMany({ where: { jobId: job.id } });
    }

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
      // Type-aware audit action: CONFIG_BACKUP failures keep the legacy
      // action; other types get a generic JOB_FAILED (the change engine
      // writes its own CHANGE_* audits, so those are excluded here).
      const action =
        job.type === "CONFIG_BACKUP"
          ? "CONFIG_BACKUP"
          : job.type === "CHANGE_EXECUTE"
            ? "CHANGE_EXECUTION_FAILED"
            : "JOB_FAILED";
      const resourceType =
        job.type === "CHANGE_EXECUTE" ? "ChangeRequest" : "ConfigSnapshot";
      await tx.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action,
          resourceType,
          resourceId: job.type === "CHANGE_EXECUTE" ? job.targetId : deviceId ?? null,
          resourceLabel:
            job.type === "CHANGE_EXECUTE"
              ? (typeof payload.changeNumber === "string" ? payload.changeNumber : job.targetId) ?? "unknown change"
              : hostname ?? "unknown device",
          result: "FAILURE",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({ error: message, attempts: job.attempts, jobType: job.type }),
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
