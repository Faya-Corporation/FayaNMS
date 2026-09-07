import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
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
import type { RollupRow } from "@/lib/performance/core";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/performance/overview?range=1H|24H|7D|30D (Task 6-a)
 *
 * Fleet-wide performance KPIs + bucketed series + top utilizers + live
 * health distribution.
 *
 * Derivation notes (frozen contract):
 * - series buckets come from MetricRollup rows at the range's granularity
 *   (1H range prefers 5M rollups, falls back to 1H — see lib/performance);
 *   empty buckets (no rollup rows at all) are omitted.
 * - availabilityPct per bucket = % of monitored (non-UNMANAGED) devices
 *   whose seeded AVAILABILITY rollup avg for that bucket is ≥ 99.5 — i.e.
 *   "devices not OFFLINE/DEGRADED" derived from per-bucket availability
 *   history. The LATEST series point overrides it with live Device.status
 *   (100 × non-OFFLINE/DEGRADED / monitored).
 * - p95LatencyMs = nearest-rank p95 across all LATENCY_MS rollup avg
 *   values in the window. avgCpuPct/avgMemoryPct/packetLossPct = fleet mean
 *   of the respective rollup avgs. avgUtilizationPct = fleet mean over
 *   devices of max(avg UTILIZATION_IN, avg UTILIZATION_OUT) — the same
 *   combination topUtilizers ranks by.
 * - healthDistribution is LIVE Device.status grouping (all six statuses).
 */

const HEALTH_STATUSES = ["ONLINE", "DEGRADED", "OFFLINE", "MAINTENANCE", "UNKNOWN", "UNMANAGED"] as const;

/** A device counts as "up" in a bucket when its availability ≥ 99.5%. */
const UP_THRESHOLD_PCT = 99.5;

const querySchema = z.object({ range: rangeSchema });

