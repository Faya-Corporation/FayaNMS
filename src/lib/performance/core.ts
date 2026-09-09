/**
 * Performance module — shared range/statistics helpers (Task 6-a).
 *
 * The FROZEN API contract (see /api/v1/performance/* routes) maps the
 * user-facing `range` parameter onto MetricRollup granularity:
 *
 *   range  preferred granularity   window
 *   1H     5M (fallback 1H)        last 1 hour
 *   24H    1H                      last 24 hours
 *   7D     1H                      last 7 days
 *   30D    1D                      last 30 days
 *
 * The seed (prisma/seed.ts) writes 1H rollups for 7 days and 1D rollups for
 * 30 days; no 5M rollups exist yet, so the 1H range falls back to 1H
 * rollups — `meta.granularity` always reports the granularity actually
 * served. Everything here is pure except the two thin db helpers at the
 * bottom.
 */

import { z } from "zod";
import { db } from "@/lib/db";

/* ───────────────────────────── ranges ───────────────────────────── */

export const PERFORMANCE_RANGES = ["1H", "24H", "7D", "30D"] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

export type RollupGranularity = "5M" | "1H" | "1D";

export const rangeSchema = z.enum(PERFORMANCE_RANGES).default("24H");

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface RangeWindow {
  range: PerformanceRange;
  /** Granularity the contract prescribes for this range. */
  preferredGranularity: RollupGranularity;
  /** Window start. */
  since: Date;
  /** Bucket width in ms (5M=300_000, 1H=3_600_000, 1D=86_400_000). */
  bucketMs: number;
}

export function rangeWindow(range: PerformanceRange, now = new Date()): RangeWindow {
  switch (range) {
    case "1H":
      return { range, preferredGranularity: "5M", since: new Date(now.getTime() - 1 * HOUR_MS), bucketMs: 5 * 60_000 };
    case "24H":
      return { range, preferredGranularity: "1H", since: new Date(now.getTime() - 24 * HOUR_MS), bucketMs: HOUR_MS };
    case "7D":
      return { range, preferredGranularity: "1H", since: new Date(now.getTime() - 7 * DAY_MS), bucketMs: HOUR_MS };
    case "30D":
      return { range, preferredGranularity: "1D", since: new Date(now.getTime() - 30 * DAY_MS), bucketMs: DAY_MS };
  }
}

/**
 * Resolve the granularity actually served. The 1H range prefers 5M rollups
 * and falls back to 1H when none exist in the window (the seed writes no
 * 5M rows). Reported through meta.granularity so the UI never guesses.
 */
export async function resolveGranularity(win: RangeWindow): Promise<RollupGranularity> {
  if (win.preferredGranularity !== "5M") return win.preferredGranularity;
  const count = await db.metricRollup.count({
    where: { granularity: "5M", periodStart: { gte: win.since } },
  });
  return count > 0 ? "5M" : "1H";
}

/** Frozen-contract meta block shared by every performance/metrics response. */
export function metaFor(
  range: PerformanceRange,
  granularity: string
): { range: PerformanceRange; granularity: string; generatedAt: string } {
  return { range, granularity, generatedAt: new Date().toISOString() };
}

/* ───────────────────────────── statistics ───────────────────────────── */

export const round1 = (v: number): number => Math.round(v * 10) / 10;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank p95 (same definition as the seed's p95 helper). */
export function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

/* ───────────────────────────── rollup access ───────────────────────────── */

export interface RollupRow {
  deviceId: string;
  metric: string;
  periodStart: Date;
  avg: number;
  max: number;
  min: number;
  p95: number;
}

/**
 * Fetch rollup rows for the given granularity/window/metrics. The
 * @@unique([deviceId, metric, granularity, periodStart]) index keeps this
 * a bounded, per-bucket read; result volume is capped by the range map
 * above (≤ ~24k rows for 7D × 6 metrics on the demo fleet).
 */
export async function fetchRollups(
  granularity: RollupGranularity,
  since: Date,
  metrics: string[]
): Promise<RollupRow[]> {
  if (metrics.length === 0) return [];
  const rows = await db.metricRollup.findMany({
    where: {
      granularity,
      metric: { in: metrics },
      periodStart: { gte: since },
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
  return rows;
}

/**
 * Group rollup rows into per-device, per-metric bucket series keyed by
 * epoch-ms periodStart: Map<deviceId, Map<metric, Map<bucketTs, row>>>.
 */
export function groupRollups(
  rows: RollupRow[]
): Map<string, Map<string, Map<number, RollupRow>>> {
  const out = new Map<string, Map<string, Map<number, RollupRow>>>();
  for (const row of rows) {
    let byDevice = out.get(row.deviceId);
    if (!byDevice) {
      byDevice = new Map();
      out.set(row.deviceId, byDevice);
    }
    let byMetric = byDevice.get(row.metric);
    if (!byMetric) {
      byMetric = new Map();
      byDevice.set(row.metric, byMetric);
    }
    byMetric.set(row.periodStart.getTime(), row);
  }
  return out;
}

/* ───────────────────────────── regression ───────────────────────────── */

export interface Regression {
  /** Slope per day (x axis = chronological day index). */
  slopePerDay: number;
  intercept: number;
  r2: number;
}

/**
 * Least-squares linear regression over y values sampled at equal daily
 * spacing (x = 0..n-1 chronological). r2 uses 1 − SSres/SStot; a perfectly
 * flat series (zero variance) is reported as r2 = 1 (the flat line is an
 * exact fit).
 */
export function linearRegressionDaily(values: number[]): Regression | null {
  const n = values.length;
  if (n < 2) return null;
  const sumX = ((n - 1) * n) / 2;
  const sumY = values.reduce((a, b) => a + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (i - meanX) ** 2;
    sxy += (i - meanX) * (values[i] - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  return { slopePerDay: slope, intercept, r2 };
}

/** Confidence band from r² (frozen contract: LOW <0.5, MEDIUM <0.8, HIGH ≥0.8). */
export function confidenceFromR2(r2: number): "LOW" | "MEDIUM" | "HIGH" {
  if (r2 >= 0.8) return "HIGH";
  if (r2 >= 0.5) return "MEDIUM";
  return "LOW";
}
