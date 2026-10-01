/**
 * MetricRollup runtime producer (RT-002 / F-002) — the missing half of
 * ADR-07's "raw samples + rollups" pipeline.
 *
 * Until now `MetricRollup` had exactly one writer (the demo seed), so every
 * 24H/7D/30D performance view, the capacity forecast, the availability and
 * CAPACITY reports and the dashboard utilization trend read seed-only or
 * empty data, and metric retention then pruned the seed rows away. This
 * module aggregates raw MetricSamples into MetricRollup buckets at runtime,
 * driven by a ROLLUP_AGGREGATION job every 5 minutes (tick scheduler →
 * worker → POST /api/v1/metrics/rollup/aggregate — evaluate-in-Next, same
 * architecture as METRIC_RETENTION / ALERT_EVALUATION).
 *
 * Semantics:
 *   - Granularities 5M (300 s), 1H (3600 s), 1D (86400 s); periodStart is
 *     UTC-aligned (epoch floor division) and a bucket is aggregated only
 *     once its window has fully closed (periodStart + window ≤ now).
 *   - Per (deviceId, metric, bucket): avg (arithmetic mean over the raw
 *     values), max, min and nearest-rank p95 — the same definitions as the
 *     seed and src/lib/performance/core.ts.
 *   - Persisted with metricRollup.upsert on the natural key
 *     @@unique([deviceId, metric, granularity, periodStart]) — re-running a
 *     period recomputes and overwrites, never blind-creates (idempotent).
 *     Buckets whose stored stats already match are NOT rewritten, so the
 *     bounded oldest-first loop makes steady progress and a large backfill
 *     converges over consecutive ticks (`remaining` reports what is left).
 *   - Bounded work per run: at most ROLLUP_MAX_GROUPS_PER_RUN bucket groups
 *     and a ~20 s wall-clock budget, whichever comes first; the run then
 *     reports bounded=true so the next scheduled run continues.
 *   - Exactly ONE summary audit row per run (ROLLUP_AGGREGATION_COMPLETED,
 *     RET-style correlation) — never one row per bucket.
 *
 * The first run after deploy is the backfill: it walks the retained raw
 * window (metric retention bounds the MetricSample table) oldest-first over
 * as many ticks as the cap requires. No migration needed; seeded demo rollup
 * rows simply stay until a recomputation overwrites them with real numbers.
 */

import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";
import {
  percentile95,
  type RollupGranularity,
} from "@/lib/performance/core";

export const ROLLUP_GRANULARITIES = ["5M", "1H", "1D"] as const satisfies readonly RollupGranularity[];

/** Bucket width per granularity in ms. */
const GRANULARITY_WINDOW_MS: Record<RollupGranularity, number> = {
  "5M": 300_000,
  "1H": 3_600_000,
  "1D": 86_400_000,
};

/** Bounded work: at most this many bucket groups are persisted per run. */
export const ROLLUP_MAX_GROUPS_PER_RUN = 5_000;
/** Bounded work: wall-clock budget per run (whichever limit hits first). */
const ROLLUP_TIME_BUDGET_MS = 20_000;

export interface RollupSummary {
  ranAt: string;
  triggeredBy: string;
  /** Closed bucket groups discovered from the raw samples. */
  groupsComputed: number;
  /** Bucket groups actually written this run (upserts). */
  groupsUpserted: number;
  /** Changed groups left behind for the next scheduled run. */
  remaining: number;
  /** True when the run stopped at the group cap or the time budget. */
  bounded: boolean;
  /** Upserts per granularity (5M/1H/1D). */
  byGranularity: Record<string, number>;
  durationMs: number;
}

interface SampleRow {
  deviceId: string;
  metric: string;
  value: number;
  ts: Date;
}

interface BucketGroup {
  deviceId: string;
  metric: string;
  granularity: RollupGranularity;
  periodStartMs: number;
  values: number[];
  /** Stored row already matches the computed stats — no write needed. */
  unchanged: boolean;
}

