import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../_lib/api";
import {
  fetchRollups,
  mean,
  metaFor,
  percentile95,
  rangeSchema,
  rangeWindow,
  resolveGranularity,
  round1,
} from "@/lib/performance/core";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/performance/devices (Task 6-a)
 *
 * ?metric=CPU|MEMORY|LATENCY_MS|PACKET_LOSS|UTILIZATION (default CPU)
 * ?range=1H|24H|7D|30D (default 24H)  ?siteCode=  ?q=  ?page=  ?pageSize=
 *
 * Per-device performance table. Bucket statistics (avg/max/p95/trend/
 * deltaPct) come from MetricRollup rows at the range's granularity (1H
 * range prefers 5M rollups, falls back to 1H — meta.granularity reports
 * what was served); `latest` is the freshest RAW MetricSample inside the
 * window (falls back to the newest bucket avg when a device has no raw
 * samples in the window).
 *
 * metric=UTILIZATION combines the two directions: per bucket the value is
 * max(avg UTILIZATION_IN, avg UTILIZATION_OUT) — the worse direction wins
 * — and the same combination applies to `latest`, `max` and `trend`, so
 * every column ranks the same combined series.
 *
 * - avg       = mean of bucket avgs
 * - max       = max of bucket maxes (true peak within the range)
 * - p95       = nearest-rank p95 of bucket avgs
 * - deltaPct  = (last bucket avg − first bucket avg) / first bucket avg × 100
 *               (0 when the first bucket is 0 — percentage change from a
 *               zero baseline is undefined)
 * - trend     = last ≤24 bucket avgs, chronological (sparkline input)
 * - sorted by latest.value desc, server-side pagination over the fleet
 */

const METRICS = ["CPU", "MEMORY", "LATENCY_MS", "PACKET_LOSS", "UTILIZATION"] as const;
type DeviceMetric = (typeof METRICS)[number];

const querySchema = z.object({
  metric: z.enum(METRICS).default("CPU"),
  range: rangeSchema,
  siteCode: z.string().trim().min(1).max(32).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: paginationSchema.shape.page,
  pageSize: paginationSchema.shape.pageSize,
});

/** Rollup metric names backing each contract metric. */
const ROLLUP_METRICS: Record<DeviceMetric, string[]> = {
  CPU: ["CPU"],
  MEMORY: ["MEMORY"],
  LATENCY_MS: ["LATENCY_MS"],
  PACKET_LOSS: ["PACKET_LOSS"],
  UTILIZATION: ["UTILIZATION_IN", "UTILIZATION_OUT"],
};

