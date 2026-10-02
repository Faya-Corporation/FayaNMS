/**
 * FayaNMS worker — job runner.
 *
 * Every 3 s the runner claims QUEUED JobExecutions from the Next.js API
 * (POST /api/v1/worker/claim), executes them with a concurrency cap of 3 and
 * a per-job timeout of 30 s, and reports progress/completion back over HTTP.
 * Task 10-a hardening: the claim loop is self-scheduling and immortal (the
 * next tick is always scheduled), backs off exponentially on claim failures
 * (3 s → 5 min cap) and auto-recovers with a greppable log line.
 * The runner is a pure orchestration/probe engine — no DB access.
 *
 * CONFIG_BACKUP step sequence (progress reported via /api/v1/worker/progress):
 *   5%  resolving device            15% connect (via self POST /simulate/connect)
 *   40–85% generate config (1–2 s simulated work, 1–2 progress posts)
 *   then POST /api/v1/worker/complete with the raw/normalized config text.
 *
 * DISCOVERY step sequence:
 *   enumerate an explicitly bounded IPv4 target set, probe approved TCP
 *   management ports, and perform reverse DNS only for reachable targets;
 *   report bounded wire-derived candidates to /worker/complete. No vendor,
 *   SNMP identity, or credential claim is made by this unauthenticated scan.
 *
 * DRIFT_CHECK branch (roadmap 3-c) — minimal: POST
 * /api/v1/worker/drift-evaluate { jobId } (the evaluation service runs
 * server-side, comparing baseline vs CURRENT snapshots), 2 progress posts,
 * then complete SUCCEEDED with { outcome: skipped|no-drift|drift, ... }.
 * Network errors propagate to the generic failure path (requeue/backoff).
 *
 * CHANGE_EXECUTE branch (Task 4-b) — the worker DRIVES the change step
 * executor: loop POST /api/v1/worker/change-step { jobId } (the Next.js
 * side executes exactly one ChangeStep per call — pre-checks, pre/post
 * backups, apply, validate, auto-rollback), reporting progress between
 * steps (completed/total steps + last step name/status). The loop stops
 * when the response answers done:true — the job completes SUCCEEDED even
 * when the CHANGE outcome is FAILED/ROLLBACK_FAILED (the job ran fine;
 * the change outcome lives in resultJson { outcome, changeStatus,
 * suggestIncident }). Per-call 409 STEP_IN_FLIGHT and network/5xx errors
 * propagate to the retryable failure path (existing backoff).
 *
 * F-044 (budget arithmetic): the driver's race budget is DERIVED at claim
 * time from the plan's own size — min(stepsTotal, loop bound) × (per-step
 * HTTP budget + progress post + inter-step beat) + margin — via
 * src/lib/change/job-budget.ts (the claim route enriches the payload with
 * stepsTotal; a legacy/absent value falls back to the full loop bound).
 * The static 600 s budget that could race a slow-but-healthy plan is gone.
 * When the budget DOES fire (driver loss mid-flight), the job is reported
 * RESUMED — requeued with a "resumed" label, never labeled FAILED — since
 * the engine's CAS step claims (SAFE-004) make the replacement attempt's
 * re-entry at the next PENDING step safe.
 *
 * ALERT_EVALUATION branch (Task 5-a) — evaluate-in-Next like DRIFT_CHECK:
 * POST /api/v1/alerts/evaluate { jobId } runs the whole threshold engine
 * server-side and answers a summary; the worker reports progress and
 * completes SUCCEEDED with the summary as resultJson (counts: evaluated/
 * fired/deduped/suppressed/resolved/incidentsCreated/notificationsCreated).
 * Network errors propagate to the generic failure path (requeue/backoff).
 *
 * METRIC_RETENTION branch (Task 6-a) — evaluate-in-Next like ALERT_EVALUATION:
 * POST /api/v1/metrics/retention/prune { triggeredBy: "SCHEDULE" } runs the
 * retention policy server-side (the worker NEVER opens SQLite) and answers
 * the deleted-row counts; the job completes SUCCEEDED with those counts as
 * resultJson. A 429 PRUNE_THROTTLED answer (operator ran a manual prune
 * within the 60 s guard) is a graceful no-op: the job still completes
 * SUCCEEDED with { outcome: "throttled" } so it never dead-letters.
 *
 * FIRMWARE_UPGRADE branch (Phase 13-b) — evaluate-in-Next like DRIFT_CHECK:
 * the worker walks the four simulated stages (image download → staging →
 * activation → post-check) reporting progress between them, then POSTs
 * /api/v1/worker/firmware-upgrade { jobId } — the Next.js endpoint flips
 * device.firmware to the target version and writes the FIRMWARE_UPGRADED
 * audit (before/after versions, job correlationId). The worker then posts
 * the regular /worker/complete SUCCEEDED with the returned summary. An
 * OFFLINE device (payload.status) or an invalid target format aborts via
 * the generic failure path (requeue/backoff). Idempotent in-Next: a device
 * already at the target answers alreadyAtTarget and the job still succeeds.
 *
 * REPORT_RUN branch (Task 9-a) — evaluate-in-Next with IN-NEXT COMPLETION:
 * POST /api/v1/reports/execute { jobId } generates the report artifact
 * (src/lib/reports/generate.ts) AND persists the completion server-side —
 * the endpoint itself flips the job SUCCEEDED with the artifact in
 * resultJson, stamps ReportSchedule.lastRunAt and writes the
 * REPORT_GENERATED audit. The worker therefore does NOT post
 * /worker/complete on the success path (a late post would answer
 * { updated: false } harmlessly); it only reports progress and logs.
 * Network/5xx errors propagate to the generic failure path
 * (requeue/backoff) as usual.
 *
 * ZTP_PROVISION branch (Phase 14-b) — evaluate-in-Next like FIRMWARE_UPGRADE:
 * the worker walks the four simulated stages (claim validation → template
 * render → config push → device registration) reporting progress between
 * them, then POSTs /api/v1/worker/ztp-provision { jobId } — the Next.js
 * endpoint creates the Device from the claim, flips the claim to
 * provisioned (or failed), writes the ZTP_PROVISIONED audit and stores the
 * rendered bootstrap config as the device's first snapshot. The worker then
 * posts the regular /worker/complete SUCCEEDED with the returned summary.
 * The job payload is { claimId, serial, hostname, vendorKey, model,
 * templateId } written by POST /api/v1/ztp/claims at enqueue time.
 *
 * Failure semantics live on the Next.js side: complete(FAILED) either requeues
 * with exponential-ish backoff (30 s * attempts) or dead-letters the job.
 * Any single job failure is contained — the loop never crashes.
 */

