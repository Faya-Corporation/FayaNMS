import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import {
  fetchRollups,
  mean,
  metaFor,
  rangeSchema,
  rangeWindow,
  resolveGranularity,
  round1,
} from "@/lib/performance/core";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/performance/availability (Task 6-a)
 *
 * ?range=1H|24H|7D|30D (default 24H)  ?group=SITE|DEVICE (default: both)
 *
 * SLA-style availability over the window, derived from the seed's
 * synthetic per-device AVAILABILITY rollups (metric "AVAILABILITY"):
 *
 * DERIVATION (frozen contract note) — the seed writes, per monitored
 * (non-UNMANAGED) device:
 *   - 1H AVAILABILITY rollups for 7 days  (100 for healthy devices,
 *     ~60–90 dips for DEGRADED, 0 from the outage start for OFFLINE)
 *   - 1D AVAILABILITY rollups for 30 days (same model, hourly means)
 * uptimePct per device = mean of its bucket avgs in the window;
 * downtimeMinutes = Σ (100 − avg)/100 × bucket minutes — a bucket where
 * the device was fully down contributes the whole bucket length.
 * overallPct = fleet mean of device uptimes (monitored population).
 * A bucket counts toward bySite.degradedPct when at least one device in
 * the site is partially degraded (0 < avg < 99.5) — total outages
 * (avg ≤ 5) are downtime, not degradation.
 *
 * slaTargetPct comes from Setting "performance.sla.target" (default 99.9).
 * bySite / byDevice are sorted WORST-FIRST (ascending uptimePct).
 * group filters the returned arrays (both keys stay present, empty array
 * when filtered out, so the response shape never changes).
 */

const querySchema = z.object({
  range: rangeSchema,
  group: z.enum(["SITE", "DEVICE"]).optional(),
});

/** A device bucket is "fully down" at ≤5% availability. */
const DOWN_THRESHOLD_PCT = 5;
/** A device bucket is "healthy" at ≥99.5% availability. */
const UP_THRESHOLD_PCT = 99.5;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    range: url.searchParams.get("range") ?? undefined,
    group: url.searchParams.get("group") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { range, group } = parsed.data;
  const win = rangeWindow(range);
  const granularity = await resolveGranularity(win);
  const bucketMinutes = win.bucketMs / 60_000;

  const [devices, slaSetting] = await Promise.all([
    db.device.findMany({
      select: {
        id: true,
        hostname: true,
        status: true,
        site: { select: { code: true, name: true } },
      },
      orderBy: { hostname: "asc" },
    }),
    db.setting.findUnique({ where: { key: "performance.sla.target" } }),
  ]);
  const monitored = devices.filter((d) => d.status !== "UNMANAGED");
  const monitoredById = new Map(monitored.map((d) => [d.id, d]));

  const slaTargetPct = (() => {
    const raw = slaSetting?.valueJson ? Number(JSON.parse(slaSetting.valueJson)) : Number.NaN;
    return Number.isFinite(raw) ? raw : 99.9;
  })();

  // ── per-device uptime from AVAILABILITY rollups ──────────────────────
  const rollups = await fetchRollups(granularity, win.since, ["AVAILABILITY"]);
  const bucketsByDevice = new Map<string, Map<number, number>>();
  for (const row of rollups) {
    if (!monitoredById.has(row.deviceId)) continue;
    let byBucket = bucketsByDevice.get(row.deviceId);
    if (!byBucket) {
      byBucket = new Map();
      bucketsByDevice.set(row.deviceId, byBucket);
    }
    byBucket.set(row.periodStart.getTime(), row.avg);
  }

  interface DeviceUptime {
    deviceId: string;
    hostname: string;
    siteCode: string;
    uptimePct: number;
    downtimeMinutes: number;
    buckets: Map<number, number>;
  }
  const perDevice: DeviceUptime[] = [];
  for (const device of monitored) {
    const byBucket = bucketsByDevice.get(device.id);
    if (!byBucket || byBucket.size === 0) continue;
    const values = [...byBucket.values()];
    const downtimeMinutes =
      (values.reduce((acc, avg) => acc + (100 - avg) / 100, 0) * bucketMinutes);
    perDevice.push({
      deviceId: device.id,
      hostname: device.hostname,
      siteCode: device.site?.code ?? "—",
      uptimePct: round1(mean(values)),
      downtimeMinutes: round1(downtimeMinutes),
      buckets: byBucket,
    });
  }

  const overallPct = perDevice.length > 0 ? round1(mean(perDevice.map((d) => d.uptimePct))) : 100;

  // ── bySite (worst-first) ─────────────────────────────────────────────
  const bySiteMap = new Map<string, { siteCode: string; siteName: string; devices: DeviceUptime[] }>();
  for (const device of monitoredById.values()) {
    const siteCode = device.site?.code ?? "—";
    const entry = bySiteMap.get(siteCode) ?? {
      siteCode,
      siteName: device.site?.name ?? "Unassigned",
      devices: [],
    };
    bySiteMap.set(siteCode, entry);
  }
  for (const uptime of perDevice) bySiteMap.get(uptime.siteCode)?.devices.push(uptime);

  const allBySite = [...bySiteMap.values()].map((site) => {
    const withData = site.devices;
    // degradedPct: share of buckets where at least one device is partially
    // degraded (none fully down) — computed over the union of buckets seen.
    const bucketTs = new Set<number>();
    for (const d of withData) for (const ts of d.buckets.keys()) bucketTs.add(ts);
    let degradedBuckets = 0;
    for (const ts of bucketTs) {
      let anyDown = false;
      let anyDegraded = false;
      for (const d of withData) {
        const avg = d.buckets.get(ts);
        if (avg === undefined) continue;
        if (avg <= DOWN_THRESHOLD_PCT) anyDown = true;
        else if (avg < UP_THRESHOLD_PCT) anyDegraded = true;
      }
      if (!anyDown && anyDegraded) degradedBuckets += 1;
    }
    return {
      siteCode: site.siteCode,
      siteName: site.siteName,
      uptimePct: withData.length > 0 ? round1(mean(withData.map((d) => d.uptimePct))) : 100,
      degradedPct:
        bucketTs.size > 0 ? round1((100 * degradedBuckets) / bucketTs.size) : 0,
      downtimeMinutes: round1(withData.reduce((acc, d) => acc + d.downtimeMinutes, 0)),
      deviceCount: withData.length,
    };
  });
  allBySite.sort((a, b) => a.uptimePct - b.uptimePct);

  // ── byDevice (worst-first, limit 25) ─────────────────────────────────
  const allByDevice = [...perDevice]
    .sort((a, b) => a.uptimePct - b.uptimePct)
    .slice(0, 25)
    .map((d) => ({
      deviceId: d.deviceId,
      hostname: d.hostname,
      siteCode: d.siteCode,
      uptimePct: d.uptimePct,
      downtimeMinutes: d.downtimeMinutes,
    }));

  return ok(
    {
      overallPct,
      slaTargetPct,
      bySite: group === "DEVICE" ? [] : allBySite,
      byDevice: group === "SITE" ? [] : allByDevice,
    },
    metaFor(range, granularity)
  );
}
