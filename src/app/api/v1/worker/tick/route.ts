import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, newJobCorrelationId, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { parsePolicyScope, scopeDeviceWhere } from "../../_lib/scope";
import { pruneRetention } from "@/lib/backups/retention";
import { parseStoredDiscoveryPolicy } from "@/lib/discovery/policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/tick — scheduler tick driven by the worker mini-service.
 *
 * For every active BackupPolicy:
 *   1. parse its 5-field cron expression (supports star, exact values, a-b
 *      ranges, a,b lists and step values written as star-slash-n — a small
 *      hand-rolled matcher);
 *      the policy is DUE when a matching minute mark falls inside the last
 *      tick window (default 65 s — a 30 s tick loop always lands inside one).
 *   2. if due, resolve the policy's target devices from its scopeJson
 *      (legacy keys { siteCodes, criticality, excludeStatuses } and canonical
 *      keys { siteCodes, criticalities, statuses }; `statuses` is an include
 *      filter); UNMANAGED and OFFLINE devices are always excluded
 *      (unreachable devices are not scheduled — the seeded HQ-IDF-SW-01
 *      failed-backup story stays untouched; manual backup-now on an OFFLINE
 *      device still fails realistically in the worker).
 *   3. dedupe per device: skip devices that already have a QUEUED/RUNNING
 *      CONFIG_BACKUP job, or a policy-tagged job (payloadJson contains the
 *      policyId) created within the 10-minute dedupe window. Repeated ticks
 *      within a minute can therefore never double-enqueue.
 *   4. enqueue CONFIG_BACKUP JobExecutions (payload: deviceId, policyId,
 *      policyName, source SCHEDULED), capped at 10 per policy per tick.
 *
 * Retention pruning (Task 3-a), after enqueue processing:
 *   For every active policy each scoped device's ConfigSnapshot rows with
 *   status HISTORICAL older than the policy window become prune candidates.
 *   A device covered by several policies keeps the LONGEST window (most
 *   generous retention wins — one policy can never destroy another's
 *   history). Safety caps, in order:
 *     - CURRENT and BASELINE snapshots are never touched;
 *     - a device's newest HISTORICAL version is never deleted;
 *     - at least 2 snapshots per device always remain;
 *     - max 50 deletes per tick (batch keeps transactions short).
 *   RT-011 FK-cascade protection (engine in src/lib/backups/retention.ts):
 *   a snapshot referenced by an OPEN DriftRecord (its current or baseline
 *   snapshot) or by any ConfigBaseline is excluded from the delete set —
 *   the onDelete: Cascade FKs would otherwise silently destroy the open
 *   drift finding / approved baseline on a timer. Interaction with
 *   drift-evaluate: an OPEN record holds the device's latest snapshot; the
 *   next backup demotes it to HISTORICAL, so retention WAITS for the record
 *   to be RESOLVED/ACCEPTED before pruning it (intended semantics — the
 *   excluded ids simply are not deleted this tick and do not consume the
 *   delete budget). Both protection counts are reported in the summary
 *   CONFIG_RETENTION_PRUNED audit afterJson (protectedByOpenDrift /
 *   protectedByBaseline; a zero-delete run that protected rows still writes
 *   the summary). A single summary audit event is written per pruning tick
 *   (never one event per snapshot).
 *
 * Drift scheduling (Task 3-c), after the backup enqueue block:
 *   Every device that HAS an approved ConfigBaseline gets a DRIFT_CHECK
 *   job, deduped: a device with a QUEUED/RUNNING DRIFT_CHECK — or whose
 *   last DRIFT_CHECK finished less than 30 minutes ago — is skipped;
 *   capped at 20 devices per tick. Payload { deviceId, hostname,
 *   triggeredBy: "SCHEDULE" }.
 *
 * Alert evaluation scheduling (Task 5-a), after the drift block:
 *   ONE recurring ALERT_EVALUATION job (SYSTEM target) whenever the last
 *   one finished more than 3 minutes ago and none is queued/running —
 *   repeated ticks can never stack duplicates. The worker claims it and
 *   calls POST /api/v1/alerts/evaluate (evaluate-in-Next).
 *
 * Metric retention scheduling (Task 6-a), after the alert block:
 *   ONE recurring METRIC_RETENTION job per 24 h (daily prune cadence) —
 *   skipped while one is QUEUED/RUNNING or when the last one finished
 *   within the dedupe window. The worker claims it and calls
 *   POST /api/v1/metrics/retention/prune (evaluate-in-Next; a 429
 *   PRUNE_THROTTLED from the 60 s manual-prune guard is a graceful no-op).
 *
 * Rollup aggregation scheduling (RT-002), next to metric retention:
 *   ONE recurring ROLLUP_AGGREGATION job per 5 minutes so fresh 5M buckets
 *   appear promptly — same dedupe shape as METRIC_RETENTION. The worker
 *   claims it and calls POST /api/v1/metrics/rollup/aggregate
 *   (evaluate-in-Next; 429 ROLLUP_THROTTLED = a run is already in flight =
 *   graceful no-op). The aggregation itself is bounded (5,000 bucket
 *   groups / ~20 s per run, oldest-first) and converges over ticks.
 *
 * Protocol queue retention scheduling (RT-003), next to flow retention:
 *   ONE recurring PROTOCOL_QUEUE_RETENTION job per 24 h — the worker
 *   triggers the evaluate-in-Next sweep that prunes terminal DELIVERED/DEAD
 *   ProtocolEventQueue rows (chunked, FlowRecord-guarded). 429
 *   PROTOCOL_QUEUE_PRUNE_THROTTLED from the 60 s guard is a graceful no-op.
 *
 * Stale-job reaper (hardening closeout), after the scheduling blocks:
 *   RUNNING jobs whose startedAt is older than 10 minutes were orphaned
 *   (worker/backend death mid-flight — the in-memory runner state is gone)
 *   and are failed so the Job Center shows the truth. Type-agnostic: every
 *   non-change job has a 30 s worker budget, so 10 minutes without
 *   completion is always a lie. CHANGE_EXECUTE is the one legitimately
 *   long job (worker budget 10 min / ≤40 step calls) and gets a 15-minute
 *   threshold so the reaper can never race a live run. Side-effects: a
 *   reaped ZTP_PROVISION flips its claim provisioning→failed; one summary
 *   JOB_ORPHAN_REAPED audit row per tick. Recovery = jobs/[id]/retry (for
 *   CHANGE_EXECUTE the change-step engine's orphan-step reaper then owns
 *   the rollback-or-fail decision).
 *
 * Returns { enqueued, discoveryEnqueued, driftEnqueued, alertEvalEnqueued,
 * metricRetentionEnqueued, rollupEnqueued, flowRetentionEnqueued,
 * protocolQueueRetentionEnqueued, reapedOrphans, pruned, evaluatedAt,
 * policies }.
 */

