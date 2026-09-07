/**
 * FayaNMS worker — job runner.
 *
 * Every 3 s the runner claims QUEUED JobExecutions from the Next.js API
 * (POST /api/v1/worker/claim), executes them with a concurrency cap of 3 and
 * a per-job timeout of 30 s, and reports progress/completion back over HTTP.
 * The runner is a pure orchestration/simulation engine — no DB access.
 *
 * CONFIG_BACKUP step sequence (progress reported via /api/v1/worker/progress):
 *   5%  resolving device            15% connect (via self POST /simulate/connect)
 *   40–85% generate config (1–2 s simulated work, 1–2 progress posts)
 *   then POST /api/v1/worker/complete with the raw/normalized config text.
 *
 * DISCOVERY step sequence (roadmap 2-c):
 *   per subnet 1.2–2.5 s of simulated scanning, 2–4 candidate devices per
 *   subnet, progress = round(scanned/total*90) with a per-subnet message,
 *   then POST /api/v1/worker/complete with { candidates, scannedSubnets,
 *   durationMs }. Candidates are persistence-free: they land in the job's
 *   resultJson and the import flow turns them into real Device rows.
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
 * Failure semantics live on the Next.js side: complete(FAILED) either requeues
 * with exponential-ish backoff (30 s * attempts) or dead-letters the job.
 * Any single job failure is contained — the loop never crashes.
 */

import { pickAdapter, sleep, randInt, type DeviceTarget } from "./adapters";
import { nextPost, selfPost, log } from "./next-client";

const CLAIM_INTERVAL_MS = 3_000;
const CONCURRENCY_CAP = 3;
const CLAIM_BATCH = 3;
const JOB_TIMEOUT_MS = 30_000;
/** CHANGE_EXECUTE drives a whole step loop — needs its own budget. */
const CHANGE_JOB_TIMEOUT_MS = 600_000;
const CHANGE_MAX_STEP_CALLS = 40;

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

/** Response shape of POST /api/v1/worker/change-step. */
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
  running: 0,
  completedByType: {} as Record<string, number>,
};

export function getCounters() {
  return { ...counters };
}

/** Bounded promise race: rejects with a clear message after `ms`. */
function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
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

