import { db } from "@/lib/db";
import { createSnapshot, type TxClient } from "@/lib/config/create-snapshot";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/complete — worker-facing job completion + persistence.
 *
 * Body: { jobId, outcome: "SUCCEEDED"|"FAILED"|"RESUMED", result?, error? }
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
 * RESUMED (F-044, wave-8: every job type) — an in-flight body that stopped
 *   being authoritative is resumable, not failed. Originally CHANGE_EXECUTE
 *   driver loss only (the plan's state lives in the change-step engine,
 *   CAS-claimed steps, SAFE-004); wave-8 F-3 generalized it to EVERY type
 *   for the worker's graceful shutdown: a drain-expired job posts RESUMED
 *   ("worker shutting down") and is requeued — QUEUED + scheduledAt
 *   backoff, progress preserved, lease kept (same-execution retry,
 *   SAFE-003) — instead of being abandoned to the reaper's terminal FAILED.
 *   Attempts remain bounded by maxAttempts: repeated resume past the cap
 *   dead-letters the job honestly — change rows untouched, recovery via
 *   the standard jobs/[id]/retry re-enqueue.
 *
 * Wave-8 F-2 — every terminal write is a CAS on the RUNNING state:
 *   `updateMany({ where: { id, status: "RUNNING" } })` and `count === 0`
 *   answers { updated: false }. The pre-reads (status/type/payload) stay —
 *   they drive snapshot creation and the audit JSON — but NO terminal state
 *   is ever written without the status guard, so a concurrent
 *   SUCCEEDED+FAILED pair (e.g. a race timeout firing while the success
 *   post is in flight, same claim epoch) can no longer flip-flop the
 *   terminal state / requeue-after-success. Audit rows and lease releases
 *   are gated on `count === 1` (they describe a transition that actually
 *   happened). In the CONFIG_BACKUP transaction the job's CAS runs AFTER
 *   the snapshot creation (the resultJson embeds the snapshot meta) — a
 *   lost race rolls the whole transaction back, so the losing completion
 *   cannot leave a duplicate snapshot behind either.
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
  outcome: z.enum(["SUCCEEDED", "FAILED", "RESUMED"]),
  // F-012 (audit A2-03): the claim epoch (JobExecution.attempts at claim
  // time — the claim route increments it). When present, a terminal for a
  // NON-current attempt is acknowledged but IGNORED: a timed-out (and
  // therefore orphaned) job body must never write a terminal over the
  // retry attempt that replaced it. Older workers that omit the field
  // keep the exact previous behavior.
  attempt: z.number().int().positive().optional(),
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

/** The late-complete acknowledgement every lost CAS answers with (F-2). */
function racedTerminalAck(jobId: string) {
  return ok({
    jobId,
    updated: false,
    reason: "job left RUNNING before the terminal write (concurrent completion)",
  });
}

/**
 * F-2 — shared terminal CAS for the SUCCEEDED branches whose persistence is
 * elsewhere (evaluate-in-Next engines / verbatim resultJson stores): the
 * terminal is written ONLY while the row is still RUNNING. Returns false
 * when a concurrent completion won the transition — the caller answers the
 * { updated: false } late-complete acknowledgement instead of writing.
 */