/** UTC-aligned bucket start for a sample timestamp (pure). */
export function rollupBucketStart(tsMs: number, granularity: RollupGranularity): number {
  const windowMs = GRANULARITY_WINDOW_MS[granularity];
  return Math.floor(tsMs / windowMs) * windowMs;
}

/** A bucket is closed once its window end has fully passed (pure). */
export function isBucketClosed(
  periodStartMs: number,
  granularity: RollupGranularity,
  nowMs: number
): boolean {
  return periodStartMs + GRANULARITY_WINDOW_MS[granularity] <= nowMs;
}

function maxOf(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a), values[0] ?? 0);
}

function minOf(values: number[]): number {
  return values.reduce((a, b) => (b < a ? b : a), values[0] ?? 0);
}

function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function minOfList(values: number[]): number {
  return values.reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
}

function maxOfList(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY);
}

const groupKey = (deviceId: string, metric: string, periodStartMs: number): string =>
  `${deviceId}|${metric}|${periodStartMs}`;

/**
 * Aggregate closed MetricSample buckets into MetricRollup. Options:
 *   - now:         evaluation clock (defaults to now — injectable for tests)
 *   - triggeredBy: "JOB" | "SCHEDULE" → system actor, anything else → Admin
 *   - deviceIds:   optional scope (hermetic runs / targeted backfills)
 *   - maxGroups:   optional tighter per-run cap (defaults to 5,000)
 */