/** Downsample a chronological series to at most 24 trailing buckets. */
function trendSeries(values: number[], cap = 24): number[] {
  if (values.length <= cap) return values.map(round1);
  const out: number[] = [];
  const step = values.length / cap;
  for (let i = values.length - cap; i < values.length; i += 1) {
    out.push(round1(values[Math.floor(i)]));
  }
  return out;
}

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
    metric: url.searchParams.get("metric") ?? undefined,
    range: url.searchParams.get("range") ?? undefined,
    siteCode: url.searchParams.get("siteCode") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { metric, siteCode, q, page, pageSize } = parsed.data;

  const win = rangeWindow(parsed.data.range);
  const granularity = await resolveGranularity(win);

  // Devices visible under the site/q filters (status kept for the rows).
  const devices = await db.device.findMany({
    where: {
      ...(siteCode ? { site: { code: siteCode } } : {}),
      ...(q
        ? {
            OR: [
              { hostname: { contains: q } },
              { displayName: { contains: q } },
              { mgmtIp: { contains: q } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      hostname: true,
      status: true,
      criticality: true,
      site: { select: { code: true } },
    },
    orderBy: { hostname: "asc" },
  });
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  // ── bucket series per device ─────────────────────────────────────────
  // deviceId → bucketTs → { avgParts[], maxParts[] } (UTILIZATION has two
  // directions per bucket; single-metric metrics exactly one row).
  const bucketData = new Map<string, Map<number, { avgParts: number[]; maxParts: number[] }>>();
  const rollups = await fetchRollups(granularity, win.since, ROLLUP_METRICS[metric]);
  for (const row of rollups) {
    if (!deviceById.has(row.deviceId)) continue;
    let byBucket = bucketData.get(row.deviceId);
    if (!byBucket) {
      byBucket = new Map();
      bucketData.set(row.deviceId, byBucket);
    }
    const ts = row.periodStart.getTime();
    const entry = byBucket.get(ts) ?? { avgParts: [], maxParts: [] };
    entry.avgParts.push(row.avg);
    entry.maxParts.push(row.max);
    byBucket.set(ts, entry);
  }

  /** Combined chronological bucket values + bucket maxes for a device. */
  const seriesFor = (deviceId: string): { series: number[]; maxes: number[]; lastTs: number | null } => {
    const byBucket = bucketData.get(deviceId);
    if (!byBucket || byBucket.size === 0) return { series: [], maxes: [], lastTs: null };
    const sorted = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
    const series = sorted.map(([, entry]) =>
      metric === "UTILIZATION" ? Math.max(...entry.avgParts) : mean(entry.avgParts)
    );
    const maxes = sorted.map(([, entry]) => Math.max(...entry.maxParts));
    return { series, maxes, lastTs: sorted[sorted.length - 1][0] };
  };

  // ── latest raw sample per device inside the window ───────────────────
  const samples = await db.metricSample.findMany({
    where: {
      metric: { in: ROLLUP_METRICS[metric] },
      ts: { gte: win.since },
      deviceId: { in: devices.map((d) => d.id) },
    },
    select: { deviceId: true, metric: true, value: true, ts: true },
    orderBy: { ts: "asc" },
  });
  type SampleLite = { value: number; ts: Date };
  const latestDirect = new Map<string, SampleLite>();
  const latestPair = new Map<string, { in: SampleLite | null; out: SampleLite | null }>();
  for (const sample of samples) {
    const lite: SampleLite = { value: sample.value, ts: sample.ts };
    if (metric === "UTILIZATION") {
      const pair = latestPair.get(sample.deviceId) ?? { in: null, out: null };
      if (sample.metric === "UTILIZATION_IN") pair.in = lite;
      else pair.out = lite;
      latestPair.set(sample.deviceId, pair);
    } else {
      latestDirect.set(sample.deviceId, lite);
    }
  }

  const latestFor = (deviceId: string, fallbackTs: number | null): { value: number; ts: string } => {
    if (metric === "UTILIZATION") {
      const pair = latestPair.get(deviceId);
      if (pair && (pair.in || pair.out)) {
        const inVal = pair.in?.value ?? -Infinity;
        const outVal = pair.out?.value ?? -Infinity;
        const winner = outVal >= inVal ? (pair.out ?? pair.in!) : (pair.in ?? pair.out!);
        return { value: round1(Math.max(inVal, outVal)), ts: winner.ts.toISOString() };
      }
    } else {
      const direct = latestDirect.get(deviceId);
      if (direct) return { value: round1(direct.value), ts: direct.ts.toISOString() };
    }
    return {
      value: Number.NaN,
      ts: new Date(fallbackTs ?? Date.now()).toISOString(),
    };
  };

  // ── rows ─────────────────────────────────────────────────────────────
  const rows: Array<Record<string, unknown>> = [];
  for (const device of devices) {
    const { series, maxes, lastTs } = seriesFor(device.id);
    if (series.length === 0) continue; // no rollup coverage in this range
    const fallbackValue = round1(series[series.length - 1]);
    const latestRaw = latestFor(device.id, lastTs);
    const latest = Number.isNaN(latestRaw.value) ? { value: fallbackValue, ts: latestRaw.ts } : latestRaw;

    const first = series[0];
    const last = series[series.length - 1];
    const deltaPct = first === 0 ? (last > 0 ? 100 : 0) : ((last - first) / first) * 100;

    rows.push({
      deviceId: device.id,
      hostname: device.hostname,
      siteCode: device.site?.code ?? null,
      criticality: device.criticality,
      status: device.status,
      latest,
      avg: round1(mean(series)),
      max: round1(Math.max(...maxes)),
      p95: round1(percentile95(series)),
      deltaPct: round1(deltaPct),
      trend: trendSeries(series),
    });
  }

  rows.sort((a, b) => (b.latest as { value: number }).value - (a.latest as { value: number }).value);

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const paged = rows.slice(start, start + pageSize);

  return ok(
    { rows: paged },
    {
      ...pageMeta(page, pageSize, total),
      metric,
      granularity,
    }
  );
}