const tickSchema = z.object({
  windowSec: z.number().int().min(5).max(3_600).default(65),
});

const PER_POLICY_CAP = 10;
const DEDUPE_WINDOW_MIN = 10;
const DRIFT_CHECK_CAP_PER_TICK = 20;
const DRIFT_CHECK_DEDUPE_MIN = 30;
const ALERT_EVALUATION_DEDUPE_MIN = 3;
const METRIC_RETENTION_DEDUPE_HOURS = 24;
const ROLLUP_DEDUPE_MIN = 5;
const FLOW_RETENTION_DEDUPE_HOURS = 24;
const PROTOCOL_QUEUE_RETENTION_DEDUPE_HOURS = 24;

/* ── tiny 5-field cron matcher ──────────────────────────────────────────── */

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((rawPart) => {
    const part = rawPart.trim();
    if (!part) return false;
    let step = 1;
    let range = part;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r;
      step = Number.parseInt(s, 10);
      if (!Number.isFinite(step) || step < 1) return false;
    }
    if (range === "*" || range === "") {
      return (value - min) % step === 0;
    }
    if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return false;
      if (value < a || value > b) return false;
      return (value - a) % step === 0;
    }
    const n = Number.parseInt(range, 10);
    if (!Number.isFinite(n)) return false;
    if (value < n) return false;
    return (value - n) % step === 0;
  });
}

