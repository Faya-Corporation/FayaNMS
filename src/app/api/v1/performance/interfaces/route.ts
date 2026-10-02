import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../_lib/api";
import {
  rangeSchema,
  rangeWindow,
  round1,
} from "@/lib/performance/core";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/performance/interfaces (Task 6-a)
 *
 * ?range=1H|24H|7D|30D (default 24H)  ?siteCode=  ?q=  ?sort=UTIL|PACKET_LOSS
 * ?page=  ?pageSize=
 *
 * Interface utilization table built from RAW MetricSample rows:
 * UTILIZATION_IN / UTILIZATION_OUT grouped per (deviceId, interfaceId),
 * joined with DeviceInterface (name/speed/oper status) and Device.
 *
 * UNITS — important normalization note (frozen contract):
 * MetricSample values for UTILIZATION_* are stored as **percent of
 * interface capacity** (the seed's metricValue() emits 1–98.5 %
 * directly; there are no bps-valued utilization samples in this demo
 * dataset — DeviceInterface.countersInBps/countersOutBps hold the bps
 * counters, but samples never store bps). Therefore:
 *     utilInPct = sample.value            (already 0–100+)
 *     utilOutPct = sample.value
 * If bps-valued samples were ever introduced, the conversion
 * (value / speedMbps * 100) belongs exactly here.
 *
 * - utilInPct / utilOutPct = latest sample per direction inside the window
 * - utilPeakPct            = max(max(in), max(out)) across ALL samples of
 *                            the interface in the window
 * - packetLossPct          = device-level latest PACKET_LOSS sample
 *                            (interfaceId null) — device-scoped by design
 * - meta.granularity       = "RAW" (this endpoint reads raw samples, not
 *                            rollups; the range still bounds the window)
 * - meta.operStatusCounts  = operStatus counts over the FULL filtered set
 * - sort=UTIL              → desc by max(utilInPct, utilOutPct)
 *   sort=PACKET_LOSS       → desc by packetLossPct
 */

const querySchema = z.object({
  range: rangeSchema,
  siteCode: z.string().trim().min(1).max(32).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(["UTIL", "PACKET_LOSS"]).default("UTIL"),
  page: paginationSchema.shape.page,
  pageSize: paginationSchema.shape.pageSize,
});

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
    siteCode: url.searchParams.get("siteCode") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { range, siteCode, q, sort, page, pageSize } = parsed.data;
  const win = rangeWindow(range);

  // ── utilization samples grouped per (deviceId, interfaceId) ──────────
  const utilSamples = await db.metricSample.findMany({
    where: {
      metric: { in: ["UTILIZATION_IN", "UTILIZATION_OUT"] },
      interfaceId: { not: null },
      ts: { gte: win.since },
    },
    select: { deviceId: true, interfaceId: true, metric: true, value: true, ts: true },
    orderBy: { ts: "asc" },
  });

  interface IfaceAgg {
    deviceId: string;
    interfaceId: string;
    latestIn: { value: number; ts: Date } | null;
    latestOut: { value: number; ts: Date } | null;
    peak: number;
  }
  const agg = new Map<string, IfaceAgg>();
  for (const sample of utilSamples) {
    const key = `${sample.deviceId}::${sample.interfaceId}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { deviceId: sample.deviceId, interfaceId: sample.interfaceId!, latestIn: null, latestOut: null, peak: 0 };
      agg.set(key, entry);
    }
    const lite = { value: sample.value, ts: sample.ts };
    if (sample.metric === "UTILIZATION_IN") entry.latestIn = lite;
    else entry.latestOut = lite;
    entry.peak = Math.max(entry.peak, sample.value);
  }

  if (agg.size === 0) {
    return ok(
      { rows: [] },
      {
        ...pageMeta(page, pageSize, 0),
        range,
        granularity: "RAW",
        generatedAt: new Date().toISOString(),
        operStatusCounts: {},
      }
    );
  }

  // ── interface + device joins ─────────────────────────────────────────
  const interfaceIds = [...new Set([...agg.values()].map((e) => e.interfaceId))];
  const interfaces = await db.deviceInterface.findMany({
    where: { id: { in: interfaceIds } },
    select: {
      id: true,
      deviceId: true,
      name: true,
      operStatus: true,
      speedMbps: true,
      device: {
        select: { hostname: true, status: true, site: { select: { code: true } } },
      },
    },
  });
  const ifaceById = new Map(interfaces.map((i) => [i.id, i]));

  // ── device-level latest PACKET_LOSS per device (interfaceId null) ────
  const deviceIds = [...new Set([...agg.values()].map((e) => e.deviceId))];
  const lossSamples = await db.metricSample.findMany({
    where: {
      metric: "PACKET_LOSS",
      interfaceId: null,
      deviceId: { in: deviceIds },
      ts: { gte: win.since },
    },
    select: { deviceId: true, value: true, ts: true },
    orderBy: { ts: "asc" },
  });
  const lossByDevice = new Map<string, { value: number; ts: Date }>();
  for (const row of lossSamples) lossByDevice.set(row.deviceId, { value: row.value, ts: row.ts });

  // ── rows (filters applied in-memory — the fleet is small) ────────────
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of agg.values()) {
    const iface = ifaceById.get(entry.interfaceId);
    if (!iface) continue;
    const device = iface.device;
    if (siteCode && device.site?.code !== siteCode) continue;
    if (
      q &&
      !device.hostname.toLowerCase().includes(q.toLowerCase()) &&
      !iface.name.toLowerCase().includes(q.toLowerCase())
    ) {
      continue;
    }
    const utilInPct = entry.latestIn?.value ?? 0;
    const utilOutPct = entry.latestOut?.value ?? 0;
    const latestTs = [entry.latestIn?.ts, entry.latestOut?.ts]
      .filter((ts): ts is Date => ts instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const loss = lossByDevice.get(entry.deviceId);
    rows.push({
      interfaceId: entry.interfaceId,
      deviceId: entry.deviceId,
      hostname: device.hostname,
      siteCode: device.site?.code ?? null,
      ifName: iface.name,
      operStatus: iface.operStatus,
      speedMbps: iface.speedMbps,
      utilInPct: round1(utilInPct),
      utilOutPct: round1(utilOutPct),
      utilPeakPct: round1(entry.peak),
      packetLossPct: loss ? round1(loss.value) : 0,
      ts: (latestTs ?? new Date()).toISOString(),
    });
  }

  rows.sort((a, b) =>
    sort === "UTIL"
      ? Math.max(b.utilInPct as number, b.utilOutPct as number) -
        Math.max(a.utilInPct as number, a.utilOutPct as number)
      : (b.packetLossPct as number) - (a.packetLossPct as number)
  );

  // operStatus facet over the FULL filtered set (not just the page).
  const operStatusCounts: Record<string, number> = {};
  for (const row of rows) {
    const status = row.operStatus as string;
    operStatusCounts[status] = (operStatusCounts[status] ?? 0) + 1;
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const paged = rows.slice(start, start + pageSize);

  return ok(
    { rows: paged },
    {
      ...pageMeta(page, pageSize, total),
      range,
      granularity: "RAW",
      generatedAt: new Date().toISOString(),
      operStatusCounts,
    }
  );
}