async function reportFailure(jobId: string, correlationId: string, message: string) {
  counters.failed += 1;
  try {
    await nextPost(
      "/api/v1/worker/complete",
      { jobId, outcome: "FAILED", error: message },
      10_000
    );
    await log(`job ${jobId} [${correlationId}] FAILED: ${message}`);
  } catch (e) {
    await log(`complete(FAILED) post failed for ${jobId}: ${(e as Error).message}`);
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
  };

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

  // Connect step goes through the worker's own /simulate/connect endpoint
  // (spec step sequence) — same adapter code path the test-connection flow uses.
  const sim = (await selfPost("/simulate/connect", {
    vendor: target.vendor,
    host: target.managementIp ?? target.hostname,
    hostname: target.hostname,
  })) as { latencyMs?: number; negotiated?: string };

  const adapter = pickAdapter(target.vendor);
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

  await nextPost(
    "/api/v1/worker/complete",
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        rawText: cfg.rawText,
        normalizedText: cfg.normalizedText,
        configFlavor: adapter.configFlavor,
        bytes,
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

/* ───────────────────────── DISCOVERY simulation ───────────────────────── */

/** Candidate vendors, weighted towards cisco/hpe like a real campus fleet. */
const DISCOVERY_VENDORS: { vendor: string; weight: number }[] = [
  { vendor: "cisco", weight: 4 },
  { vendor: "hpe", weight: 3 },
  { vendor: "fortinet", weight: 2 },
  { vendor: "sophos", weight: 2 },
  { vendor: "generic", weight: 1 },
];

const OS_FINGERPRINTS: Record<string, string[]> = {
  cisco: [
    "Cisco IOS 15.x banner",
    "Cisco IOS XE 17.x banner (SSH-2.0 Cisco)",
    "Cisco NX-OS 9.3 banner",
  ],
  fortinet: ["FortiGate FortiOS 7.x", "FortiGate FortiOS 7.4 banner"],
  sophos: ["Sophos SFOS 19.x banner", "Sophos SFOS 20.x banner"],
  hpe: ["HPE AOS-CX 10.x banner", "HPE AOS-CX 10.10 banner"],
  generic: ["Generic SNMP sysDescr (v2c)", "Unknown appliance SSH banner"],
};

const MODEL_GUESSES: Record<string, string[]> = {
  cisco: ["C9300-48P", "C9200L-24P-4G", "ISR4331", "WS-C2960X-24TS-L"],
  fortinet: ["FortiGate 120G", "FortiGate 90G", "FortiGate 201F"],
  sophos: ["XGS 1300", "XGS 2100", "XGS 87"],
  hpe: ["6200F 48G (JL727A)", "6100 24G (JL679A)", "3810M 24G"],
  generic: ["NetGate 6100", "Unmanaged appliance"],
};

function weightedVendor(): string {
  const total = DISCOVERY_VENDORS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of DISCOVERY_VENDORS) {
    roll -= entry.weight;
    if (roll < 0) return entry.vendor;
  }
  return "generic";
}

const SUBNET_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Loose CIDR validation: dotted quad + prefix 8..32. Throws on garbage. */
function parseSubnet(subnet: string): { baseInt: number; prefix: number } {
  const match = SUBNET_PATTERN.exec(subnet.trim());
  if (!match) {
    throw new Error(`Invalid subnet "${subnet}" — expected a.b.c.d/prefix`);
  }
  const octets = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
  if (octets.some((o) => o > 255)) {
    throw new Error(`Invalid subnet "${subnet}" — octet out of range`);
  }
  const prefix = Number(match[5]);
  if (prefix < 8 || prefix > 32) {
    throw new Error(`Invalid subnet "${subnet}" — prefix must be 8..32`);
  }
  const baseInt =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return { baseInt, prefix };
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

/** Host address inside the subnet: /24 → last octet 1..254, else base + offset. */
function hostAddress(baseInt: number, prefix: number): number {
  return prefix >= 24
    ? (baseInt & 0xffffff00) + randInt(1, 254)
    : baseInt + randInt(1, 254);
}

function candidateHostname(ip: string, vendor: string): string {
  const dashed = ip.replaceAll(".", "-");
  // Reverse-DNS-ish name for ~40% of hosts, neutral otherwise.
  const role = vendor === "cisco" || vendor === "hpe" ? "sw" : "unk";
  return Math.random() < 0.4
    ? `${role}-${dashed}.example.net`
    : `unk-${dashed}`;
}

/** DISCOVERY execution — simulates a per-subnet sweep and reports candidates. */
async function runDiscoveryJob(job: ClaimedJob): Promise<void> {
  const startedAt = Date.now();
  const payload = job.payload ?? {};
  const name = typeof payload.name === "string" && payload.name ? payload.name : null;
  const rawSubnets = Array.isArray(payload.subnets) ? payload.subnets : [];
  const subnets = rawSubnets.map((s) => String(s));

  if (subnets.length === 0) {
    throw new Error("Invalid discovery payload: subnets[] is empty or missing");
  }
  const parsed = subnets.map((s) => ({ subnet: s, ...parseSubnet(s) }));

  await reportProgress(
    job.id,
    3,
    `Starting${name ? ` "${name}"` : ""} scan of ${parsed.length} subnet${parsed.length === 1 ? "" : "s"} (ping/SNMP sweep)`
  );

  const candidates: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (const entry of parsed) {
    await sleep(randInt(1_200, 2_500));
    const found = randInt(2, 4);
    const usedHosts = new Set<number>();
    for (let i = 0; i < found; i += 1) {
      // Roll a unique host address within the subnet (12 tries is plenty
      // for 2–4 picks out of ≥254 addresses).
      let hostInt = 0;
      for (let tries = 0; tries < 12; tries += 1) {
        hostInt = hostAddress(entry.baseInt, entry.prefix);
        if (!usedHosts.has(hostInt)) break;
      }
      usedHosts.add(hostInt);
      const vendor = weightedVendor();
      const ip = intToIp(hostInt);
      const fingerprints = OS_FINGERPRINTS[vendor];
      const models = MODEL_GUESSES[vendor];
      candidates.push({
        ip,
        hostname: candidateHostname(ip, vendor),
        vendorGuess: vendor,
        modelGuess: models[randInt(0, models.length - 1)],
        mgmtPort: 22,
        protocols: ["ssh", "https"],
        confidence: randInt(60, 99),
        osFingerprint: fingerprints[randInt(0, fingerprints.length - 1)],
        discoveredAt: new Date().toISOString(),
      });
    }
    scanned += 1;
    await reportProgress(
      job.id,
      Math.round((scanned / parsed.length) * 90),
      `Scanned ${entry.subnet} — ${found} candidates`
    );
  }

  const durationMs = Date.now() - startedAt;
  await nextPost(
    "/api/v1/worker/complete",
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        candidates,
        scannedSubnets: subnets.length,
        durationMs,
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.DISCOVERY = (counters.completedByType.DISCOVERY ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: discovery scanned=${subnets.length} candidates=${candidates.length} durationMs=${durationMs}`
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

  await nextPost(
    "/api/v1/worker/complete",
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
      90_000
    )) as ChangeStepResponse;

    const total = step.stepsTotal ?? 0;
    const completed = step.stepsCompleted ?? 0;
    const pct = total > 0 ? Math.min(97, 3 + Math.round((completed / total) * 94)) : 5;
    const lastLabel = step.lastStep ? `${step.lastStep.name} → ${step.lastStep.status}` : "working";
    await reportProgress(job.id, pct, `${changeNumber}: ${step.message ?? lastLabel}`);

    if (step.done) {
      const outcome = step.outcome ?? "SUCCESS";
      await nextPost(
        "/api/v1/worker/complete",
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
    await sleep(randInt(300, 600));
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

  await nextPost(
    "/api/v1/worker/complete",
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
    await nextPost(
      "/api/v1/worker/complete",
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
      await nextPost(
        "/api/v1/worker/complete",
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

async function executeJob(job: ClaimedJob): Promise<void> {
  try {
    if (job.type === "CONFIG_BACKUP") {
      await raceTimeout(runBackupJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "DISCOVERY") {
      await raceTimeout(runDiscoveryJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "DRIFT_CHECK") {
      await raceTimeout(runDriftCheckJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "CHANGE_EXECUTE") {
      await raceTimeout(runChangeExecutionJob(job), CHANGE_JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "ALERT_EVALUATION") {
      await raceTimeout(runAlertEvaluationJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "METRIC_RETENTION") {
      await raceTimeout(runMetricRetentionJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "REPORT_RUN") {
      await raceTimeout(runReportJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else {
      throw new Error(`Unsupported job type for worker v1: ${job.type}`);
    }
  } catch (e) {
    await reportFailure(job.id, job.correlationId, (e as Error)?.message ?? String(e));
  }
}

let claiming = false;

async function claimTick(): Promise<void> {
  if (claiming) return;
  claiming = true;
  try {
    const free = CONCURRENCY_CAP - counters.running;
    if (free <= 0) return;
    const jobs = (await nextPost(
      "/api/v1/worker/claim",
      { types: ["CONFIG_BACKUP", "DISCOVERY", "DRIFT_CHECK", "CHANGE_EXECUTE", "ALERT_EVALUATION", "METRIC_RETENTION", "REPORT_RUN"], limit: Math.min(CLAIM_BATCH, free) },
      10_000
    )) as ClaimedJob[];
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
  } catch (e) {
    await log(`claim failed: ${(e as Error).message}`);
  } finally {
    claiming = false;
  }
}

export function startRunner(): void {
  log(
    `runner started: claim every ${CLAIM_INTERVAL_MS / 1000}s, batch ${CLAIM_BATCH}, concurrency ${CONCURRENCY_CAP}, per-job timeout ${JOB_TIMEOUT_MS / 1000}s`
  );
  void claimTick();
  setInterval(() => void claimTick(), CLAIM_INTERVAL_MS);
}
