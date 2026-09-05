import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/metrics?window=6h|24h|7d
 *
 * Per-device metric series for the Health tab, merged across
 * CPU / MEMORY / UTILIZATION_IN / UTILIZATION_OUT into one sorted array:
 *   { ts, cpu, memory, utilizationIn, utilizationOut }
 *
 * Resolution (ADR-07): 6h/24h read raw MetricSamples; 7d prefers 1D rollups,
 * falls back to 1H rollups (clamping to the available window), then to raw
 * samples. meta.source reports which tier served the request.
 */

const METRICS = ["CPU", "MEMORY", "UTILIZATION_IN", "UTILIZATION_OUT"] as const;

const HOURS_MS = 3_600_000;

const querySchema = z.object({
  window: z.enum(["6h", "24h", "7d"]).default("24h"),
});

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface Point {
  ts: string;
  cpu: number | null;
  memory: number | null;
  utilizationIn: number | null;
  utilizationOut: number | null;
}

function emptyPoint(ts: string): Point {
  return { ts, cpu: null, memory: null, utilizationIn: null, utilizationOut: null };
}

const METRIC_TO_FIELD: Record<(typeof METRICS)[number], keyof Point> = {
  CPU: "cpu",
  MEMORY: "memory",
  UTILIZATION_IN: "utilizationIn",
  UTILIZATION_OUT: "utilizationOut",
};

function mergeByKey(
  rows: { ts: Date; metric: string; value: number }[]
): Point[] {
  const buckets = new Map<string, Point>();
  for (const row of rows) {
    const key = row.ts.toISOString();
    const field = METRIC_TO_FIELD[row.metric as (typeof METRICS)[number]];
    if (!field) continue;
    const point = buckets.get(key) ?? emptyPoint(key);
    (point[field] as number) = round1(row.value);
    buckets.set(key, point);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

function mergeRollups(
  rows: { periodStart: Date; metric: string; avg: number }[]
): Point[] {
  const buckets = new Map<string, Point>();
  for (const row of rows) {
    const key = row.periodStart.toISOString();
    const field = METRIC_TO_FIELD[row.metric as (typeof METRICS)[number]];
    if (!field) continue;
    const point = buckets.get(key) ?? emptyPoint(key);
    (point[field] as number) = round1(row.avg);
    buckets.set(key, point);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    window: url.searchParams.get("window") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const window = parsed.data.window;

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const baseSelect = {
    metric: true,
    ts: true,
    value: true,
  };
  const rollupSelect = {
    metric: true,
    periodStart: true,
    avg: true,
  };

  if (window === "6h" || window === "24h") {
    const since = new Date(Date.now() - (window === "6h" ? 6 : 24) * HOURS_MS);
    const rows = await db.metricSample.findMany({
      where: { deviceId: id, metric: { in: Array.from(METRICS) }, ts: { gte: since } },
      orderBy: { ts: "asc" },
      select: baseSelect,
    });
    const series = mergeByKey(
      rows.map((row) => ({ ts: row.ts, metric: row.metric, value: row.value }))
    );
    return ok(
      { series },
      { window, source: "samples", points: series.length, deviceId: id, hostname: device.hostname }
    );
  }

  // window === "7d" — rollup-first chain with graceful fallbacks.
  const since7d = new Date(Date.now() - 7 * 24 * HOURS_MS);

  let daily = await db.metricRollup.findMany({
    where: { deviceId: id, granularity: "1D", metric: { in: Array.from(METRICS) }, periodStart: { gte: since7d } },
    orderBy: { periodStart: "asc" },
    select: rollupSelect,
  });
  if (daily.length > 0) {
    const series = mergeRollups(
      daily.map((row) => ({ periodStart: row.periodStart, metric: row.metric, avg: row.avg }))
    );
    return ok(
      { series },
      { window, source: "rollups-1D", points: series.length, deviceId: id, hostname: device.hostname }
    );
  }

  const hourly = await db.metricRollup.findMany({
    where: { deviceId: id, granularity: "1H", metric: { in: Array.from(METRICS) }, periodStart: { gte: since7d } },
    orderBy: { periodStart: "asc" },
    select: rollupSelect,
  });
  if (hourly.length > 0) {
    const series = mergeRollups(
      hourly.map((row) => ({ periodStart: row.periodStart, metric: row.metric, avg: row.avg }))
    );
    return ok(
      { series },
      { window, source: "rollups-1H", points: series.length, deviceId: id, hostname: device.hostname }
    );
  }

  // No rollups at all — serve the most recent 24h of raw samples instead.
  const since24h = new Date(Date.now() - 24 * HOURS_MS);
  const rows = await db.metricSample.findMany({
    where: { deviceId: id, metric: { in: Array.from(METRICS) }, ts: { gte: since24h } },
    orderBy: { ts: "asc" },
    select: baseSelect,
  });
  const series = mergeByKey(
    rows.map((row) => ({ ts: row.ts, metric: row.metric, value: row.value }))
  );
  return ok(
    { series },
    { window: "24h", requested: window, source: "samples", points: series.length, deviceId: id, hostname: device.hostname }
  );
}
