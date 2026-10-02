import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { fail, firstIssueMessage, ok } from "../_lib/api";
import { z } from "zod";
import {
  FLOW_BUCKET_MS,
  FLOW_WINDOWS,
  simulateDeviceFlows,
} from "@/lib/flows/simulate";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Flow analytics — deterministic simulated NetFlow (Phase 13-c)
 *
 * GET /api/v1/flows?deviceId=…&window=1h|6h|24h
 *
 * FayaNMS has no flow collector; this endpoint derives NetFlow-style
 * conversation analytics from a DETERMINISTIC per-bucket simulator
 * (src/lib/flows/simulate.ts):
 *   - time is quantized into 15-minute export buckets (FLOW_BUCKET_MS);
 *   - the window covers only COMPLETE buckets (the in-flight bucket is
 *     excluded), so the same bucket range always yields the same numbers;
 *   - every bucket is seeded by hash(deviceId|interfaceId|bucketIndex) →
 *     mulberry32, i.e. two calls inside one bucket return byte-identical
 *     aggregates (verified in Task 13-c verification).
 *
 * Response (data):
 *   device                 — identity context (hostname/site/status)
 *   totals                 — bytes / packets / flow count / avg Mbps
 *   topTalkers             — top 10 source IPs by bytes (dominant dst)
 *   protocolDistribution   — share of bytes per protocol (canonical port)
 *   interfaceTotals        — avg in/out Mbps per interface (≤ 12 ifaces)
 *   sample                 — newest ≤ 50 flow records
 *   meta                   — window, bucketMs, buckets, computedAt
 *
 * Bounded computation: buckets (4/24/96) × interfaces (≤ 12) × flows
 * (8–20) ≈ ≤ 23k pure-arithmetic rows, no persistence. Read-only GET →
 * no audit event (app convention). `dynamic = "force-dynamic"` matches
 * the other GET routes; the client fetches with cache: "no-store".
 * ───────────────────────────────────────────────────────────────────────────── */

const querySchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  window: z.enum(["1h", "6h", "24h"]).default("1h"),
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
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    window: url.searchParams.get("window") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { deviceId, window } = parsed.data;

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      mgmtIp: true,
      status: true,
      site: { select: { name: true, code: true } },
    },
  });
  if (!device) {
    return fail(
      "DEVICE_NOT_FOUND",
      `No device with id "${deviceId}" exists.`,
      404
    );
  }

  const interfaces = await db.deviceInterface.findMany({
    where: { deviceId },
    select: {
      id: true,
      name: true,
      speedMbps: true,
      operStatus: true,
    },
    orderBy: { name: "asc" },
  });

  const analytics = simulateDeviceFlows(
    { id: device.id, mgmtIp: device.mgmtIp },
    interfaces,
    window
  );

  const computedAt = new Date().toISOString();

  return ok(
    {
      device: {
        id: device.id,
        hostname: device.hostname,
        mgmtIp: device.mgmtIp,
        status: device.status,
        siteCode: device.site?.code ?? null,
        siteName: device.site?.name ?? null,
      },
      totals: analytics.totals,
      topTalkers: analytics.topTalkers,
      protocolDistribution: analytics.protocolDistribution,
      interfaceTotals: analytics.interfaceTotals,
      sample: analytics.sample,
      meta: {
        window,
        bucketMs: FLOW_BUCKET_MS,
        buckets: FLOW_WINDOWS[window].buckets,
        windowStart: analytics.windowStart,
        windowEnd: analytics.windowEnd,
        computedAt,
      },
    },
    { window, computedAt },
    200
  );
}