/** Per-bucket fleet series accumulator. */
interface Bucket {
  cpu: number[];
  memory: number[];
  utilIn: number[];
  utilOut: number[];
  latency: number[];
  availability: Map<string, number>; // deviceId → avg for the bucket
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ range: url.searchParams.get("range") ?? undefined });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const range = parsed.data.range;
  const win = rangeWindow(range);
  const granularity = await resolveGranularity(win);

  const devices = await db.device.findMany({
    select: { id: true, hostname: true, status: true, site: { select: { code: true, name: true } } },
    orderBy: { hostname: "asc" },
  });
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const monitored = devices.filter((d) => d.status !== "UNMANAGED");
  const monitoredIds = new Set(monitored.map((d) => d.id));

  const rollups = await fetchRollups(granularity, win.since, [
    "CPU",
    "MEMORY",
    "UTILIZATION_IN",
    "UTILIZATION_OUT",
    "LATENCY_MS",
    "AVAILABILITY",
  ]);

  // ── bucket series ────────────────────────────────────────────────────
  const buckets = new Map<number, Bucket>();
  const ensureBucket = (ts: number): Bucket => {
    let b = buckets.get(ts);
    if (!b) {
      b = { cpu: [], memory: [], utilIn: [], utilOut: [], latency: [], availability: new Map() };
      buckets.set(ts, b);
    }
    return b;
  };

  const deviceAvgUtil = new Map<string, { in: number[]; out: number[] }>();
  const allLatency: number[] = [];
  const allCpu: number[] = [];
  const allMemory: number[] = [];
  const allLoss: number[] = [];

  for (const row of rollups) {
    if (!deviceById.has(row.deviceId)) continue;
    const bucket = ensureBucket(row.periodStart.getTime());
    switch (row.metric) {
      case "CPU":
        bucket.cpu.push(row.avg);
        allCpu.push(row.avg);
        break;
      case "MEMORY":
        bucket.memory.push(row.avg);
        allMemory.push(row.avg);
        break;
      case "UTILIZATION_IN":
        bucket.utilIn.push(row.avg);
        perDevice(deviceAvgUtil, row.deviceId).in.push(row.avg);
        break;
      case "UTILIZATION_OUT":
        bucket.utilOut.push(row.avg);
        perDevice(deviceAvgUtil, row.deviceId).out.push(row.avg);
        break;
      case "LATENCY_MS":
        bucket.latency.push(row.avg);
        allLatency.push(row.avg);
        break;
      case "AVAILABILITY":
        if (monitoredIds.has(row.deviceId)) bucket.availability.set(row.deviceId, row.avg);
        break;
    }
  }

  const series = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => ({
      ts: new Date(ts).toISOString(),
      availabilityPct:
        b.availability.size > 0
          ? round1(
              (100 * [...b.availability.values()].filter((v) => v >= UP_THRESHOLD_PCT).length) /
                b.availability.size
            )
          : undefined,
      latencyP95: b.latency.length > 0 ? round1(percentile95(b.latency)) : undefined,
      cpuAvg: b.cpu.length > 0 ? round1(mean(b.cpu)) : undefined,
      memAvg: b.memory.length > 0 ? round1(mean(b.memory)) : undefined,
      utilInAvg: b.utilIn.length > 0 ? round1(mean(b.utilIn)) : undefined,
      utilOutAvg: b.utilOut.length > 0 ? round1(mean(b.utilOut)) : undefined,
    }));

  // Live override for the latest series point: "% devices not
  // OFFLINE/DEGRADED" straight from Device.status (frozen contract).
  if (series.length > 0 && monitored.length > 0) {
    const liveUp = monitored.filter((d) => d.status !== "OFFLINE" && d.status !== "DEGRADED").length;
    series[series.length - 1].availabilityPct = round1((100 * liveUp) / monitored.length);
  }

  // ── KPIs ─────────────────────────────────────────────────────────────
  const availabilityValues = series
    .map((p) => p.availabilityPct)
    .filter((v): v is number => typeof v === "number");

  const perDeviceMaxUtil = [...deviceAvgUtil.entries()]
    .filter(([deviceId]) => deviceById.has(deviceId))
    .map(([deviceId, u]) => {
      const avgIn = u.in.length > 0 ? mean(u.in) : 0;
      const avgOut = u.out.length > 0 ? mean(u.out) : 0;
      return { deviceId, utilPct: Math.max(avgIn, avgOut) };
    });

  const kpis = {
    avgAvailabilityPct: round1(mean(availabilityValues)),
    p95LatencyMs: round1(percentile95(allLatency)),
    avgCpuPct: round1(mean(allCpu)),
    avgMemoryPct: round1(mean(allMemory)),
    avgUtilizationPct: round1(mean(perDeviceMaxUtil.map((d) => d.utilPct))),
    packetLossPct: 0, // replaced below when PACKET_LOSS rollups exist
  };

  const lossRows: RollupRow[] = await fetchRollups(granularity, win.since, ["PACKET_LOSS"]);
  kpis.packetLossPct = round1(mean(lossRows.map((r) => r.avg)));

  // ── top utilizers (top 5 by max(avgIn, avgOut) over the range) ───────
  const topUtilizers = perDeviceMaxUtil
    .sort((a, b) => b.utilPct - a.utilPct)
    .slice(0, 5)
    .map((entry) => {
      const device = deviceById.get(entry.deviceId)!;
      return {
        deviceId: device.id,
        hostname: device.hostname,
        siteCode: device.site?.code ?? null,
        utilPct: round1(entry.utilPct),
      };
    });

  // ── live health distribution ─────────────────────────────────────────
  const healthDistribution = Object.fromEntries(
    HEALTH_STATUSES.map((status) => [status, 0])
  ) as Record<(typeof HEALTH_STATUSES)[number], number>;
  for (const device of devices) {
    if ((HEALTH_STATUSES as readonly string[]).includes(device.status)) {
      healthDistribution[device.status as (typeof HEALTH_STATUSES)[number]] += 1;
    }
  }

  return ok(
    { kpis, series, topUtilizers, healthDistribution },
    metaFor(range, granularity)
  );
}

function perDevice(
  map: Map<string, { in: number[]; out: number[] }>,
  deviceId: string
): { in: number[]; out: number[] } {
  let entry = map.get(deviceId);
  if (!entry) {
    entry = { in: [], out: [] };
    map.set(deviceId, entry);
  }
  return entry;
}