async function terminalSucceededCas(
  jobId: string,
  resultJson: string,
  finishedAt: Date
): Promise<boolean> {
  const cas = await db.jobExecution.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      status: "SUCCEEDED",
      progress: 100,
      finishedAt,
      error: null,
      resultJson,
    },
  });
  return cas.count === 1;
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

  const { jobId, outcome, result, error, attempt } = parsed.data;
  const now = new Date();

  const job = await db.jobExecution.findUnique({ where: { id: jobId } });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }

  // F-012 — stale-attempt guard (applies to BOTH outcome branches): a
  // completion whose claim epoch no longer matches the job's current one is
  // a post from an orphaned body (raceTimeout fired, the job was requeued
  // and re-claimed, the old body then finished late). Acknowledge with
  // { updated: false } — never crash the loop, never write the terminal.
  if (attempt !== undefined && attempt !== job.attempts) {
    return ok({
      jobId,
      updated: false,
      reason: `stale attempt ${attempt} (current ${job.attempts}) — terminal ignored`,
    });
  }

  // ── RESUMED (F-044 — driver loss is resumable, not failed; wave-8 F-3
  //    keeps the documented scope: CHANGE_EXECUTE-only. The graceful-drain
  //    path reports FAILED ("worker shutting down") for every other type —
  //    the FAILED requeue gives the same retry-when-budget-allows outcome
  //    without widening the RESUMED contract) ─────────────────────────────
  if (outcome === "RESUMED") {
    if (job.type !== "CHANGE_EXECUTE") {
      return fail(
        "INVALID_OUTCOME",
        "RESUMED is only valid for CHANGE_EXECUTE jobs (the only resumable driver)",
        400
      );
    }
    if (job.status !== "RUNNING") {
      return ok({ jobId, updated: false, reason: `job status is ${job.status}` });
    }

    const message = error ?? "driver lost mid-flight";
    const requeue = job.attempts < job.maxAttempts;
    const payload = safeParseJson(job.payloadJson);

    // F-2 — CAS: the requeue/dead-letter is written ONLY while the row is
    // still RUNNING; a concurrent terminal wins and this post degrades to
    // the late-complete acknowledgement. Audit row + lease release only on
    // a transition that actually happened (count === 1).
    const cas = await db.jobExecution.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: requeue
        ? {
            status: "QUEUED",
            // F-044 — the "resumed" label replaces the FAILED terminal:
            // the error field carries the resume note (the Job Center
            // shows the truth) and progress is PRESERVED — the
            // replacement driver re-reports it from the engine's step
            // rows on its first step call (CHANGE_EXECUTE) or re-runs the
            // probe from scratch (every other type).
            error: `resumed (attempt ${job.attempts}): ${message}`,
            scheduledAt: new Date(now.getTime() + 30_000 * job.attempts),
          }
        : {
            // Attempts exhausted on repeated driver loss: honest
            // dead-letter. The change rows were never the driver's to
            // fail — they stay untouched, so recovery is the standard
            // jobs/[id]/retry re-enqueue (the engine's CAS step claims
            // + orphan-step reaper own the rollback-or-fail decision).
            status: "FAILED",
            progress: 0,
            error: `resumed ${job.attempts}× then dead-lettered: ${message} (change state untouched — recover via job retry)`,
            finishedAt: now,
          },
    });

    if (cas.count === 0) {
      return ok({
        jobId,
        updated: false,
        reason: "job left RUNNING before the RESUMED write (concurrent completion)",
      });
    }

    // SAFE-003 — a requeued resume is the SAME execution: the lease
    // STAYS (mirrors the FAILED-requeue contract). Only the terminal
    // dead-letter releases the change's execution lease.
    if (!requeue) {
      await db.changeExecutionLease.deleteMany({ where: { jobId: job.id } });

      // Audit only the terminal (requeues stay visible via attempts /
      // scheduledAt + the resumed error label) — same rule as the FAILED
      // path, with the resumed truth in the payload. RESUMED remains
      // CHANGE_EXECUTE-only (the guard above), so the audit row is the
      // change-execution shape.
      const action = "CHANGE_EXECUTION_FAILED";
      const resourceType = "ChangeRequest";
      await db.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action,
          resourceType,
          resourceId: job.targetId,
          resourceLabel:
            (typeof payload.changeNumber === "string" ? payload.changeNumber : job.targetId) ??
            "unknown change",
          result: "FAILURE",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({
            error: `resumed ${job.attempts}× then dead-lettered: ${message}`,
            attempts: job.attempts,
            jobType: job.type,
            resumed: true,
          }),
        },
      });
    }

    return ok({
      jobId,
      updated: true,
      status: requeue ? "QUEUED" : "FAILED",
      resumed: requeue,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });
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
      // F-2 — terminal CAS (status RUNNING guard; count 0 → late-complete ack).
      const cas = await db.jobExecution.updateMany({
        where: { id: job.id, status: "RUNNING" },
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
      if (cas.count === 0) {
        return ok({
          jobId,
          updated: false,
          reason: "job left RUNNING before the terminal write (concurrent completion)",
        });
      }
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
      // F-2 — terminal CAS (status RUNNING guard; count 0 → late-complete ack).
      const cas = await db.jobExecution.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(drift),
        },
      });
      if (cas.count === 0) {
        return ok({
          jobId,
          updated: false,
          reason: "job left RUNNING before the terminal write (concurrent completion)",
        });
      }
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
      // F-2 — terminal CAS inside the transaction: the SAFE-003 lease
      // release (and the whole "reached terminal" side) only follows a
      // transition the guard actually performed.
      let changeCasCount = 0;
      await db.$transaction(async (tx) => {
        const cas = await tx.jobExecution.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: {
            status: "SUCCEEDED",
            progress: 100,
            finishedAt: now,
            error: null,
            resultJson: JSON.stringify(execution),
          },
        });
        changeCasCount = cas.count;
        // SAFE-003 — the execution reached its terminal state: release the
        // change's single-flight lease. A lost CAS (count 0) leaves the
        // lease exactly as the winner decided it.
        if (cas.count === 1) {
          await tx.changeExecutionLease.deleteMany({ where: { jobId: job.id } });
        }
      });
      if (changeCasCount === 0) {
        return ok({
          jobId,
          updated: false,
          reason: "job left RUNNING before the terminal write (concurrent completion)",
        });
      }
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedSummary.data), now))) {
        return racedTerminalAck(jobId);
      }
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedRetention.data), now))) {
        return racedTerminalAck(jobId);
      }
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedFlowRetention.data), now))) {
        return racedTerminalAck(jobId);
      }
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedRollup.data), now))) {
        return racedTerminalAck(jobId);
      }
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedRollup.data.outcome,
      });
    }

    // ── PROTOCOL_QUEUE_RETENTION (RT-003): the prune endpoint persisted the
    // deletes, the Setting bookkeeping and the audit — store the summary
    // verbatim as resultJson. outcome "throttled" is a graceful no-op (a
    // prune ran within the 60 s guard). ──
    if (job.type === "PROTOCOL_QUEUE_RETENTION") {
      const queueRetentionShape = z.object({
        outcome: z.enum(["pruned", "disabled", "throttled"]),
        queueRowsDeleted: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        deliveredDays: z.number().int().min(1).max(3650).optional(),
        deadDays: z.number().int().min(1).max(3650).optional(),
        correlationId: z.string().trim().min(1).max(120).optional(),
        triggeredBy: z.string().trim().min(1).max(40).optional(),
        prunedAt: z.string().datetime().optional(),
        reason: z.string().max(300).optional(),
      });
      const parsedQueueRetention = queueRetentionShape.safeParse(result);
      if (!parsedQueueRetention.success) {
        return fail(
          "INVALID_RESULT",
          "SUCCEEDED PROTOCOL_QUEUE_RETENTION completion requires a valid prune summary",
          400
        );
      }
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedQueueRetention.data), now))) {
        return racedTerminalAck(jobId);
      }
      return ok({
        jobId,
        updated: true,
        status: "SUCCEEDED",
        outcome: parsedQueueRetention.data.outcome,
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedUpgrade.data), now))) {
        return racedTerminalAck(jobId);
      }
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
      if (!(await terminalSucceededCas(job.id, JSON.stringify(parsedZtp.data), now))) {
        return racedTerminalAck(jobId);
      }
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
      // F-2 — the dead-letter is a CAS too (a concurrent completion wins).
      const dead = await db.jobExecution.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: now, error: "Target device missing at completion" },
      });
      if (dead.count === 0) {
        return racedTerminalAck(jobId);
      }
      return ok({ jobId, updated: true, status: "FAILED", requeued: false });
    }

    const source =
      typeof payload.source === "string" && payload.source
        ? payload.source
        : "SCHEDULED";

    // F-2 — the CONFIG_BACKUP transaction keeps createSnapshot() first (the
    // job's resultJson embeds the snapshot meta) and runs the job's terminal
    // CAS SECOND: a lost race throws the marker below and rolls the WHOLE
    // transaction back — the losing completion cannot leave a duplicate
    // snapshot (or a flip-flopped terminal) behind.
    class CompletionRaceLostError extends Error {
      constructor() {
        super("terminal CAS lost — concurrent completion won");
        this.name = "CompletionRaceLostError";
      }
    }

    const persisted = await db
      .$transaction(async (tx) => {
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
          return { racedTerminal: false as const, deviceMissing: true as const };
        }

        const cas = await tx.jobExecution.updateMany({
          where: { id: job.id, status: "RUNNING" },
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
        if (cas.count === 0) {
          throw new CompletionRaceLostError();
        }

        return {
          racedTerminal: false as const,
          deviceMissing: false as const,
          snapshotId: snapshot.id,
          version: snapshot.version,
          sha256: snapshot.sha256,
          sizeBytes: snapshot.sizeBytes,
          hostname: snapshot.hostname,
        };
      }, { maxWait: 5_000, timeout: 20_000 })
      .catch((e: unknown) => {
        if (e instanceof CompletionRaceLostError) {
          return { racedTerminal: true as const, deviceMissing: false as const };
        }
        throw e;
      });

    if (persisted.racedTerminal) {
      return racedTerminalAck(jobId);
    }

    if (persisted.deviceMissing) {
      const dead = await db.jobExecution.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: now, error: "Target device missing at completion" },
      });
      if (dead.count === 0) {
        return racedTerminalAck(jobId);
      }
      return ok({ jobId, updated: true, status: "FAILED", requeued: false });
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

  // F-2 — CAS: the requeue/dead-letter is written ONLY while the row is
  // still RUNNING. A concurrent SUCCEEDED (e.g. the timeout race where the
  // success post was still in flight — same claim epoch, so the F-012 guard
  // cannot discriminate) wins the transition and this FAILED degrades to the
  // late-complete acknowledgement: the requeue-after-success flip-flop is
  // impossible. Audit row + lease release only on a real transition.
  const cas = await db.jobExecution.updateMany({
    where: { id: job.id, status: "RUNNING" },
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

  if (cas.count === 0) {
    // Already terminal — treat as late/duplicate, never requeue after a
    // terminal state.
    return racedTerminalAck(jobId);
  }

  // SAFE-003 — terminal FAILED releases the change's execution lease;
  // a requeued retry is the SAME execution, so its lease STAYS (one
  // queued/running execution per change, retries included).
  if (!requeue) {
    await db.changeExecutionLease.deleteMany({ where: { jobId: job.id } });
  }

  // Audit only terminal failures (retries are visible via attempts/scheduledAt).
  if (!requeue) {
    let hostname: string | null = null;
    if (deviceId) {
      const dev = await db.device.findUnique({
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
    await db.auditEvent.create({
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