import { sleep, randInt, type DeviceTarget } from "./adapters";
import {
  parseHostKeyPin,
  parseTargetCredential,
  resolveAdapter,
} from "./adapter-router";
import { nextPost, selfPost, log } from "./next-client";
import {
  scanDiscoverySubnet,
  enumerateDiscoveryTargets,
  MAX_DISCOVERY_TARGETS,
  type DiscoveryCandidate,
} from "./discovery";
import { normalizeDiscoveryPolicyConfig } from "../../src/lib/discovery/policy";
import { pollSnmpV3, type SnmpV3PollProfileReference } from "./snmpv3-poller";
import {
  CHANGE_INTER_STEP_SLEEP_MAX_MS,
  CHANGE_INTER_STEP_SLEEP_MIN_MS,
  CHANGE_MAX_STEP_CALLS,
  CHANGE_STEP_CALL_TIMEOUT_MS,
  JobTimeoutError,
  deriveChangeJobBudgetMs,
} from "../../src/lib/change/job-budget";

const CLAIM_INTERVAL_MS = 3_000;
/** Claim-loop exponential backoff cap (Task 10-a) — 5 minutes. */
const MAX_BACKOFF_MS = 300_000;
const CONCURRENCY_CAP = 3;
const CLAIM_BATCH = 3;
const JOB_TIMEOUT_MS = 30_000;
// F-044: the CHANGE_EXECUTE budget is DERIVED at claim time (see
// executeJob + src/lib/change/job-budget.ts) — the static 600_000 race
// against a 40 × 90 s step loop is gone. The loop bound (40) and the
// per-step HTTP budget (90 s) live next to that arithmetic so the math
// and the driver cannot drift apart.