export async function runRollupAggregation(
  opts: {
    now?: Date;
    triggeredBy?: string;
    deviceIds?: string[];
    maxGroups?: number;
  } = {}
): Promise<RollupSummary> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const triggeredBy = opts.triggeredBy ?? "MANUAL";
  const maxGroups = opts.maxGroups ?? ROLLUP_MAX_GROUPS_PER_RUN;
  const startedAt = Date.now();

  const summary: RollupSummary = {
    ranAt: now.toISOString(),
    triggeredBy,
    groupsComputed: 0,
    groupsUpserted: 0,
    remaining: 0,
    bounded: false,
    byGranularity: { "5M": 0, "1H": 0, "1D": 0 },
    durationMs: 0,
  };

  /* ── one bounded read of the raw samples (retention bounds the table) ── */
  const samples: SampleRow[] = await db.metricSample.findMany({
    where: {
      ts: { lt: now },
      ...(opts.deviceIds && opts.deviceIds.length > 0
        ? { deviceId: { in: opts.deviceIds } }
        : {}),
    },
    select: { deviceId: true, metric: true, value: true, ts: true },
    orderBy: { ts: "asc" },
  });

  /* ── group into closed buckets per granularity ──────────────────────── */
  const groupsByGranularity = new Map<RollupGranularity, Map<string, BucketGroup>>();
  for (const granularity of ROLLUP_GRANULARITIES) {
    groupsByGranularity.set(granularity, new Map());
  }
  for (const sample of samples) {
    const tsMs = sample.ts.getTime();
    for (const granularity of ROLLUP_GRANULARITIES) {
      const periodStartMs = rollupBucketStart(tsMs, granularity);
      if (!isBucketClosed(periodStartMs, granularity, nowMs)) continue;
      const byKey = (groupsByGranularity.get(granularity) as Map<string, BucketGroup>);
      const key = groupKey(sample.deviceId, sample.metric, periodStartMs);
      const group = byKey.get(key);
      if (group) group.values.push(sample.value);
      else byKey.set(key, {
        deviceId: sample.deviceId,
        metric: sample.metric,
        granularity,
        periodStartMs,
        values: [sample.value],
        unchanged: false,
      });
    }
  }

  const allGroups: BucketGroup[] = [];
  for (const byKey of groupsByGranularity.values()) {
    allGroups.push(...byKey.values());
  }
  summary.groupsComputed = allGroups.length;
  if (allGroups.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    await writeSummaryAudit(summary);
    return summary;
  }

  /* ── skip buckets whose stored stats already match (convergence) ────── */
  for (const granularity of ROLLUP_GRANULARITIES) {
    const byKey = groupsByGranularity.get(granularity) as Map<string, BucketGroup>;
    if (byKey.size === 0) continue;
    const groups = [...byKey.values()];
    const deviceIds = [...new Set(groups.map((g) => g.deviceId))];
    const metrics = [...new Set(groups.map((g) => g.metric))];
    const starts = groups.map((g) => g.periodStartMs);
    const stored = await db.metricRollup.findMany({
      where: {
        granularity,
        deviceId: { in: deviceIds },
        metric: { in: metrics },
        periodStart: {
          gte: new Date(minOfList(starts)),
          lte: new Date(maxOfList(starts)),
        },
      },
      select: {
        deviceId: true,
        metric: true,
        periodStart: true,
        avg: true,
        max: true,
        min: true,
        p95: true,
      },
    });
    for (const row of stored) {
      const group = byKey.get(
        groupKey(row.deviceId, row.metric, row.periodStart.getTime())
      );
      if (!group) continue;
      if (
        row.avg === meanOf(group.values) &&
        row.max === maxOf(group.values) &&
        row.min === minOf(group.values) &&
        row.p95 === percentile95(group.values)
      ) {
        group.unchanged = true;
      }
    }
  }

  /* ── oldest-first, bounded persistence ──────────────────────────────── */
  const pending = allGroups
    .filter((g) => !g.unchanged)
    .sort(
      (a, b) =>
        a.periodStartMs - b.periodStartMs ||
        GRANULARITY_WINDOW_MS[a.granularity] - GRANULARITY_WINDOW_MS[b.granularity] ||
        a.deviceId.localeCompare(b.deviceId) ||
        a.metric.localeCompare(b.metric)
    );

  for (const group of pending) {
    if (summary.groupsUpserted >= maxGroups || Date.now() - startedAt > ROLLUP_TIME_BUDGET_MS) {
      summary.bounded = true;
      break;
    }
    const avg = meanOf(group.values);
    const stats = {
      avg,
      max: maxOf(group.values),
      min: minOf(group.values),
      p95: percentile95(group.values),
    };
    await db.metricRollup.upsert({
      where: {
        deviceId_metric_granularity_periodStart: {
          deviceId: group.deviceId,
          metric: group.metric,
          granularity: group.granularity,
          periodStart: new Date(group.periodStartMs),
        },
      },
      create: {
        deviceId: group.deviceId,
        metric: group.metric,
        granularity: group.granularity,
        periodStart: new Date(group.periodStartMs),
        ...stats,
      },
      update: stats,
    });
    summary.groupsUpserted += 1;
    summary.byGranularity[group.granularity] += 1;
  }
  summary.remaining = Math.max(pending.length - summary.groupsUpserted, 0);
  summary.durationMs = Date.now() - startedAt;

  await writeSummaryAudit(summary);
  return summary;
}

/** Exactly one summary audit row per run (never one per bucket). */
async function writeSummaryAudit(summary: RollupSummary): Promise<void> {
  await db.auditEvent.create({
    data: {
      actorName:
        summary.triggeredBy === "JOB" || summary.triggeredBy === "SCHEDULE"
          ? "system:metrics-worker"
          : "Admin",
      action: "ROLLUP_AGGREGATION_COMPLETED",
      resourceType: "MetricRollup",
      resourceLabel: "Metric rollup aggregation",
      result: "SUCCESS",
      correlationId: newCorrelationId("RET"),
      afterJson: JSON.stringify({
        ranAt: summary.ranAt,
        triggeredBy: summary.triggeredBy,
        groupsComputed: summary.groupsComputed,
        groupsUpserted: summary.groupsUpserted,
        remaining: summary.remaining,
        bounded: summary.bounded,
        byGranularity: summary.byGranularity,
        durationMs: summary.durationMs,
      }),
    },
  });
}