/** True when `expr` matches the given minute. Invalid expressions never match. */
function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteF, hourF, domF, monthF, dowF] = fields;

  if (!fieldMatches(minuteF, at.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hourF, at.getHours(), 0, 23)) return false;
  if (!fieldMatches(monthF, at.getMonth() + 1, 1, 12)) return false;

  const domRestricted = domF !== "*";
  const dowRestricted = dowF !== "*";
  const domOk = fieldMatches(domF, at.getDate(), 1, 31);
  const dow = dowF === "7" ? "0" : dowF; // allow 7 = Sunday
  const dowOk = fieldMatches(dow, at.getDay(), 0, 6);

  // Vixie-cron semantics: when both day fields are restricted, either may match.
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

/** Due when a matching minute mark falls within (now - windowSec, now]. */
function cronDueWithin(expr: string, windowSec: number, now: Date): boolean {
  const nowMs = now.getTime();
  const endMinute = Math.floor(nowMs / 60_000);
  const startMinute = Math.floor((nowMs - windowSec * 1_000) / 60_000);
  for (let mark = startMinute; mark <= endMinute; mark += 1) {
    if (cronMatches(expr, new Date(mark * 60_000))) return true;
  }
  return false;
}

/* ── continuous discovery scheduling ────────────────────────────────────── */

async function enqueueDiscoveryPolicies(now: Date): Promise<{ enqueued: number; invalid: number }> {
  const policies = await db.discoveryPolicy.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });
  let enqueued = 0;
  let invalid = 0;

  for (const policy of policies) {
    const config = parseStoredDiscoveryPolicy(
      policy.subnetsJson,
      policy.portsJson,
      policy.intervalMinutes,
      policy.enabled,
    );
    if (!config) {
      invalid += 1;
      continue;
    }
    const dueBefore = new Date(now.getTime() - config.intervalMinutes * 60_000);
    const policyTag = "\"policyId\":\"" + policy.id + "\"";
    const active = await db.jobExecution.findFirst({
      where: {
        type: "DISCOVERY",
        status: { in: ["QUEUED", "RUNNING"] },
        payloadJson: { contains: policyTag },
      },
      select: { id: true },
    });
    if (active) continue;

    const queued = await db.$transaction(async (tx) => {
      const claimed = await tx.discoveryPolicy.updateMany({
        where: {
          id: policy.id,
          enabled: true,
          OR: [
            { lastEnqueuedAt: null },
            { lastEnqueuedAt: { lt: dueBefore } },
          ],
        },
        data: { lastEnqueuedAt: now },
      });
      if (claimed.count !== 1) return false;

      const correlationId = newJobCorrelationId();
      const job = await tx.jobExecution.create({
        data: {
          type: "DISCOVERY",
          targetType: "SYSTEM",
          targetId: null,
          status: "QUEUED",
          progress: 0,
          priority: 6,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            policyId: policy.id,
            policyName: policy.name,
            source: "CONTINUOUS",
            subnets: config.subnets,
            ports: config.ports,
          }),
          correlationId,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:worker-scheduler",
          action: "DISCOVERY_QUEUED",
          resourceType: "DiscoveryPolicy",
          resourceId: policy.id,
          resourceLabel: policy.name,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            jobId: job.id,
            policyId: policy.id,
            subnets: config.subnets,
            ports: config.ports,
            intervalMinutes: config.intervalMinutes,
            source: "CONTINUOUS",
          }),
        },
      });
      return true;
    });
    if (queued) enqueued += 1;
  }
  return { enqueued, invalid };
}

