/**
 * Metric retention configuration (Task 6-a) — shared between
 * GET/PUT /api/v1/metrics/retention and POST /api/v1/metrics/retention/prune
 * and the METRIC_RETENTION worker job.
 *
 * The whole policy lives in ONE Setting row (key "metrics.retention",
 * valueJson):
 * {
 *   raw:      { days, enabled },   // raw MetricSample window
 *   rollup5M: { days, enabled },   // 5-minute rollup window (days ≤ 30)
 *   rollup1H: { days, enabled },   // hourly rollup window
 *   rollup1D: { days, enabled },   // daily rollup window
 *   lastPrunedAt: ISO | null,      // written by the prune endpoint
 *   lastPruneResult: object | null // written by the prune endpoint
 * }
 *
 * Defaults when unset: raw 14d, 5M 3d, 1H 90d, 1D 365d — all enabled.
 * The 5M window is capped at 30 days: 5-minute rollups derive from raw
 * samples, so retaining them longer than ~a month is pure storage cost
 * (the "raw granularity math guard" from the Phase 6 contract).
 */

import { z } from "zod";
import { db } from "@/lib/db";

export const METRICS_RETENTION_KEY = "metrics.retention";

/**
 * RT-015 (F-017): the retention prune deletes in bounded chunks instead of
 * one unbounded DELETE — a first run after enabling (or after a gap) would
 * otherwise delete millions of rows in a single statement (long transaction,
 * lock pressure, vacuum bloat). Same pattern as FLOW_RETENTION
 * (src/lib/flows/retention.ts + the flow prune route).
 */
export const METRIC_RETENTION_CHUNK_SIZE = 1_000;
export const METRIC_RETENTION_MAX_DELETES_PER_RUN = 50_000;

/**
 * Chunked delete of aged MetricSample rows (≤ CHUNK per statement, ≤
 * MAX per run). The ts guard is repeated on every deleteMany (CAS spirit —
 * a row is only ever deleted while it still matches the retention cutoff).
 * Returns the number of rows actually deleted; a remaining backlog is
 * converged by the NEXT prune run (the 60 s throttle and daily
 * METRIC_RETENTION job make room in between).
 */
export async function pruneMetricSamplesChunked(cutoff: Date): Promise<number> {
  const batches = METRIC_RETENTION_MAX_DELETES_PER_RUN / METRIC_RETENTION_CHUNK_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const rows = await db.metricSample.findMany({
      where: { ts: { lt: cutoff } },
      orderBy: [{ ts: "asc" }, { id: "asc" }],
      take: METRIC_RETENTION_CHUNK_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) break;
    deleted += (
      await db.metricSample.deleteMany({
        where: { id: { in: rows.map((row) => row.id) }, ts: { lt: cutoff } },
      })
    ).count;
  }
  return deleted;
}

/**
 * Chunked delete of aged MetricRollup rows for ONE granularity (served by
 * the RT-015 (granularity, metric, periodStart) index). Same bounds and
 * convergence contract as pruneMetricSamplesChunked.
 */
export async function pruneMetricRollupsChunked(
  granularity: "5M" | "1H" | "1D",
  cutoff: Date
): Promise<number> {
  const batches = METRIC_RETENTION_MAX_DELETES_PER_RUN / METRIC_RETENTION_CHUNK_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const rows = await db.metricRollup.findMany({
      where: { granularity, periodStart: { lt: cutoff } },
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      take: METRIC_RETENTION_CHUNK_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) break;
    deleted += (
      await db.metricRollup.deleteMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          granularity,
          periodStart: { lt: cutoff },
        },
      })
    ).count;
  }
  return deleted;
}

export interface RetentionSection {
  days: number;
  enabled: boolean;
}

export interface RetentionConfig {
  raw: RetentionSection;
  rollup5M: RetentionSection;
  rollup1H: RetentionSection;
  rollup1D: RetentionSection;
}

export interface StoredRetention extends RetentionConfig {
  lastPrunedAt: string | null;
  lastPruneResult: Record<string, unknown> | null;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  raw: { days: 14, enabled: true },
  rollup5M: { days: 3, enabled: true },
  rollup1H: { days: 90, enabled: true },
  rollup1D: { days: 365, enabled: true },
};

/** Contract response shape: config + prune bookkeeping. */
export interface RetentionView extends RetentionConfig {
  lastPrunedAt: string | null;
  lastPruneResult: Record<string, unknown> | null;
}

/** Zod schema for one full retention section. */
export const retentionSectionSchema = z.object({
  days: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
});

/** Zod schema for a partial section update (PUT body). */
export const partialSectionSchema = z.object({
  days: z.number().int().min(1).max(3650).optional(),
  enabled: z.boolean().optional(),
});

/** Parse the stored Setting into a fully-defaulted view. Never throws. */
export function parseStoredRetention(valueJson: string | null | undefined): RetentionView {
  const view: RetentionView = {
    ...DEFAULT_RETENTION,
    lastPrunedAt: null,
    lastPruneResult: null,
  };
  if (!valueJson) return view;
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return view;
    const obj = parsed as Record<string, unknown>;
    for (const section of ["raw", "rollup5M", "rollup1H", "rollup1D"] as const) {
      const value = obj[section];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const s = value as Record<string, unknown>;
        const days = Number(s.days);
        if (Number.isFinite(days) && days >= 1) view[section].days = Math.floor(days);
        if (typeof s.enabled === "boolean") view[section].enabled = s.enabled;
      }
    }
    if (typeof obj.lastPrunedAt === "string") view.lastPrunedAt = obj.lastPrunedAt;
    if (obj.lastPruneResult && typeof obj.lastPruneResult === "object" && !Array.isArray(obj.lastPruneResult)) {
      view.lastPruneResult = obj.lastPruneResult as Record<string, unknown>;
    }
    return view;
  } catch {
    return view;
  }
}

/** Read the retention Setting row (null when missing). */
export async function readRetentionSetting() {
  return db.setting.findUnique({ where: { key: METRICS_RETENTION_KEY } });
}

/** Read the current effective retention view (defaults merged). */
export async function readRetentionView(): Promise<RetentionView> {
  const row = await readRetentionSetting();
  return parseStoredRetention(row?.valueJson);
}

/**
 * Merge a partial PUT payload (validated) onto the stored config and
 * return the full StoredRetention shape ready to serialize.
 * Guard: the merged rollup5M window may not exceed 30 days.
 */
export function mergeRetention(
  stored: RetentionView,
  patch: {
    raw?: { days?: number; enabled?: boolean };
    rollup5M?: { days?: number; enabled?: boolean };
    rollup1H?: { days?: number; enabled?: boolean };
    rollup1D?: { days?: number; enabled?: boolean };
  }
): { merged: RetentionView; rollup5MDays: number } {
  const merged: RetentionView = {
    raw: { ...stored.raw },
    rollup5M: { ...stored.rollup5M },
    rollup1H: { ...stored.rollup1H },
    rollup1D: { ...stored.rollup1D },
    lastPrunedAt: stored.lastPrunedAt,
    lastPruneResult: stored.lastPruneResult,
  };
  for (const section of ["raw", "rollup5M", "rollup1H", "rollup1D"] as const) {
    const p = patch[section];
    if (!p) continue;
    if (p.days !== undefined) merged[section].days = p.days;
    if (p.enabled !== undefined) merged[section].enabled = p.enabled;
  }
  return { merged, rollup5MDays: merged.rollup5M.days };
}
