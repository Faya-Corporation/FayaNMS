import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import {
  backtestCapacityModel,
  CAPACITY_MODEL_MIN_POINTS,
  type CapacityModelReport,
} from "@/lib/capacity/regression";
import {
  confidenceFromR2,
  fetchRollups,
  linearRegressionDaily,
  metaFor,
  rangeWindow,
  round1,
} from "@/lib/performance/core";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/performance/capacity (Task 6-a)
 *
 * ?range=7D|30D (default 30D — capacity always reads 1D rollup averages)
 * ?horizonPct=80 (utilization threshold, 5–100)
 * ?horizonDays=90 (display horizon for the UI's forecast shading)
 *
 * Linear (least-squares) forecast per device × metric over 1D rollup
 * averages for CPU, MEMORY and UTILIZATION (combined per day as
 * max(avg UTILIZATION_IN, avg UTILIZATION_OUT)).
 *
 * Per series:
 * - current        = last daily bucket avg
 * - slopePerDay    = least-squares slope (per day, chronological)
 * - daysToThreshold= (horizonPct − current) / slope; null when slope ≤ 0
 *                    (flat or recovering) OR current ≥ horizonPct
 *                    (already above — nothing left to forecast)
 * - r2 / confidence= LOW <0.5 | MEDIUM <0.8 | HIGH ≥0.8
 * - series         = the daily avg points the regression used
 *
 * Population rules (frozen contract): a device×metric series enters the
 * risk pool when current ≥ 40 OR slope > 0 — flat low-utilization series
 * never clutter the list. `risks` is the pool sorted daysToThreshold asc
 * (nulls last), capped at 15. `summary` counts cover the WHOLE pool (not
 * just the top-15 rows): atRisk30d / atRisk90d = series crossing the
 * horizon within 30/90 days, noRisk = the rest (flat, already above, or
 * crossing beyond 90 days).
 *
 * Phase 15-c (additive, backward compatible): every risk row also carries
 * a `model` block from the deterministic ridge-v3 engine
 * (src/lib/capacity/regression.ts) — engine tag, backtest metrics
 * (MAE/RMSE/MAPE/R²), standardized feature weights, the de-standardized
 * trend per day and the backtest window. Series shorter than
 * CAPACITY_MODEL_MIN_POINTS points get `model: null` plus a structured
 * `modelSkipReason` — metrics are never fabricated. The training input is
 * the PUBLISHED (rounded) series, so the client reproduces byte-identical
 * results from `series` alone; v2 fields keep their exact meaning.
 */

const querySchema = z.object({
  range: z.enum(["7D", "30D"]).default("30D"),
  horizonPct: z.coerce.number().min(5).max(100).default(80),
  horizonDays: z.coerce.number().int().min(1).max(365).default(90),
});

/** Minimum daily buckets required for a regression. */
const MIN_POINTS = 5;
/** Series enters the risk pool when current ≥ 40 even with slope ≤ 0. */
const MIN_CURRENT_PCT = 40;
const MAX_RISKS = 15;

const DAY_MS = 86_400_000;

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    range: url.searchParams.get("range") ?? undefined,
    horizonPct: url.searchParams.get("horizonPct") ?? undefined,
    horizonDays: url.searchParams.get("horizonDays") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { range, horizonPct, horizonDays } = parsed.data;

  const days = range === "7D" ? 7 : 30;
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);

  const devices = await db.device.findMany({
    select: { id: true, hostname: true, site: { select: { code: true } } },
    orderBy: { hostname: "asc" },
  });
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const rollups = await fetchRollups("1D", since, [
    "CPU",
    "MEMORY",
    "UTILIZATION_IN",
    "UTILIZATION_OUT",
  ]);

  // deviceId → dayTs → combined UTILIZATION value (max of both directions).
  const utilCombined = new Map<string, Map<number, number>>();
  // deviceId → metric → daily avg points (sorted chronologically later).
  const seriesData = new Map<string, Map<string, Array<{ ts: number; value: number }>>>();

  for (const row of rollups) {
    if (!deviceById.has(row.deviceId)) continue;
    if (row.metric === "UTILIZATION_IN" || row.metric === "UTILIZATION_OUT") {
      let byDay = utilCombined.get(row.deviceId);
      if (!byDay) {
        byDay = new Map();
        utilCombined.set(row.deviceId, byDay);
      }
      byDay.set(row.periodStart.getTime(), Math.max(byDay.get(row.periodStart.getTime()) ?? 0, row.avg));
      continue;
    }
    let byMetric = seriesData.get(row.deviceId);
    if (!byMetric) {
      byMetric = new Map();
      seriesData.set(row.deviceId, byMetric);
    }
    const points = byMetric.get(row.metric) ?? [];
    points.push({ ts: row.periodStart.getTime(), value: row.avg });
    byMetric.set(row.metric, points);
  }

  interface RiskRow {
    deviceId: string;
    hostname: string;
    siteCode: string | null;
    metric: string;
    current: number;
    slopePerDay: number;
    daysToThreshold: number | null;
    r2: number;
    confidence: "LOW" | "MEDIUM" | "HIGH";
    series: Array<{ ts: string; value: number }>;
    /** ridge-v3 model quality — null when the series is too short. */
    model: (CapacityModelReport & { trainedAt: string }) | null;
    /** Why `model` is null (structured so the UI can localize it). */
    modelSkipReason: {
      code: "TOO_SHORT";
      points: number;
      required: number;
    } | null;
    sortKey: number;
  }

  const pool: RiskRow[] = [];

  const consider = (
    device: { id: string; hostname: string; site: { code: string } | null },
    metric: "CPU" | "MEMORY" | "UTILIZATION",
    points: Array<{ ts: number; value: number }>
  ) => {
    if (points.length < MIN_POINTS) return;
    const chronological = [...points].sort((a, b) => a.ts - b.ts);
    const values = chronological.map((p) => p.value);
    const regression = linearRegressionDaily(values);
    if (!regression) return;
    const current = values[values.length - 1];
    const slopePerDay = regression.slopePerDay;

    let daysToThreshold: number | null = null;
    if (slopePerDay > 0 && current < horizonPct) {
      daysToThreshold = (horizonPct - current) / slopePerDay;
    }

    // Risk-pool gate (frozen contract): meaningful current load OR growth.
    if (current < MIN_CURRENT_PCT && slopePerDay <= 0) return;

    // Publish the exact series the models consume (rounded, chronological)
    // so the client-side ridge-v3 refit is byte-identical to the server's.
    const published = chronological.map((p) => ({ ts: p.ts, value: round1(p.value) }));
    const modelReport = backtestCapacityModel(published);

    pool.push({
      deviceId: device.id,
      hostname: device.hostname,
      siteCode: device.site?.code ?? null,
      metric,
      current: round1(current),
      slopePerDay: Math.round(slopePerDay * 1000) / 1000,
      daysToThreshold: daysToThreshold === null ? null : Math.round(daysToThreshold * 10) / 10,
      r2: Math.round(regression.r2 * 1000) / 1000,
      confidence: confidenceFromR2(regression.r2),
      series: published.map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.value })),
      model: modelReport
        ? { ...modelReport, trainedAt: new Date().toISOString() }
        : null,
      modelSkipReason: modelReport
        ? null
        : {
            code: "TOO_SHORT",
            points: published.length,
            required: CAPACITY_MODEL_MIN_POINTS,
          },
      sortKey: daysToThreshold === null ? Number.POSITIVE_INFINITY : daysToThreshold,
    });
  };

  for (const device of devices) {
    const byMetric = seriesData.get(device.id);
    if (byMetric) {
      for (const metric of ["CPU", "MEMORY"] as const) {
        const points = byMetric.get(metric);
        if (!points) continue;
        consider(device, metric, points);
      }
    }
    const utilByDay = utilCombined.get(device.id);
    if (utilByDay && utilByDay.size > 0) {
      consider(device, "UTILIZATION", [...utilByDay.entries()].map(([ts, value]) => ({ ts, value })));
    }
  }

  pool.sort((a, b) => a.sortKey - b.sortKey);

  const summary = {
    atRisk30d: pool.filter((r) => r.daysToThreshold !== null && r.daysToThreshold <= 30).length,
    atRisk90d: pool.filter((r) => r.daysToThreshold !== null && r.daysToThreshold <= 90).length,
    noRisk: pool.filter((r) => r.daysToThreshold === null || r.daysToThreshold > 90).length,
  };

  const risks = pool.slice(0, MAX_RISKS).map(({ sortKey: _sortKey, ...rest }) => rest);

  return ok(
    {
      forecastModel: "LINEAR",
      horizonPct,
      risks,
      summary,
    },
    metaFor(range, "1D")
  );
}