/* ── tick handler ───────────────────────────────────────────────────────── */

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = tickSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { windowSec } = parsed.data;
  const now = new Date();

  const policies = await db.backupPolicy.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  let enqueuedTotal = 0;
  const policyResults: Array<Record<string, unknown>> = [];

  for (const policy of policies) {
    const due = cronDueWithin(policy.cronExpr, windowSec, now);
    if (!due) {
      policyResults.push({ id: policy.id, name: policy.name, cron: policy.cronExpr, due: false, enqueued: 0 });
      continue;
    }

    const scope = parsePolicyScope(policy.scopeJson);

    const devices = await db.device.findMany({
      where: scopeDeviceWhere(scope),
      select: { id: true, hostname: true },
      orderBy: { hostname: "asc" },
    });

    const policyTag = `"policyId":"${policy.id}"`;

    // Dedupe (a): devices with an in-flight CONFIG_BACKUP job of any kind.
    const activeJobs = await db.jobExecution.findMany({
      where: {
        type: "CONFIG_BACKUP",
        status: { in: ["QUEUED", "RUNNING"] },
      },
      select: { targetId: true },
    });
    const activeDevices = new Set(activeJobs.map((j) => j.targetId));

    // Dedupe (b): policy-tagged jobs created within the dedupe window
    // (any status) — protects against re-enqueue after fast completion.
    const since = new Date(now.getTime() - DEDUPE_WINDOW_MIN * 60_000);
    const recentJobs = await db.jobExecution.findMany({
      where: {
        type: "CONFIG_BACKUP",
        createdAt: { gte: since },
        payloadJson: { contains: policyTag },
      },
      select: { targetId: true },
    });
    const recentDevices = new Set(recentJobs.map((j) => j.targetId));

    const targets = devices
      .filter((d) => !activeDevices.has(d.id) && !recentDevices.has(d.id))
      .slice(0, PER_POLICY_CAP);

    let count = 0;
    if (targets.length > 0) {
      const res = await db.jobExecution.createMany({
        data: targets.map((d) => ({
          type: "CONFIG_BACKUP",
          targetType: "DEVICE",
          targetId: d.id,
          status: "QUEUED",
          progress: 0,
          priority: 5,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            deviceId: d.id,
            policyId: policy.id,
            policyName: policy.name,
            source: "SCHEDULED",
          }),
          correlationId: newJobCorrelationId(),
        })),
      });
      count = res.count;
    }

    enqueuedTotal += count;
    policyResults.push({
      id: policy.id,
      name: policy.name,
      cron: policy.cronExpr,
      due: true,
      candidates: devices.length,
      enqueued: count,
    });
  }

  const discovery = await enqueueDiscoveryPolicies(now);

  // Drift scheduling (Task 3-c): DRIFT_CHECK for every baseline-covered
  // device, deduped by in-flight / recently-finished DRIFT_CHECK jobs.
  const driftTargets = await enqueueDriftChecks(now);

  // Alert evaluation scheduling (Task 5-a): ONE recurring ALERT_EVALUATION
  // job per dedupe window — the worker runs the evaluate-in-Next engine.
  const alertEvalEnqueued = await enqueueAlertEvaluation(now);

  // Metric retention scheduling (Task 6-a): ONE recurring METRIC_RETENTION
  // job per 24 h — the worker triggers the evaluate-in-Next prune.
  const metricRetentionEnqueued = await enqueueMetricRetention(now);

  // Rollup aggregation scheduling (RT-002): ONE recurring
  // ROLLUP_AGGREGATION job per 5 min — the worker triggers the
  // evaluate-in-Next MetricSample → MetricRollup aggregation pass.
  const rollupEnqueued = await enqueueRollupAggregation(now);

  // Flow retention uses an independent 24-hour policy and bounded prune job.
  const flowRetentionEnqueued = await enqueueFlowRetention(now);

  // Protocol queue retention (RT-003): ONE recurring
  // PROTOCOL_QUEUE_RETENTION job per 24 h — the worker triggers the
  // evaluate-in-Next terminal-row sweep.
  const protocolQueueRetentionEnqueued = await enqueueProtocolQueueRetention(now);

  // Reaper: RUNNING jobs whose startedAt is older than the stale threshold
  // were orphaned (worker crash / backend restart mid-flight — the
  // in-memory runner state is gone) and would otherwise stay RUNNING
  // forever. Type-agnostic by design: every non-change job has a 30 s
  // worker budget, so 10 minutes without completion is always a lie.
  // CHANGE_EXECUTE is the one legitimately long job (worker budget
  // CHANGE_JOB_TIMEOUT_MS = 10 min, ≤40 step calls) — its threshold is 15
  // minutes so the reaper can never race a live run. The Job Center then
  // shows the truth; recovery is the standard jobs/[id]/retry re-enqueue
  // (for CHANGE_EXECUTE the change-step engine's own orphan-step reaper
  // engages on the retry's first step call and rolls back or fails the
  // change — that ownership stays with the engine, deliberately not
  // duplicated here).
  const STALE_RUNNING_MS = 10 * 60_000;
  const STALE_CHANGE_MS = 15 * 60_000;
  const staleJobs = await db.jobExecution.findMany({
    where: {
      status: "RUNNING",
      startedAt: { not: null },
      OR: [
        {
          type: { not: "CHANGE_EXECUTE" },
          startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
        },
        {
          type: "CHANGE_EXECUTE",
          startedAt: { lt: new Date(now.getTime() - STALE_CHANGE_MS) },
        },
      ],
    },
    select: { id: true, type: true, targetId: true },
  });

  let reapedCount = 0;
  let ztpClaimsFailed = 0;
  if (staleJobs.length > 0) {
    // Side-effect: a reaped ZTP_PROVISION leaves its claim wedged in
    // "provisioning" — flip it to "failed" so the ZTP queue tells the truth
    // (no device was created: registration happens at job completion).
    const claimIds = staleJobs
      .filter((j) => j.type === "ZTP_PROVISION" && j.targetId)
      .map((j) => j.targetId as string);
    if (claimIds.length > 0) {
      const claimRes = await db.ztpClaim.updateMany({
        where: { id: { in: claimIds }, status: "provisioning" },
        data: { status: "failed" },
      });
      ztpClaimsFailed = claimRes.count;
    }

    const reapRes = await db.jobExecution.updateMany({
      where: { id: { in: staleJobs.map((j) => j.id) }, status: "RUNNING" },
      data: {
        status: "FAILED",
        progress: 0,
        error: "Orphaned: no worker heartbeat (reaped by scheduler tick)",
        finishedAt: now,
      },
    });
    reapedCount = reapRes.count;

    // SAFE-003 — a reaped job is terminal: release its change's execution
    // lease (deleteMany by the reaped job ids; no-op for non-change jobs).
    if (reapedCount > 0) {
      await db.changeExecutionLease.deleteMany({
        where: { jobId: { in: staleJobs.map((j) => j.id) } },
      });
    }

    if (reapedCount > 0) {
      // One summary audit event per tick (never one row per job) — same
      // pattern as CONFIG_RETENTION_PRUNED below.
      const byType: Record<string, number> = {};
      for (const job of staleJobs) {
        byType[job.type] = (byType[job.type] ?? 0) + 1;
      }
      await db.auditEvent.create({
        data: {
          actorName: "system:worker-scheduler",
          action: "JOB_ORPHAN_REAPED",
          resourceType: "JobExecution",
          result: "SUCCESS",
          correlationId: newCorrelationId("REAP"),
          afterJson: JSON.stringify({
            count: reapedCount,
            byType,
            ztpClaimsFailed,
          }),
        },
      });
    }
  }

  // Retention pruning (Task 3-a) — after enqueue processing, before the
  // response. One console line + one summary audit event per pruning tick.
  const prune = await pruneRetention(policies, now);
  if (prune.pruned > 0) {
    console.log(
      `[tick] retention prune: removed ${prune.pruned} historical snapshot(s) across ${prune.prunedDevices} device(s)`
    );
  }

  return ok({
    enqueued: enqueuedTotal,
    discoveryEnqueued: discovery.enqueued,
    discoveryInvalidPolicies: discovery.invalid,
    driftEnqueued: driftTargets,
    alertEvalEnqueued,
    metricRetentionEnqueued,
    rollupEnqueued,
    flowRetentionEnqueued,
    protocolQueueRetentionEnqueued,
    reapedOrphans: reapedCount,
    pruned: prune.pruned,
    prunedDevices: prune.prunedDevices,
    evaluatedAt: now.toISOString(),
    policies: policyResults,
  });
}