export interface ClaimedJob {
  id: string;
  type: string;
  targetType?: string | null;
  targetId?: string | null;
  correlationId: string;
  attempts: number;
  maxAttempts: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Response shape of POST /api/v1/worker/firmware-upgrade. */
interface FirmwareUpgradeResponse {
  deviceId: string;
  hostname: string;
  fromVersion: string | null;
  toVersion: string;
  alreadyAtTarget?: boolean;
  upgradedAt?: string;
  correlationId: string;
}

/** Response shape of POST /api/v1/worker/ztp-provision. */
interface ZtpProvisionResponse {
  outcome: "provisioned" | "failed";
  claimId: string;
  serial: string;
  hostname: string;
  deviceId?: string;
  reason?: string;
  provisionedAt?: string;
  correlationId: string;
}

interface ChangeStepResponse {
  done: boolean;
  outcome?: string | null;
  changeStatus?: string | null;
  suggestIncident?: boolean;
  stepsTotal?: number;
  stepsCompleted?: number;
  message?: string;
  lastStep?: {
    order: number;
    name: string;
    type: string;
    status: string;
  } | null;
}

const counters = {
  claimed: 0,
  completed: 0,
  failed: 0,
  resumed: 0,
  running: 0,
  completedByType: {} as Record<string, number>,
  // Task 10-a resilience observability (exposed via /health):
  consecutiveClaimFailures: 0,
  lastClaimAttemptAt: null as string | null,
  lastClaimOkAt: null as string | null,
  currentBackoffMs: CLAIM_INTERVAL_MS,
};

export function getCounters() {
  return { ...counters };
}

/**
 * Bounded promise race: rejects with a typed JobTimeoutError after `ms`
 * (F-044: the change driver's catch classifies on the TYPE — a budget
 * exhaustion is driver loss, reported resumable instead of failed).
 * The message keeps the historical `${label} timed out after ${ms} ms` shape.
 */
function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function reportProgress(jobId: string, progress: number, message: string) {
  try {
    await nextPost("/api/v1/worker/progress", { jobId, progress, message }, 8_000);
  } catch (e) {
    await log(`progress post failed for ${jobId} @${progress}%: ${(e as Error).message}`);
  }
}

/**
 * F-012 (audit A2-03) — every completion post carries the claim epoch
 * (JobExecution.attempts AT CLAIM TIME — the claim route increments it) so
 * the app can IGNORE a terminal from an orphaned body: when raceTimeout
 * fires the body keeps running while the job is retried; a late SUCCEEDED
 * from the old body must never overwrite the replacement attempt's state
 * (see the stale-attempt guard in /api/v1/worker/complete).
 */
function completePost(
  job: Pick<ClaimedJob, "id" | "attempts">,
  payload: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<unknown> {
  return nextPost(
    "/api/v1/worker/complete",
    { attempt: job.attempts, ...payload },
    timeoutMs
  );
}

async function reportFailure(
  job: Pick<ClaimedJob, "id" | "attempts" | "correlationId">,
  message: string
) {
  counters.failed += 1;
  try {
    await completePost(job, { jobId: job.id, outcome: "FAILED", error: message }, 10_000);
    await log(`job ${job.id} [${job.correlationId}] FAILED: ${message}`);
  } catch (e) {
    await log(`complete(FAILED) post failed for ${job.id}: ${(e as Error).message}`);
  }
}

/**
 * F-044 — in-flight driver loss is RESUMABLE, not FAILED. When the change
 * driver outruns its own (claim-derived) budget the BODY stops being
 * authoritative, but the plan's state never was the body's: every step is
 * CAS-claimed per call (SAFE-004) and the engine owns all change rows, so
 * a replacement attempt re-enters at the next PENDING step. The job is
 * therefore requeued with a "resumed" label instead of a FAILED terminal —
 * the complete route's RESUMED branch owns the DB semantics (execution
 * lease stays, attempts remain bounded by maxAttempts).
 */
async function reportResumed(
  job: Pick<ClaimedJob, "id" | "attempts" | "correlationId">,
  message: string
) {
  counters.resumed += 1;
  try {
    await completePost(job, { jobId: job.id, outcome: "RESUMED", error: message }, 10_000);
    await log(`job ${job.id} [${job.correlationId}] RESUMED (driver loss): ${message}`);
  } catch (e) {
    await log(`complete(RESUMED) post failed for ${job.id}: ${(e as Error).message}`);
  }
}

/** CONFIG_BACKUP execution — throws on timeout/unreachable target. */
async function runBackupJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const target: DeviceTarget = {
    deviceId: String(payload.deviceId ?? job.targetId ?? ""),
    hostname: String(payload.hostname ?? payload.name ?? "unknown"),
    name: typeof payload.name === "string" ? payload.name : undefined,
    vendor: String(payload.vendor ?? "generic"),
    model: (payload.model as string) ?? null,
    platform: (payload.platform as string) ?? null,
    firmware: (payload.firmware as string) ?? null,
    managementIp: (payload.managementIp as string) ?? null,
    status: (payload.status as string) ?? null,
    // Phase 22 slice 1 — data-plane routing (claim enrichment supplies it).
    dataSource:
      typeof payload.dataSource === "string" && payload.dataSource.trim()
        ? payload.dataSource.trim().toUpperCase()
        : "SIMULATOR",
  };
  // Parsed BEFORE the OFFLINE guard: a LIVE_SSH device with a broken
  // credential block must fail fast with the typed error, not as a generic
  // OFFLINE failure. Throws → the generic failure path (requeue/backoff).
  const credential = parseTargetCredential(payload.credential ?? null);

  if (!target.deviceId || target.deviceId === "null" || !payload.hostname) {
    throw new Error(
      "Unclaimable target: CONFIG_BACKUP payload carries no resolvable device (deviceId/hostname missing)"
    );
  }

  await reportProgress(job.id, 5, `Resolving device ${target.hostname} (${target.managementIp ?? "?"})`);

  if ((target.status ?? "").toUpperCase() === "OFFLINE") {
    // Realism: unreachable device — matches the seeded HQ-IDF-SW-01 failure story.
    throw new Error("SSH connection timed out after 30 s (device state: OFFLINE)");
  }

  // SAFE-001 — the claim enrichment carries the enrolled host-key pin for
  // live devices ({ fingerprint } | absent). Parsed (and validated) here so
  // a malformed pin fails the job typed instead of reaching any device;
  // an ABSENT pin fails closed inside resolveAdapter (SSH_HOSTKEY_UNENROLLED).
  const hostKeyPin = parseHostKeyPin(payload.sshHostKeyPin ?? null);
  const adapter = await resolveAdapter(target, credential, { hostKeyPin });
  const isLive = (target.dataSource ?? "SIMULATOR") === "LIVE_SSH";

  if (isLive) {
    // ── LIVE plane (Phase 22 slice 1): real SSH, read-only ──
    // No artificial sleeps: the progress posts bracket the REAL connect
    // and the REAL exec round-trip. The adapter is exec-only with a
    // read-only show-command allowlist; apply/restore stay simulator-only.
    const conn = await adapter.connect(target);
    await reportProgress(
      job.id,
      40,
      `Connected over real SSH to ${target.hostname} in ${conn.latencyMs} ms (${adapter.adapter})`
    );
    const cfg = await adapter.fetchConfig(target);
    await reportProgress(
      job.id,
      85,
      `Running-config collected via SSH exec (read-only, flavor ${adapter.configFlavor})`
    );
    const bytes = new TextEncoder().encode(cfg.rawText).length;

    await completePost(
      job,
      {
        jobId: job.id,
        outcome: "SUCCEEDED",
        result: {
          rawText: cfg.rawText,
          normalizedText: cfg.normalizedText,
          configFlavor: adapter.configFlavor,
          bytes,
          dataSource: "LIVE_SSH",
        },
      },
      15_000
    );

    counters.completed += 1;
    counters.completedByType.CONFIG_BACKUP =
      (counters.completedByType.CONFIG_BACKUP ?? 0) + 1;
    await log(
      `job ${job.id} [${job.correlationId}] SUCCEEDED (LIVE_SSH): ${target.hostname} bytes=${bytes} flavor=${adapter.configFlavor} connectMs=${conn.latencyMs}`
    );
    return;
  }

  // ── SIMULATOR plane (unchanged path) ──
  // Connect step goes through the worker's own /simulate/connect endpoint
  // (spec step sequence) — same adapter code path the test-connection flow uses.
  const sim = (await selfPost("/simulate/connect", {
    vendor: target.vendor,
    host: target.managementIp ?? target.hostname,
    hostname: target.hostname,
    dataSource: target.dataSource,
  })) as { latencyMs?: number; negotiated?: string };

  await reportProgress(
    job.id,
    15,
    `Connected to ${target.hostname} via ${sim.negotiated ?? "ssh2"} in ${sim.latencyMs ?? "?"} ms`
  );

  const workMs = randInt(1_000, 2_000);
  await reportProgress(
    job.id,
    40,
    `Reading running-config from ${target.hostname} (flavor ${adapter.configFlavor})`
  );
  await sleep(Math.floor(workMs / 2));
  await reportProgress(
    job.id,
    randInt(70, 85),
    `Parsing ${adapter.configFlavor} configuration blocks`
  );
  await sleep(workMs - Math.floor(workMs / 2));

  const cfg = await adapter.fetchConfig(target);
  const bytes = new TextEncoder().encode(cfg.rawText).length;

  await completePost(
    job,
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        rawText: cfg.rawText,
        normalizedText: cfg.normalizedText,
        configFlavor: adapter.configFlavor,
        bytes,
        dataSource: "SIMULATOR",
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.CONFIG_BACKUP =
    (counters.completedByType.CONFIG_BACKUP ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: ${target.hostname} bytes=${bytes} flavor=${adapter.configFlavor}`
  );
}

/* ───────────────────────── DISCOVERY probe ────────────────────────────── */

async function runDiscoveryJob(job: ClaimedJob): Promise<void> {
  const startedAt = Date.now();
  const payload = job.payload ?? {};
  const name = typeof payload.name === "string" && payload.name ? payload.name : null;
  const rawSubnets = Array.isArray(payload.subnets) ? payload.subnets : [];
  const rawPorts = Array.isArray(payload.ports) ? payload.ports : undefined;
  const config = normalizeDiscoveryPolicyConfig({
    subnets: rawSubnets.map((s) => String(s)),
    ports: rawPorts,
    intervalMinutes: 60,
    enabled: true,
  });
  if (!config) {
    throw new Error("Invalid discovery payload: only bounded /24-/32 subnets, approved TCP ports, and non-governed address classes are allowed");
  }
  const subnets = config.subnets;
  const ports = config.ports;

  const targetCounts = subnets.map((subnet) => enumerateDiscoveryTargets(subnet).length);
  const totalTargets = targetCounts.reduce((sum, count) => sum + count, 0);
  if (totalTargets > MAX_DISCOVERY_TARGETS) {
    throw new Error(
      "Discovery is limited to " +
        MAX_DISCOVERY_TARGETS +
        " IPv4 targets per job; requested " +
        totalTargets,
    );
  }

  await reportProgress(
    job.id,
    3,
    "Starting" +
      (name ? ' "' + name + '"' : "") +
      " bounded TCP/reverse-DNS scan of " +
      subnets.length +
      " subnet" +
      (subnets.length === 1 ? "" : "s") +
      " (" +
      totalTargets +
      " targets)",
  );

  const candidates: DiscoveryCandidate[] = [];
  let scannedTargets = 0;

  for (const [index, subnet] of subnets.entries()) {
    const scan = await scanDiscoverySubnet(subnet, {
      ports,
      onProgress: async (completed, total) => {
        const current = scannedTargets + completed;
        const progress = Math.min(
          90,
          5 + Math.round((current / Math.max(totalTargets, 1)) * 85),
        );
        await reportProgress(
          job.id,
          progress,
          "Probed " + subnet + ": " + completed + "/" + total + " targets",
        );
      },
    });

    candidates.push(...scan.candidates);
    scannedTargets += scan.targetsScanned;
    await reportProgress(
      job.id,
      5 + Math.round((scannedTargets / Math.max(totalTargets, 1)) * 85),
      "Scanned " +
        subnet +
        " (" +
        (index + 1) +
        "/" +
        subnets.length +
        ") — " +
        scan.candidates.length +
        " reachable targets",
    );
  }

  const reconciliation = (await nextPost(
    "/api/v1/worker/discovery/reconcile",
    { jobId: job.id, candidates },
    15_000,
  )) as {
    observed?: number;
    matchedDevices?: number;
    unmatched?: number;
    lastSeenUpdated?: number;
  };

  const durationMs = Date.now() - startedAt;
  await completePost(
    job,
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        candidates,
        scannedSubnets: subnets.length,
        scannedTargets,
        durationMs,
        reconciliation,
      },
    },
    15_000,
  );

  counters.completed += 1;
  counters.completedByType.DISCOVERY = (counters.completedByType.DISCOVERY ?? 0) + 1;
  await log(
    "job " +
      job.id +
      " [" +
      job.correlationId +
      "] SUCCEEDED: discovery scanned=" +
      subnets.length +
      " targets=" +
      scannedTargets +
      " reachable=" +
      candidates.length +
      " durationMs=" +
      durationMs,
  );
}

/* ───────────────────────── DRIFT_CHECK evaluation ────────────────────── */

interface DriftEvaluateResponse {
  skipped?: boolean;
  reason?: string;
  drift?: boolean;
  recordId?: string;
  created?: boolean;
  baselineVersion?: number;
  currentVersion?: number;
  resolved?: number;
  stats?: { added: number; removed: number; changed: number; unchanged: number };
}

/** DRIFT_CHECK execution — evaluation happens in the Next.js API. */
async function runDriftCheckJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const hostname = typeof payload.hostname === "string" ? payload.hostname : "device";
  const triggeredBy = typeof payload.triggeredBy === "string" ? payload.triggeredBy : "SCHEDULE";

  await reportProgress(job.id, 10, `Loading approved baseline and CURRENT config for ${hostname}`);

  const evaluation = (await nextPost("/api/v1/worker/drift-evaluate", {
    jobId: job.id,
  }, 20_000)) as DriftEvaluateResponse;

  await reportProgress(job.id, 70, `Comparing normalized configuration texts`);

  let result: Record<string, unknown>;
  let summary: string;
  if (evaluation.skipped) {
    result = { outcome: "skipped", reason: evaluation.reason ?? "unknown" };
    summary = `skipped: ${evaluation.reason ?? "unknown"}`;
  } else if (evaluation.drift) {
    result = {
      outcome: "drift",
      recordId: evaluation.recordId,
      baselineVersion: evaluation.baselineVersion,
      currentVersion: evaluation.currentVersion,
      stats: evaluation.stats,
      triggeredBy,
    };
    const s = evaluation.stats;
    summary = `DRIFT vs baseline v${evaluation.baselineVersion}: +${s?.added ?? "?"} −${s?.removed ?? "?"} ~${s?.changed ?? "?"} (record ${evaluation.recordId ?? "?"})`;
  } else {
    result = {
      outcome: "no-drift",
      baselineVersion: evaluation.baselineVersion,
      currentVersion: evaluation.currentVersion,
      resolved: evaluation.resolved ?? 0,
      triggeredBy,
    };
    summary = `no drift vs baseline v${evaluation.baselineVersion} (running v${evaluation.currentVersion}${evaluation.resolved ? `, resolved ${evaluation.resolved} open record(s)` : ""})`;
  }

  await completePost(
    job,
    { jobId: job.id, outcome: "SUCCEEDED", result },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.DRIFT_CHECK = (counters.completedByType.DRIFT_CHECK ?? 0) + 1;
  await log(`job ${job.id} [${job.correlationId}] SUCCEEDED: drift-check ${summary}`);
}

/* ───────────────────── CHANGE_EXECUTE step driver (4-b) ───────────────── */

/**
 * CHANGE_EXECUTE execution — the Next.js change-step engine owns ALL the
 * intelligence; the worker only loops the step calls and reports progress.
 * The job is SUCCEEDED even when the change outcome is FAILED — the change
 * outcome lives in resultJson + the change rows.
 */
async function runChangeExecutionJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const changeNumber =
    typeof payload.changeNumber === "string" ? payload.changeNumber : String(job.targetId ?? "change");
  const changeTitle = typeof payload.changeTitle === "string" ? payload.changeTitle : "";
  const failAt =
    payload.failAt === "APPLY" || payload.failAt === "VALIDATE" ? payload.failAt : null;

  await reportProgress(
    job.id,
    3,
    `Starting execution of ${changeNumber}${changeTitle ? ` — ${changeTitle}` : ""}${failAt ? ` (demo control failAt=${failAt})` : ""}`
  );

  for (let iteration = 0; iteration < CHANGE_MAX_STEP_CALLS; iteration += 1) {
    const step = (await nextPost(
      "/api/v1/worker/change-step",
      { jobId: job.id },
      CHANGE_STEP_CALL_TIMEOUT_MS
    )) as ChangeStepResponse;

    const total = step.stepsTotal ?? 0;
    const completed = step.stepsCompleted ?? 0;
    const pct = total > 0 ? Math.min(97, 3 + Math.round((completed / total) * 94)) : 5;
    const lastLabel = step.lastStep ? `${step.lastStep.name} → ${step.lastStep.status}` : "working";
    await reportProgress(job.id, pct, `${changeNumber}: ${step.message ?? lastLabel}`);

    if (step.done) {
      const outcome = step.outcome ?? "SUCCESS";
      await completePost(
        job,
        {
          jobId: job.id,
          outcome: "SUCCEEDED",
          result: {
            outcome,
            changeStatus: step.changeStatus ?? null,
            suggestIncident: step.suggestIncident === true,
            stepsTotal: total,
            stepsCompleted: completed,
            failAt,
          },
        },
        15_000
      );
      counters.completed += 1;
      counters.completedByType.CHANGE_EXECUTE =
        (counters.completedByType.CHANGE_EXECUTE ?? 0) + 1;
      await log(
        `job ${job.id} [${job.correlationId}] SUCCEEDED: change ${changeNumber} outcome=${outcome} status=${step.changeStatus ?? "?"} steps=${completed}/${total}${failAt ? ` failAt=${failAt}` : ""}`
      );
      return;
    }

    // Small beat between steps so the timeline reads like a real execution.
    // The bounds are the budget module's constants — the derivation's
    // "(+sleeps)" factor is exactly this beat's upper bound.
    await sleep(randInt(CHANGE_INTER_STEP_SLEEP_MIN_MS, CHANGE_INTER_STEP_SLEEP_MAX_MS));
  }

  throw new Error(
    `Change execution for ${changeNumber} did not finish within ${CHANGE_MAX_STEP_CALLS} step iterations`
  );
}

/* ───────────────────── ALERT_EVALUATION driver (5-a) ─────────────────── */

interface AlertEvaluationResponse {
  rulesEvaluated: number;
  devicesConsidered: number;
  fired: number;
  deduped: number;
  suppressed: number;
  childrenSuppressed: number;
  resolved: number;
  incidentsCreated: number;
  notificationsCreated: number;
  triggeredBy?: string;
}

/** ALERT_EVALUATION execution — evaluation happens in the Next.js API. */
async function runAlertEvaluationJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const triggeredBy =
    typeof payload.triggeredBy === "string" ? payload.triggeredBy : "JOB";

  await reportProgress(job.id, 10, "Loading active alert rules and scoped devices");

  const summary = (await nextPost(
    "/api/v1/alerts/evaluate",
    { jobId: job.id, triggeredBy },
    60_000
  )) as AlertEvaluationResponse;

  await reportProgress(
    job.id,
    80,
    `Evaluated ${summary.rulesEvaluated} rule(s) across ${summary.devicesConsidered} device(s)`
  );

  await completePost(
    job,
    { jobId: job.id, outcome: "SUCCEEDED", result: summary },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.ALERT_EVALUATION =
    (counters.completedByType.ALERT_EVALUATION ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: alert-evaluation rules=${summary.rulesEvaluated} fired=${summary.fired} deduped=${summary.deduped} suppressed=${summary.suppressed} children=${summary.childrenSuppressed} resolved=${summary.resolved} incidents=${summary.incidentsCreated} notifications=${summary.notificationsCreated}`
  );
}

/* ───────────────────── METRIC_RETENTION driver (6-a) ─────────────────── */

interface MetricRetentionResult {
  outcome: "pruned" | "throttled";
  metricSamplesDeleted?: number;
  rollup5MDeleted?: number;
  rollup1HDeleted?: number;
  rollup1DDeleted?: number;
  durationMs?: number;
  reason?: string;
}

/**
 * METRIC_RETENTION execution — the prune logic (deletes + Setting + audit)
 * lives entirely in the Next.js API; the worker just triggers it and
 * reports the counts. A throttled run (manual prune within 60 s) is a
 * SUCCESS for the job — it means the fleet was pruned recently enough.
 */
async function runMetricRetentionJob(job: ClaimedJob): Promise<void> {
  await reportProgress(job.id, 10, "Loading metric retention policy (raw/5M/1H/1D windows)");

  try {
    const counts = (await nextPost(
      "/api/v1/metrics/retention/prune",
      { triggeredBy: "SCHEDULE" },
      60_000
    )) as {
      metricSamplesDeleted?: number;
      rollup5MDeleted?: number;
      rollup1HDeleted?: number;
      rollup1DDeleted?: number;
      durationMs?: number;
    };

    await reportProgress(
      job.id,
      80,
      `Pruned samples=${counts.metricSamplesDeleted ?? 0} rollup5M=${counts.rollup5MDeleted ?? 0} rollup1H=${counts.rollup1HDeleted ?? 0} rollup1D=${counts.rollup1DDeleted ?? 0}`
    );

    const result: MetricRetentionResult = { outcome: "pruned", ...counts };
    await completePost(
      job,
      { jobId: job.id, outcome: "SUCCEEDED", result },
      15_000
    );
    counters.completed += 1;
    counters.completedByType.METRIC_RETENTION =
      (counters.completedByType.METRIC_RETENTION ?? 0) + 1;
    await log(
      `job ${job.id} [${job.correlationId}] SUCCEEDED: metric-retention samples=${counts.metricSamplesDeleted ?? 0} 5M=${counts.rollup5MDeleted ?? 0} 1H=${counts.rollup1HDeleted ?? 0} 1D=${counts.rollup1DDeleted ?? 0} in ${counts.durationMs ?? "?"}ms`
    );
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (message.includes("PRUNE_THROTTLED") || message.includes("HTTP 429")) {
      const result: MetricRetentionResult = {
        outcome: "throttled",
        reason: "A metric retention prune ran less than 60s ago (PRUNE_THROTTLED)",
      };
      await completePost(
        job,
        { jobId: job.id, outcome: "SUCCEEDED", result },
        15_000
      );
      counters.completed += 1;
      counters.completedByType.METRIC_RETENTION =
        (counters.completedByType.METRIC_RETENTION ?? 0) + 1;
      await log(
        `job ${job.id} [${job.correlationId}] SUCCEEDED: metric-retention throttled (recent manual prune)`
      );
      return;
    }
    throw e;
  }
}

interface FlowRetentionResult {
  outcome: "pruned" | "disabled";
  flowRecordsDeleted: number;
  durationMs: number;
  retentionDays: number;
  cutoff: string;
  correlationId: string;
}

async function runFlowRetentionJob(job: ClaimedJob): Promise<void> {
  await reportProgress(job.id, 10, "Loading 14-day flow retention policy");
  const result = (await nextPost(
    "/api/v1/flows/retention/prune",
    { triggeredBy: "SCHEDULE" },
    60_000,
  )) as FlowRetentionResult;
  await reportProgress(
    job.id,
    80,
    `Pruned flow records=${result.flowRecordsDeleted} outcome=${result.outcome}`,
  );
  await completePost(
    job,
    { jobId: job.id, outcome: "SUCCEEDED", result },
    15_000,
  );
  counters.completed += 1;
  counters.completedByType.FLOW_RETENTION =
    (counters.completedByType.FLOW_RETENTION ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: flow-retention deleted=${result.flowRecordsDeleted} days=${result.retentionDays} in ${result.durationMs}ms`,
  );
}

/* ───────────── ROLLUP_AGGREGATION driver (RT-002) ───────────── */

interface RollupAggregationResult {
  outcome: "aggregated" | "throttled";
  groupsComputed?: number;
  groupsUpserted?: number;
  remaining?: number;
  bounded?: boolean;
  durationMs?: number;
  reason?: string;
}

/**
 * ROLLUP_AGGREGATION execution — the aggregation (bucketing + upserts +
 * audit) lives entirely in the Next.js API; the worker just triggers it and
 * reports the summary. An overlapping run (429 ROLLUP_THROTTLED from the
 * in-flight guard) is a SUCCESS for the job — another tick is aggregating.
 */
async function runRollupAggregationJob(job: ClaimedJob): Promise<void> {
  await reportProgress(job.id, 10, "Aggregating closed MetricSample buckets into MetricRollup");

  try {
    const summary = (await nextPost(
      "/api/v1/metrics/rollup/aggregate",
      { jobId: job.id, triggeredBy: "JOB" },
      60_000
    )) as {
      groupsComputed?: number;
      groupsUpserted?: number;
      remaining?: number;
      bounded?: boolean;
      durationMs?: number;
    };

    await reportProgress(
      job.id,
      80,
      `Aggregated upserts=${summary.groupsUpserted ?? 0} remaining=${summary.remaining ?? 0}${summary.bounded ? " (bounded)" : ""}`
    );

    const result: RollupAggregationResult = { outcome: "aggregated", ...summary };
    await completePost(
      job,
      { jobId: job.id, outcome: "SUCCEEDED", result },
      15_000
    );
    counters.completed += 1;
    counters.completedByType.ROLLUP_AGGREGATION =
      (counters.completedByType.ROLLUP_AGGREGATION ?? 0) + 1;
    await log(
      `job ${job.id} [${job.correlationId}] SUCCEEDED: rollup-aggregation computed=${summary.groupsComputed ?? 0} upserted=${summary.groupsUpserted ?? 0} remaining=${summary.remaining ?? 0} in ${summary.durationMs ?? "?"}ms`
    );
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (message.includes("ROLLUP_THROTTLED") || message.includes("HTTP 429")) {
      const result: RollupAggregationResult = {
        outcome: "throttled",
        reason: "A rollup aggregation is already in flight (ROLLUP_THROTTLED)",
      };
      await completePost(
        job,
        { jobId: job.id, outcome: "SUCCEEDED", result },
        15_000
      );
      counters.completed += 1;
      counters.completedByType.ROLLUP_AGGREGATION =
        (counters.completedByType.ROLLUP_AGGREGATION ?? 0) + 1;
      await log(
        `job ${job.id} [${job.correlationId}] SUCCEEDED: rollup-aggregation throttled (run in flight)`
      );
      return;
    }
    throw e;
  }
}

/* ───────────── PROTOCOL_QUEUE_RETENTION driver (RT-003) ───────────── */

interface ProtocolQueueRetentionResult {
  outcome: "pruned" | "disabled" | "throttled";
  queueRowsDeleted?: number;
  durationMs?: number;
  deliveredDays?: number;
  deadDays?: number;
  correlationId?: string;
  reason?: string;
}

/**
 * PROTOCOL_QUEUE_RETENTION execution — the sweep (chunked deletes + Setting
 * + audit) lives entirely in the Next.js API; the worker just triggers it
 * and reports the counts. A throttled run (another prune within 60 s) is a
 * SUCCESS for the job — it means the queue was swept recently enough.
 */
async function runProtocolQueueRetentionJob(job: ClaimedJob): Promise<void> {
  await reportProgress(job.id, 10, "Loading protocol queue retention policy (delivered/dead windows)");

  try {
    const result = (await nextPost(
      "/api/v1/protocol/queue/retention/prune",
      { triggeredBy: "SCHEDULE" },
      60_000
    )) as ProtocolQueueRetentionResult;

    await reportProgress(
      job.id,
      80,
      `Pruned queue rows=${result.queueRowsDeleted ?? 0} outcome=${result.outcome}`
    );

    await completePost(
      job,
      { jobId: job.id, outcome: "SUCCEEDED", result },
      15_000
    );
    counters.completed += 1;
    counters.completedByType.PROTOCOL_QUEUE_RETENTION =
      (counters.completedByType.PROTOCOL_QUEUE_RETENTION ?? 0) + 1;
    await log(
      `job ${job.id} [${job.correlationId}] SUCCEEDED: protocol-queue-retention deleted=${result.queueRowsDeleted ?? 0} deliveredDays=${result.deliveredDays ?? "?"} deadDays=${result.deadDays ?? "?"} in ${result.durationMs ?? "?"}ms`
    );
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (message.includes("PROTOCOL_QUEUE_PRUNE_THROTTLED") || message.includes("HTTP 429")) {
      const result: ProtocolQueueRetentionResult = {
        outcome: "throttled",
        reason: "A protocol queue retention prune ran less than 60s ago (PROTOCOL_QUEUE_PRUNE_THROTTLED)",
      };
      await completePost(
        job,
        { jobId: job.id, outcome: "SUCCEEDED", result },
        15_000
      );
      counters.completed += 1;
      counters.completedByType.PROTOCOL_QUEUE_RETENTION =
        (counters.completedByType.PROTOCOL_QUEUE_RETENTION ?? 0) + 1;
      await log(
        `job ${job.id} [${job.correlationId}] SUCCEEDED: protocol-queue-retention throttled (recent prune)`
      );
      return;
    }
    throw e;
  }
}

/* ───────────────── FIRMWARE_UPGRADE driver (Phase 13-b) ─────────────── */

/**
 * FIRMWARE_UPGRADE execution — simulated staged upgrade; persistence
 * (device.firmware + FIRMWARE_UPGRADED audit) happens in the Next.js API.
 * The job payload is { deviceId, targetVersion } enriched at claim time
 * with the device header (hostname/vendor/fromVersion/status).
 */
async function runFirmwareUpgradeJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const hostname = typeof payload.hostname === "string" ? payload.hostname : "device";
  const fromVersion = typeof payload.fromVersion === "string" ? payload.fromVersion : "unknown";
  const targetVersion = typeof payload.targetVersion === "string" ? payload.targetVersion : "";
  const vendor = typeof payload.vendor === "string" ? payload.vendor : "generic";

  if (!targetVersion) {
    throw new Error("Invalid firmware-upgrade payload: targetVersion is missing");
  }
  if ((typeof payload.status === "string" ? payload.status : "").toUpperCase() === "OFFLINE") {
    // Realism: cannot stage an image on an unreachable device — the generic
    // failure path (requeue/backoff) takes over from here.
    throw new Error(`Device ${hostname} is OFFLINE — firmware upgrade aborted`);
  }

  await reportProgress(
    job.id,
    8,
    `Resolving ${hostname} (${vendor}) — planned upgrade ${fromVersion} → ${targetVersion}`
  );
  await sleep(randInt(600, 1_200));

  await reportProgress(
    job.id,
    25,
    `Downloading ${vendor} image ${targetVersion} to ${hostname} (simulated transfer)`
  );
  await sleep(randInt(1_200, 2_000));

  await reportProgress(
    job.id,
    50,
    `Staging image on ${hostname} — checksum verified, space check OK`
  );
  await sleep(randInt(1_000, 1_800));

  await reportProgress(
    job.id,
    72,
    `Activating ${targetVersion} on ${hostname} — control plane restarting into the new image`
  );
  await sleep(randInt(1_200, 2_000));

  await reportProgress(
    job.id,
    90,
    `Post-check on ${hostname} — confirming running version ${targetVersion} and service health`
  );

  // The state mutation (device.firmware + FIRMWARE_UPGRADED audit) happens
  // in the Next.js API — the worker never opens SQLite.
  const result = (await nextPost(
    "/api/v1/worker/firmware-upgrade",
    { jobId: job.id },
    20_000
  )) as FirmwareUpgradeResponse;

  await completePost(
    job,
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        outcome: "upgraded",
        deviceId: result.deviceId,
        hostname: result.hostname,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        alreadyAtTarget: result.alreadyAtTarget === true,
        upgradedAt: result.upgradedAt ?? new Date().toISOString(),
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.FIRMWARE_UPGRADE =
    (counters.completedByType.FIRMWARE_UPGRADE ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: firmware-upgrade ${result.hostname} ${result.fromVersion ?? "?"} → ${result.toVersion}${result.alreadyAtTarget ? " (already at target)" : ""}`
  );
}

/* ───────────────────── ZTP_PROVISION driver (Phase 14-b) ───────────────────── */

/**
 * ZTP_PROVISION execution — simulated staged zero-touch provisioning;
 * ALL persistence (Device creation, claim status, ZTP_PROVISIONED /
 * ZTP_PROVISION_FAILED audit, bootstrap snapshot) happens in the Next.js
 * API via /api/v1/worker/ztp-provision. The job payload is
 * { claimId, serial, hostname, vendorKey, model, templateId }.
 */
async function runZtpProvisionJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const serial = typeof payload.serial === "string" ? payload.serial : "unknown-serial";
  const hostname = typeof payload.hostname === "string" ? payload.hostname : "device";
  const vendorKey = typeof payload.vendorKey === "string" ? payload.vendorKey : "generic";
  const templateId = typeof payload.templateId === "string" ? payload.templateId : "";
  const model = typeof payload.model === "string" ? payload.model : "";

  if (!payload.claimId) {
    throw new Error("Invalid ztp-provision payload: claimId is missing");
  }

  await reportProgress(
    job.id,
    8,
    `Validating ZTP claim ${serial} (${vendorKey}${model ? ` ${model}` : ""}) against the provisioning policy`
  );
  await sleep(randInt(700, 1_400));

  await reportProgress(
    job.id,
    28,
    `Rendering ${templateId || "ZTP"} bootstrap config for ${hostname} — mgmt profile + site variables`
  );
  await sleep(randInt(900, 1_700));

  await reportProgress(
    job.id,
    55,
    `Pushing rendered bootstrap config to ${hostname} (${vendorKey}) — commit id 8${randInt(1000000, 9999999)}`
  );
  await sleep(randInt(1_100, 2_000));

  await reportProgress(
    job.id,
    80,
    `Registering ${hostname} in the inventory — first contact + management reachability`
  );
  await sleep(randInt(700, 1_400));

  // The state mutation (Device create + claim flip + audit + snapshot) happens
  // in the Next.js API — the worker never opens SQLite. An outcome "failed"
  // answer is a legitimate terminal result (the endpoint already recorded it);
  // only a transport/5xx error propagates to the retryable failure path.
  const result = (await nextPost(
    "/api/v1/worker/ztp-provision",
    { jobId: job.id },
    20_000
  )) as ZtpProvisionResponse;

  await completePost(
    job,
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        outcome: result.outcome,
        claimId: result.claimId,
        serial: result.serial,
        hostname: result.hostname,
        deviceId: result.deviceId ?? null,
        reason: result.reason ?? null,
        provisionedAt: result.provisionedAt ?? new Date().toISOString(),
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.ZTP_PROVISION =
    (counters.completedByType.ZTP_PROVISION ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: ztp-provision ${result.serial} → ${result.hostname} outcome=${result.outcome}${result.deviceId ? ` deviceId=${result.deviceId}` : ""}${result.reason ? ` reason=${result.reason}` : ""}`
  );
}

/* ───────────────────── REPORT_RUN driver (9-a) ─────────────────── */

/** Response shape of POST /api/v1/reports/execute. */
interface ReportRunResponse {
  jobId: string;
  scheduleId: string;
  scheduleName?: string;
  reportType: string;
  format: string;
  range: string;
  rows: number;
  generatedAt: string;
}

/**
 * REPORT_RUN execution — generation AND completion happen in the Next.js
 * API (/api/v1/reports/execute persists SUCCEEDED + resultJson artifact +
 * schedule lastRunAt + REPORT_GENERATED audit). The worker only drives and
 * observes, so there is deliberately no /worker/complete post here.
 */
async function runReportJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const scheduleName =
    typeof payload.scheduleName === "string" ? payload.scheduleName : "schedule";

  await reportProgress(job.id, 10, `Resolving report schedule "${scheduleName}" and data window`);

  const summary = (await nextPost(
    "/api/v1/reports/execute",
    { jobId: job.id },
    60_000
  )) as ReportRunResponse;

  await reportProgress(
    job.id,
    80,
    `Generated ${summary.reportType} report (${summary.range}) — ${summary.rows} row(s), ${summary.format}`
  );

  counters.completed += 1;
  counters.completedByType.REPORT_RUN =
    (counters.completedByType.REPORT_RUN ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: report-run schedule="${summary.scheduleName ?? scheduleName}" type=${summary.reportType} range=${summary.range} rows=${summary.rows} format=${summary.format} (completed in-Next by /api/v1/reports/execute)`
  );
}


/* ───────────────────── SNMP_POLL data-plane execution ─────────────────── */

interface SnmpPollProfileResponse {
  profile?: SnmpV3PollProfileReference;
}

/** SNMP_POLL execution — credentials resolve only inside the worker. */
async function runSnmpPollJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : job.targetId;
  if (!deviceId) throw new Error("Invalid SNMP_POLL payload: deviceId is missing");

  const profileResult = (await nextPost(
    "/api/v1/ingest/protocol/snmpv3-profile/poll",
    {
      deviceId,
      ...(typeof payload.credentialProfileId === "string"
        ? { credentialProfileId: payload.credentialProfileId }
        : {}),
    },
    10_000,
  )) as SnmpPollProfileResponse;
  const profile = profileResult.profile;
  if (!profile) throw new Error("SNMPv3 polling profile lookup returned no profile");

  const hostname = profile.hostname;
  await reportProgress(job.id, 5, "Resolved enrolled SNMPv3 profile for " + hostname);
  const rawIndexes = payload.interfaceIndexes;
  if (
    rawIndexes !== undefined &&
    (!Array.isArray(rawIndexes) ||
      rawIndexes.some((index) => typeof index !== "number" || !Number.isSafeInteger(index)))
  ) {
    throw new Error("Invalid SNMP_POLL payload: interfaceIndexes must be integer[]");
  }
  const rawMax = payload.maxInterfaces;
  if (
    rawMax !== undefined &&
    (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1 || rawMax > 32)
  ) {
    throw new Error("Invalid SNMP_POLL payload: maxInterfaces must be 1..32");
  }

  await reportProgress(job.id, 10, "Polling sysName, sysDescr, uptime, and bounded IF-MIB data");
  const result = await pollSnmpV3(profile, {
    maxInterfaces: rawMax as number | undefined,
    interfaceIndexes: rawIndexes as number[] | undefined,
    timeoutMs: 1_500,
    retries: 2,
    retryBackoffMs: 150,
    jitterMs: 100,
  });
  await reportProgress(
    job.id,
    78,
    "Verified " + result.interfaces.length + " interface(s) and " + result.attempts + " request attempt(s)",
  );

  await nextPost(
    "/api/v1/ingest/protocol/snmpv3-profile/accept",
    {
      sourceIp: profile.mgmtIp,
      username: profile.username,
      credentialProfileId: profile.credentialProfileId,
      engineIdHex: result.engine.engineIdHex,
      boots: result.engine.boots,
      time: result.engine.time,
    },
    10_000,
  );

  const completion = (await nextPost(
    "/api/v1/worker/snmpv3-poll/complete",
    { jobId: job.id, result },
    15_000,
  )) as { status?: string; interfaces?: number };
  counters.completed += 1;
  counters.completedByType.SNMP_POLL = (counters.completedByType.SNMP_POLL ?? 0) + 1;
  await log(
    "job " +
      job.id +
      " [" +
      job.correlationId +
      "] " +
      (completion.status ?? "SUCCEEDED") +
      ": SNMPv3 poll " +
      hostname +
      " interfaces=" +
      (completion.interfaces ?? result.interfaces.length) +
      " attempts=" +
      result.attempts +
      " optionalFailures=" +
      result.optionalFailures,
  );
}

async function executeJob(job: ClaimedJob): Promise<void> {
  try {
    if (job.type === "CONFIG_BACKUP") {
      await raceTimeout(runBackupJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "DISCOVERY") {
      await raceTimeout(runDiscoveryJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "SNMP_POLL") {
      await raceTimeout(runSnmpPollJob(job), 120_000, `job ${job.id}`);
    } else if (job.type === "DRIFT_CHECK") {
      await raceTimeout(runDriftCheckJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "CHANGE_EXECUTE") {
      // F-044 — claim-time budget derivation: the plan's own size bounds
      // the race. budget = min(stepsTotal, CHANGE_MAX_STEP_CALLS) ×
      // (stepTimeout + progressPost + maxSleep) + margin; the claim route
      // enriches the payload with stepsTotal, and a legacy/absent value
      // falls back to the FULL driver loop bound (fail-safe generosity —
      // never a premature race).
      const budgetMs = deriveChangeJobBudgetMs(job.payload?.stepsTotal);
      await raceTimeout(runChangeExecutionJob(job), budgetMs, `job ${job.id}`);
    } else if (job.type === "ALERT_EVALUATION") {
      await raceTimeout(runAlertEvaluationJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "METRIC_RETENTION") {
      await raceTimeout(runMetricRetentionJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "FLOW_RETENTION") {
      await raceTimeout(runFlowRetentionJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "ROLLUP_AGGREGATION") {
      await raceTimeout(runRollupAggregationJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "PROTOCOL_QUEUE_RETENTION") {
      await raceTimeout(runProtocolQueueRetentionJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "REPORT_RUN") {
      await raceTimeout(runReportJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "FIRMWARE_UPGRADE") {
      await raceTimeout(runFirmwareUpgradeJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "ZTP_PROVISION") {
      await raceTimeout(runZtpProvisionJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else {
      throw new Error(`Unsupported job type for worker v1: ${job.type}`);
    }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    // Task 10-a: the failure path itself must never produce an unhandled
    // rejection (e.g. backend down → reportFailure can fail too).
    // F-044: for CHANGE_EXECUTE a typed JobTimeoutError is DRIVER LOSS —
    // the plan keeps executing app-side, re-entry is safe through the
    // engine's CAS step claims, so the job is labeled resumed (requeued)
    // instead of FAILED. Every other error keeps the generic path.
    const isDriverLoss = job.type === "CHANGE_EXECUTE" && e instanceof JobTimeoutError;
    try {
      if (isDriverLoss) {
        await reportResumed(job, message);
      } else {
        await reportFailure(job, message);
      }
    } catch (reportErr) {
      await log(
        `failed to report failure for ${job.id}: ${(reportErr as Error)?.message ?? String(reportErr)}`
      );
    }
  }
}

let claiming = false;

/**
 * Exponential claim backoff (Task 10-a): 3 s → 6 → 12 → 24 → 48 → 96 →
 * 192 → 300 s (capped at MAX_BACKOFF_MS). Pure function of the consecutive
 * failure count, so the scheduler and the failure log always agree.
 */
function claimBackoffDelay(failures: number): number {
  return Math.min(CLAIM_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
}

async function claimTick(): Promise<"ok" | "failed" | "busy"> {
  if (claiming) return "busy";
  claiming = true;
  try {
    const free = CONCURRENCY_CAP - counters.running;
    if (free <= 0) return "busy";
    counters.lastClaimAttemptAt = new Date().toISOString();
    let jobs: ClaimedJob[];
    try {
      jobs = (await nextPost(
        "/api/v1/worker/claim",
        {
          types: [
            "CONFIG_BACKUP",
            "DISCOVERY",
            "SNMP_POLL",
            "DRIFT_CHECK",
            "CHANGE_EXECUTE",
            "ALERT_EVALUATION",
            "METRIC_RETENTION",
            "FLOW_RETENTION",
            "ROLLUP_AGGREGATION",
            "PROTOCOL_QUEUE_RETENTION",
            "REPORT_RUN",
            "FIRMWARE_UPGRADE",
            "ZTP_PROVISION",
          ],
          limit: Math.min(CLAIM_BATCH, free),
        },
        10_000
      )) as ClaimedJob[];
    } catch (e) {
      counters.consecutiveClaimFailures += 1;
      const delay = claimBackoffDelay(counters.consecutiveClaimFailures);
      await log(
        `claim failed (consecutive=${counters.consecutiveClaimFailures}, next retry in ${Math.round(delay / 1000)}s): ${(e as Error)?.message ?? String(e)}`
      );
      return "failed";
    }
    if (counters.consecutiveClaimFailures > 0) {
      await log(
        `backend recovered after ${counters.consecutiveClaimFailures} consecutive claim failures`
      );
    }
    counters.consecutiveClaimFailures = 0;
    counters.lastClaimOkAt = new Date().toISOString();
    for (const job of Array.isArray(jobs) ? jobs : []) {
      counters.claimed += 1;
      counters.running += 1;
      await log(
        `claimed ${job.id} (${job.type}) corr=${job.correlationId} attempt=${job.attempts}/${job.maxAttempts}`
      );
      void executeJob(job).finally(() => {
        counters.running -= 1;
      });
    }
    return "ok";
  } catch (e) {
    // Absolute containment: nothing from the tick body may escape to the
    // scheduler — an unexpected error here is logged and the loop continues.
    await log(`claim tick unexpected error (contained): ${(e as Error)?.message ?? String(e)}`);
    return "failed";
  } finally {
    claiming = false;
  }
}

/**
 * Self-scheduling claim loop (Task 10-a) — replaces the fixed setInterval.
 * The next tick is ALWAYS scheduled in `finally`, so no rejection (claim
 * failure, unexpected error, logging failure) can ever break the chain.
 * While the backend is unreachable the delay backs off exponentially up to
 * MAX_BACKOFF_MS; the first successful claim POST resets to CLAIM_INTERVAL_MS.
 */
async function runClaimCycle(): Promise<void> {
  let nextDelay = CLAIM_INTERVAL_MS;
  try {
    const result = await claimTick();
    if (result === "failed") {
      nextDelay = claimBackoffDelay(counters.consecutiveClaimFailures);
    }
  } catch (e) {
    // claimTick already contains its own errors; belt-and-braces guard so the
    // self-scheduling chain is truly immortal.
    nextDelay = claimBackoffDelay(counters.consecutiveClaimFailures + 1);
    try {
      await log(`claim loop unexpected error (contained): ${(e as Error)?.message ?? String(e)}`);
    } catch {
      /* logging must never break the loop */
    }
  } finally {
    counters.currentBackoffMs = nextDelay;
    setTimeout(() => void runClaimCycle(), nextDelay);
  }
}

export function startRunner(): void {
  log(
    `runner started: claim every ${CLAIM_INTERVAL_MS / 1000}s (exponential backoff up to ${MAX_BACKOFF_MS / 1000}s on backend outage), batch ${CLAIM_BATCH}, concurrency ${CONCURRENCY_CAP}, per-job timeout ${JOB_TIMEOUT_MS / 1000}s`
  );
  void runClaimCycle();
}
