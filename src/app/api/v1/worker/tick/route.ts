import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, newJobCorrelationId, ok } from "../../_lib/api";
import {
  parsePolicyScope,
  scopeDeviceWhere,
  type ParsedPolicyScope,
} from "../../_lib/scope";
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
 *     - max 50 deletes per tick (batch keeps transactions short on SQLite).
 *   A single summary CONFIG_RETENTION_PRUNED audit event is written per
 *   tick when rows were pruned (never one event per snapshot).
 *
 * Drift scheduling (Task 3-c), after the backup enqueue block:
 *   Every device that HAS an approved ConfigBaseline gets a DRIFT_CHECK
 *   job, deduped: a device with a QUEUED/RUNNING DRIFT_CHECK — or whose
 *   last DRIFT_CHECK finished less than 30 minutes ago — is skipped;
 *   capped at 20 devices per tick. Payload { deviceId, hostname,
 *   triggeredBy: "SCHEDULE" }.
 *
 * Returns { enqueued, driftEnqueued, reapedOrphans, pruned, evaluatedAt, policies }.
 */

const tickSchema = z.object({
  windowSec: z.number().int().min(5).max(3_600).default(65),
});

const PER_POLICY_CAP = 10;
const DEDUPE_WINDOW_MIN = 10;
const PRUNE_MAX_DELETES_PER_TICK = 50;
const PRUNE_MIN_SNAPSHOTS_PER_DEVICE = 2;
const DRIFT_CHECK_CAP_PER_TICK = 20;
const DRIFT_CHECK_DEDUPE_MIN = 30;

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

/* ── retention pruning ──────────────────────────────────────────────────── */

interface PruneOutcome {
  pruned: number;
  prunedDevices: number;
}

/**
 * Prune HISTORICAL snapshots older than each scoped device's retention
 * window. See the route header for the safety caps. Returns the number of
 * rows deleted (0 when nothing was due for pruning).
 */
async function pruneRetention(
  policies: Array<{ id: string; retentionDays: number; scopeJson: string }>,
  now: Date
): Promise<PruneOutcome> {
  if (policies.length === 0) return { pruned: 0, prunedDevices: 0 };

  // Per-device retention window. Devices scoped by several policies keep
  // the longest window (most generous retention wins).
  const cutoffs = new Map<string, Date>();
  for (const policy of policies) {
    const scope: ParsedPolicyScope = parsePolicyScope(policy.scopeJson);
    const scoped = await db.device.findMany({
      where: scopeDeviceWhere(scope),
      select: { id: true },
    });
    const cutoff = new Date(
      now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000
    );
    for (const device of scoped) {
      const existing = cutoffs.get(device.id);
      if (!existing || cutoff < existing) {
        cutoffs.set(device.id, cutoff);
      }
    }
  }
  if (cutoffs.size === 0) return { pruned: 0, prunedDevices: 0 };

  // Cheap per-device totals in one grouped query (deviceId index).
  const totals = await db.configSnapshot.groupBy({
    by: ["deviceId"],
    _count: { _all: true },
    where: { deviceId: { in: Array.from(cutoffs.keys()) } },
  });
  const totalByDevice = new Map<string, number>(
    totals.map((row) => [row.deviceId, row._count._all])
  );

  const deleteIds: string[] = [];
  const touchedDevices = new Set<string>();

  for (const [deviceId, cutoff] of cutoffs) {
    if (deleteIds.length >= PRUNE_MAX_DELETES_PER_TICK) break;
    const total = totalByDevice.get(deviceId) ?? 0;
    // Hard safety cap: always keep at least 2 snapshots on the device.
    const maxDeletable = total - PRUNE_MIN_SNAPSHOTS_PER_DEVICE;
    if (maxDeletable <= 0) continue;

    const budget = Math.min(
      PRUNE_MAX_DELETES_PER_TICK - deleteIds.length,
      maxDeletable
    );
    const candidates = await db.configSnapshot.findMany({
      where: {
        deviceId,
        status: "HISTORICAL",
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: "desc" },
      take: budget + 1,
      select: { id: true, createdAt: true },
    });
    if (candidates.length === 0) continue;

    // Never delete the device's newest HISTORICAL version: when a newer
    // HISTORICAL row exists above the cutoff the global newest is outside
    // this candidate list; otherwise candidates[0] IS the newest HISTORICAL.
    const hasRecentHistorical =
      (await db.configSnapshot.count({
        where: {
          deviceId,
          status: "HISTORICAL",
          createdAt: { gte: cutoff },
        },
      })) > 0;
    const deletable = hasRecentHistorical ? candidates : candidates.slice(1);

    for (const row of deletable) {
      if (deleteIds.length >= PRUNE_MAX_DELETES_PER_TICK) break;
      deleteIds.push(row.id);
      touchedDevices.add(deviceId);
    }
  }

  if (deleteIds.length === 0) return { pruned: 0, prunedDevices: 0 };

  // One short interactive transaction: the delete is guarded by
  // status = HISTORICAL so a snapshot promoted to BASELINE mid-flight
  // (e.g. baseline approval) is never destroyed.
  const result = await db.$transaction(
    async (tx) => {
      const deleted = await tx.configSnapshot.deleteMany({
        where: { id: { in: deleteIds }, status: "HISTORICAL" },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action: "CONFIG_RETENTION_PRUNED",
          resourceType: "ConfigSnapshot",
          result: "SUCCESS",
          correlationId: newCorrelationId("RET"),
          afterJson: JSON.stringify({
            count: deleted.count,
            devices: touchedDevices.size,
            policies: policies.length,
          }),
        },
      });
      return deleted;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return { pruned: result.count, prunedDevices: touchedDevices.size };
}

/* ── tick handler ───────────────────────────────────────────────────────── */

export async function POST(request: Request) {
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

  // Drift scheduling (Task 3-c): DRIFT_CHECK for every baseline-covered
  // device, deduped by in-flight / recently-finished DRIFT_CHECK jobs.
  const driftTargets = await enqueueDriftChecks(now);

  // Reaper: RUNNING CONFIG_BACKUP/DISCOVERY/DRIFT_CHECK jobs whose startedAt is older
  // than 10 minutes were orphaned (server crash, worker restart mid-flight —
  // the in-memory runner state is gone) and would otherwise stay RUNNING
  // forever. Fail them so the Job Center shows the truth; retries happen
  // through normal re-enqueue (manual backup-now or the next scheduler tick).
  const STALE_RUNNING_MS = 10 * 60_000;
  const reaped = await db.jobExecution.updateMany({
    where: {
      type: { in: ["CONFIG_BACKUP", "DISCOVERY", "DRIFT_CHECK"] },
      status: "RUNNING",
      startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
    },
    data: {
      status: "FAILED",
      progress: 0,
      error: "Orphaned: no worker heartbeat for over 10 minutes (reaped by scheduler tick)",
      finishedAt: now,
    },
  });

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
    driftEnqueued: driftTargets,
    reapedOrphans: reaped.count,
    pruned: prune.pruned,
    prunedDevices: prune.prunedDevices,
    evaluatedAt: now.toISOString(),
    policies: policyResults,
  });
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