/**
 * Enqueue ONE METRIC_RETENTION job per 24 h (Task 6-a). Dedupe: skip when
 * a METRIC_RETENTION job is QUEUED/RUNNING, or when the last one finished
 * within the daily cadence window. Returns 0 or 1.
 */
async function enqueueMetricRetention(now: Date): Promise<number> {
  const inFlight = await db.jobExecution.findFirst({
    where: {
      type: "METRIC_RETENTION",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - METRIC_RETENTION_DEDUPE_HOURS * 3_600_000),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (inFlight) return 0;

  await db.jobExecution.create({
    data: {
      type: "METRIC_RETENTION",
      targetType: "SYSTEM",
      status: "QUEUED",
      progress: 0,
      priority: 7,
      maxAttempts: 3,
      payloadJson: JSON.stringify({ triggeredBy: "SCHEDULE" }),
      correlationId: newJobCorrelationId(),
    },
  });
  return 1;
}

/**
 * Enqueue ONE ROLLUP_AGGREGATION job per 5 minutes (RT-002). Dedupe: skip
 * when a ROLLUP_AGGREGATION job is QUEUED/RUNNING, or when the last one
 * finished within the 5-minute cadence window. Returns 0 or 1.
 */
async function enqueueRollupAggregation(now: Date): Promise<number> {
  const inFlight = await db.jobExecution.findFirst({
    where: {
      type: "ROLLUP_AGGREGATION",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - ROLLUP_DEDUPE_MIN * 60_000),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (inFlight) return 0;

  await db.jobExecution.create({
    data: {
      type: "ROLLUP_AGGREGATION",
      targetType: "SYSTEM",
      status: "QUEUED",
      progress: 0,
      priority: 7,
      maxAttempts: 3,
      payloadJson: JSON.stringify({ triggeredBy: "SCHEDULE" }),
      correlationId: newJobCorrelationId(),
    },
  });
  return 1;
}

/**
 * Enqueue ONE PROTOCOL_QUEUE_RETENTION job per 24 h (RT-003). Dedupe: skip
 * when a PROTOCOL_QUEUE_RETENTION job is QUEUED/RUNNING, or when the last
 * one finished within the daily cadence window. Returns 0 or 1.
 */
async function enqueueProtocolQueueRetention(now: Date): Promise<number> {
  const recent = await db.jobExecution.findFirst({
    where: {
      type: "PROTOCOL_QUEUE_RETENTION",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - PROTOCOL_QUEUE_RETENTION_DEDUPE_HOURS * 3_600_000),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (recent) return 0;

  await db.jobExecution.create({
    data: {
      type: "PROTOCOL_QUEUE_RETENTION",
      targetType: "SYSTEM",
      status: "QUEUED",
      progress: 0,
      priority: 7,
      maxAttempts: 3,
      payloadJson: JSON.stringify({ triggeredBy: "SCHEDULE" }),
      correlationId: newJobCorrelationId(),
    },
  });
  return 1;
}

async function enqueueFlowRetention(now: Date): Promise<number> {
  const recent = await db.jobExecution.findFirst({
    where: {
      type: "FLOW_RETENTION",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - FLOW_RETENTION_DEDUPE_HOURS * 3_600_000),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (recent) return 0;

  await db.jobExecution.create({
    data: {
      type: "FLOW_RETENTION",
      targetType: "SYSTEM",
      status: "QUEUED",
      progress: 0,
      priority: 7,
      maxAttempts: 3,
      payloadJson: JSON.stringify({ triggeredBy: "SCHEDULE" }),
      correlationId: newJobCorrelationId(),
    },
  });
  return 1;
}

/**
 * Enqueue ONE ALERT_EVALUATION job (Task 5-a). Dedupe: skip when an
 * ALERT_EVALUATION job is QUEUED/RUNNING, or when the last one finished
 * within the 3-minute cadence window. Returns 0 or 1.
 */
async function enqueueAlertEvaluation(now: Date): Promise<number> {
  const inFlight = await db.jobExecution.findFirst({
    where: {
      type: "ALERT_EVALUATION",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - ALERT_EVALUATION_DEDUPE_MIN * 60_000),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (inFlight) return 0;

  await db.jobExecution.create({
    data: {
      type: "ALERT_EVALUATION",
      targetType: "SYSTEM",
      status: "QUEUED",
      progress: 0,
      priority: 6,
      maxAttempts: 3,
      payloadJson: JSON.stringify({ triggeredBy: "SCHEDULE" }),
      correlationId: newJobCorrelationId(),
    },
  });
  return 1;
}

/**
 * Enqueue DRIFT_CHECK jobs for baseline-covered devices (Task 3-c).
 * Dedupe: skip devices with a QUEUED/RUNNING DRIFT_CHECK, or whose last
 * DRIFT_CHECK job finished within the 30-minute window. Returns the number
 * of jobs created.
 */
async function enqueueDriftChecks(now: Date): Promise<number> {
  const baselineDevices = await db.configBaseline.findMany({
    select: { deviceId: true },
    distinct: ["deviceId"],
  });
  if (baselineDevices.length === 0) return 0;

  const deviceIds = baselineDevices.map((b) => b.deviceId);

  const inFlight = await db.jobExecution.findMany({
    where: {
      type: "DRIFT_CHECK",
      OR: [
        { status: { in: ["QUEUED", "RUNNING"] } },
        {
          status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
          finishedAt: {
            gte: new Date(now.getTime() - DRIFT_CHECK_DEDUPE_MIN * 60_000),
          },
        },
      ],
    },
    select: { targetId: true },
  });
  const skip = new Set(
    inFlight.map((j) => j.targetId).filter((id): id is string => Boolean(id))
  );

  const candidates = deviceIds.filter((id) => !skip.has(id));
  if (candidates.length === 0) return 0;

  const devices = await db.device.findMany({
    where: { id: { in: candidates.slice(0, DRIFT_CHECK_CAP_PER_TICK) } },
    select: { id: true, hostname: true },
    orderBy: { hostname: "asc" },
  });
  if (devices.length === 0) return 0;

  const res = await db.jobExecution.createMany({
    data: devices.map((d) => ({
      type: "DRIFT_CHECK",
      targetType: "DEVICE",
      targetId: d.id,
      status: "QUEUED",
      progress: 0,
      priority: 5,
      maxAttempts: 3,
      payloadJson: JSON.stringify({
        deviceId: d.id,
        hostname: d.hostname,
        triggeredBy: "SCHEDULE",
      }),
      correlationId: newJobCorrelationId(),
    })),
  });
  return res.count;
}
