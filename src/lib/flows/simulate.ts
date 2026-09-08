/**
 * Deterministic flow analytics engine (Phase 13-c).
 *
 * FayaNMS has no NetFlow collector, so this module SIMULATES flow records
 * with a strictly deterministic generator: the same (device, interface,
 * bucket) triple always produces the exact same flows, no matter when or
 * how often the endpoint is called. Numbers only change when a new
 * 15-minute bucket completes — polls and refreshes inside a bucket are
 * byte-identical (verified in Task 13-c).
 *
 * ── HOW DETERMINISM IS ACHIEVED ──
 * 1. Time is quantized: BUCKET_MS = 15 minutes. The analysis window ends
 *    at the last COMPLETE bucket (the in-flight bucket is excluded), so a
 *    window is fully described by an integer range of bucket indices.
 * 2. Every bucket is seeded from a hash of
 *      deviceId + interfaceId + bucketIndex  (FNV-1a 32-bit)
 *    driving a mulberry32 PRNG — identical inputs, identical stream.
 * 3. No wall-clock input leaks into the generated content (only into
 *    meta.computedAt / window boundaries).
 *
 * ── WHAT IS GENERATED ──
 * Per interface and bucket: 8–20 flows with realistic private/public
 * address pairs (the site's 10.<octet>.0.0/16 space derived from the
 * device mgmtIp seed convention plus TEST-NET documentation ranges for
 * external hosts), a protocol mix weighted toward HTTPS/DNS with SMB/NFS
 * backup and management traffic, lognormal-ish byte volumes, packet
 * counts from an average packet size, TCP flag summaries and a per-flow
 * in/out direction for interface throughput aggregation.
 *
 * Aggregates exported: topTalkers (by source IP), protocolDistribution
 * (share of bytes), interfaceTotals (average Mbps per interface) and a
 * recentFlows sample capped at 50 records.
 *
 * NO schema, NO worker and NO persistence are involved — the API route
 * feeds device + interfaces from Prisma and everything else is computed.
 */

export const FLOW_BUCKET_MS = 15 * 60 * 1000;

/** Supported analysis windows and their completed-bucket counts. */
export const FLOW_WINDOWS = {
  "1h": { buckets: 4 },
  "6h": { buckets: 24 },
  "24h": { buckets: 96 },
} as const;

export type FlowWindow = keyof typeof FLOW_WINDOWS;

/** Hard bounds so a hostile payload can never blow up the computation. */
export const MAX_INTERFACES = 12;
export const SAMPLE_LIMIT = 50;
const MIN_FLOWS_PER_BUCKET = 8;
const MAX_FLOWS_PER_BUCKET = 20;

export interface FlowInterfaceInput {
  id: string;
  name: string;
  speedMbps: number | null;
  operStatus: string;
}

export interface FlowRecord {
  id: string;
  /** ISO timestamp inside the bucket the flow belongs to. */
  ts: string;
  interfaceId: string;
  interfaceName: string;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  protocol: string;
  bytes: number;
  packets: number;
  /** TCP flag summary; null for UDP-style protocols. */
  tcpFlags: string | null;
  /** Direction relative to the device ("in" = toward the device). */
  direction: "in" | "out";
}

export interface FlowTalkerRow {
  rank: number;
  srcIp: string;
  /** Dominant destination, or null when the source spread across many. */
  dstIp: string | null;
  dstIpCount: number;
  bytes: number;
  packets: number;
  flows: number;
  topProtocol: string;
  topPort: number;
}

export interface FlowProtocolRow {
  protocol: string;
  port: number;
  bytes: number;
  packets: number;
  flows: number;
  /** Share of total bytes, 0–100 with one decimal. */
  pct: number;
}

export interface FlowInterfaceTotal {
  interfaceId: string;
  name: string;
  speedMbps: number | null;
  inMbps: number;
  outMbps: number;
  bytes: number;
  packets: number;
  flows: number;
}

export interface FlowAnalytics {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: number;
  totals: {
    bytes: number;
    packets: number;
    flows: number;
    avgInMbps: number;
    avgOutMbps: number;
  };
  topTalkers: FlowTalkerRow[];
  protocolDistribution: FlowProtocolRow[];
  interfaceTotals: FlowInterfaceTotal[];
  /** Newest first, capped at SAMPLE_LIMIT. */
  sample: FlowRecord[];
}

/* ───────────────────────── deterministic core ───────────────────────── */

/** FNV-1a 32-bit string hash → unsigned int seed. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, fast, stable across JS engines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function intIn(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Sum of three uniforms − 1.5 → cheap pseudo-normal (σ ≈ 0.5). */
function normal3(rng: Rng): number {
  return rng() + rng() + rng() - 1.5;
}

function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/* ───────────────────────── traffic model ───────────────────────── */

interface ProtocolProfile {
  protocol: string;
  port: number;
  weight: number;
  /** Mean bytes per flow (pre-jitter). */
  baseBytes: number;
  /** Average packet size used to derive packet counts. */
  avgPkt: number;
  tcp: boolean;
}

/** Weighted protocol mix — HTTPS/DNS dominate, backup + mgmt fill in. */
const PROTOCOLS: ProtocolProfile[] = [
  { protocol: "HTTPS", port: 443, weight: 34, baseBytes: 42_000, avgPkt: 1_200, tcp: true },
  { protocol: "HTTP", port: 80, weight: 10, baseBytes: 85_000, avgPkt: 1_300, tcp: true },
  { protocol: "DNS", port: 53, weight: 13, baseBytes: 130, avgPkt: 90, tcp: false },
  { protocol: "SSH", port: 22, weight: 7, baseBytes: 9_500, avgPkt: 800, tcp: true },
  { protocol: "RDP", port: 3389, weight: 7, baseBytes: 18_000, avgPkt: 1_100, tcp: true },
  { protocol: "SNMP", port: 161, weight: 5, baseBytes: 480, avgPkt: 480, tcp: false },
  { protocol: "SMB", port: 445, weight: 9, baseBytes: 210_000, avgPkt: 1_400, tcp: true },
  { protocol: "NFS", port: 2049, weight: 8, baseBytes: 260_000, avgPkt: 1_500, tcp: true },
  { protocol: "NTP", port: 123, weight: 3, baseBytes: 90, avgPkt: 90, tcp: false },
  { protocol: "SYSLOG", port: 514, weight: 4, baseBytes: 320, avgPkt: 300, tcp: false },
];

const TCP_FLAG_PROFILES = [
  { flags: "PSH,ACK", weight: 70 },
  { flags: "ACK", weight: 10 },
  { flags: "SYN", weight: 8 },
  { flags: "SYN,ACK", weight: 4 },
  { flags: "FIN,ACK", weight: 6 },
  { flags: "RST", weight: 2 },
];

/** Documentation-range public pools + well-known resolvers (demo externals). */
const EXTERNAL_PREFIXES = ["203.0.113.", "198.51.100."];
const EXTERNAL_FIXED = ["8.8.8.8", "1.1.1.1", "9.9.9.9"];

/**
 * Site 10.<octet>.0.0/16 from the seed convention (mgmtIp second octet):
 * HQ 10.20.x, DC 10.30.x, BR1 10.40.x, BR2 10.50.x. Fallback 10 when the
 * address does not match the convention (imported devices etc.).
 */
function siteOctetFromIp(ip: string): number {
  const second = Number.parseInt(ip.split(".")[1] ?? "", 10);
  return Number.isInteger(second) && second > 0 && second < 255 ? second : 10;
}

function randomInternalIp(rng: Rng, octet: number, deviceIp: string): string {
  // ~10% of internal flows involve the device's own address.
  if (rng() < 0.1) return deviceIp;
  return `10.${octet}.${intIn(rng, 1, 40)}.${intIn(rng, 2, 254)}`;
}

function randomExternalIp(rng: Rng): string {
  if (rng() < 0.4) {
    return EXTERNAL_FIXED[intIn(rng, 0, EXTERNAL_FIXED.length - 1)];
  }
  const prefix = EXTERNAL_PREFIXES[intIn(rng, 0, EXTERNAL_PREFIXES.length - 1)];
  return `${prefix}${intIn(rng, 1, 254)}`;
}

function randomEphemeralPort(rng: Rng): number {
  return intIn(rng, 1024, 65535);
}

/* ───────────────────────── aggregation ───────────────────────── */

interface TalkerAccumulator {
  bytes: number;
  packets: number;
  flows: number;
  dsts: Map<string, number>;
  protocols: Map<string, { bytes: number; port: number }>;
}

export interface SimulateDeviceInput {
  id: string;
  mgmtIp: string;
}

/**
 * Generate + aggregate deterministic flows for one device over a window.
 * `nowMs` defaults to Date.now() and only anchors the window boundary
 * (last complete bucket) — never the generated content.
 */
export function simulateDeviceFlows(
  device: SimulateDeviceInput,
  interfaces: FlowInterfaceInput[],
  window: FlowWindow,
  nowMs: number = Date.now()
): FlowAnalytics {
  const bucketCount = FLOW_WINDOWS[window].buckets;
  const lastCompleteBucket = Math.floor(nowMs / FLOW_BUCKET_MS) - 1;
  const startBucket = lastCompleteBucket - bucketCount + 1;
  const siteOctet = siteOctetFromIp(device.mgmtIp);
  const windowSec = (bucketCount * FLOW_BUCKET_MS) / 1000;

  const scoped = interfaces.slice(0, MAX_INTERFACES);

  const flows: FlowRecord[] = [];
  const interfaceAccumulators = new Map<
    string,
    { inBytes: number; outBytes: number; packets: number; flows: number }
  >();
  const talkers = new Map<string, TalkerAccumulator>();
  const protocols = new Map<
    string,
    { bytes: number; packets: number; flows: number; port: number }
  >();

  let totalBytes = 0;
  let totalPackets = 0;

  for (const iface of scoped) {
    const ifaceAcc =
      interfaceAccumulators.get(iface.id) ??
      { inBytes: 0, outBytes: 0, packets: 0, flows: 0 };
    interfaceAccumulators.set(iface.id, ifaceAcc);

    for (let b = 0; b < bucketCount; b += 1) {
      const bucketIndex = startBucket + b;
      const bucketStartMs = bucketIndex * FLOW_BUCKET_MS;
      const rng = mulberry32(hash32(`${device.id}|${iface.id}|${bucketIndex}`));

      const flowCount =
        MIN_FLOWS_PER_BUCKET +
        Math.floor(rng() * (MAX_FLOWS_PER_BUCKET - MIN_FLOWS_PER_BUCKET + 1));

      // One heavy-hitter source + one popular destination per bucket keep
      // the talker ranking meaningful instead of uniform noise.
      const heavySrc = randomInternalIp(rng, siteOctet, device.mgmtIp);
      const heavyDst =
        rng() < 0.6
          ? randomInternalIp(rng, siteOctet, device.mgmtIp)
          : randomExternalIp(rng);

      for (let f = 0; f < flowCount; f += 1) {
        const profile = pickWeighted(rng, PROTOCOLS);

        const srcIp =
          rng() < 0.45 ? heavySrc : randomInternalIp(rng, siteOctet, device.mgmtIp);
        const dstIp =
          rng() < 0.5
            ? heavyDst
            : rng() < 0.35
              ? randomExternalIp(rng)
              : randomInternalIp(rng, siteOctet, device.mgmtIp);
        // Guard against src === dst self-flows (possible when both fall
        // back to the device's own mgmt address).
        const safeDst = dstIp === srcIp ? randomExternalIp(rng) : dstIp;

        // Lognormal-ish volume: 3-uniform normal × exponential jitter.
        const jitter = Math.exp(normal3(rng) * 1.1);
        const bytes = Math.min(
          5_000_000,
          Math.max(64, Math.round(profile.baseBytes * jitter))
        );
        const packets = Math.max(
          1,
          Math.round((bytes / profile.avgPkt) * (0.85 + rng() * 0.3))
        );
        const tcpFlags = profile.tcp
          ? pickWeighted(rng, TCP_FLAG_PROFILES).flags
          : null;

        const direction: "in" | "out" = rng() < 0.5 ? "in" : "out";
        const ts = new Date(
          bucketStartMs + Math.floor(rng() * FLOW_BUCKET_MS)
        ).toISOString();

        const record: FlowRecord = {
          id: `${iface.id}-b${bucketIndex}-f${f}`,
          ts,
          interfaceId: iface.id,
          interfaceName: iface.name,
          srcIp,
          srcPort: randomEphemeralPort(rng),
          dstIp: safeDst,
          dstPort: profile.port,
          protocol: profile.protocol,
          bytes,
          packets,
          tcpFlags,
          direction,
        };
        flows.push(record);

        totalBytes += bytes;
        totalPackets += packets;
        if (direction === "in") ifaceAcc.inBytes += bytes;
        else ifaceAcc.outBytes += bytes;
        ifaceAcc.packets += packets;
        ifaceAcc.flows += 1;

        const talker =
          talkers.get(srcIp) ??
          {
            bytes: 0,
            packets: 0,
            flows: 0,
            dsts: new Map<string, number>(),
            protocols: new Map<string, { bytes: number; port: number }>(),
          };
        talker.bytes += bytes;
        talker.packets += packets;
        talker.flows += 1;
        talker.dsts.set(safeDst, (talker.dsts.get(safeDst) ?? 0) + bytes);
        const prevProto = talker.protocols.get(profile.protocol);
        talker.protocols.set(profile.protocol, {
          bytes: (prevProto?.bytes ?? 0) + bytes,
          port: profile.port,
        });
        talkers.set(srcIp, talker);

        const protoAcc =
          protocols.get(profile.protocol) ??
          { bytes: 0, packets: 0, flows: 0, port: profile.port };
        protoAcc.bytes += bytes;
        protoAcc.packets += packets;
        protoAcc.flows += 1;
        protoAcc.port = profile.port;
        protocols.set(profile.protocol, protoAcc);
      }
    }
  }

  /* top talkers — top 10 by bytes, dominant-destination semantics */
  const topTalkers: FlowTalkerRow[] = [...talkers.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([srcIp, acc], index) => {
      const dstSorted = [...acc.dsts.entries()].sort((a, b) => b[1] - a[1]);
      const dominantDst = dstSorted[0];
      const dstIpCount = dstSorted.length;
      // A single destination only counts as "the" destination when it
      // clearly dominates; otherwise the talker fanned out to many peers.
      const dominantShare =
        dominantDst && acc.bytes > 0 ? dominantDst[1] / acc.bytes : 0;
      const topProto = [...acc.protocols.entries()].sort(
        (a, b) => b[1].bytes - a[1].bytes
      )[0];
      return {
        rank: index + 1,
        srcIp,
        dstIp: dominantShare >= 0.5 && dominantDst ? dominantDst[0] : null,
        dstIpCount,
        bytes: acc.bytes,
        packets: acc.packets,
        flows: acc.flows,
        topProtocol: topProto?.[0] ?? "—",
        topPort: topProto?.[1].port ?? 0,
      };
    });

  /* protocol distribution — share of total bytes */
  const protocolDistribution: FlowProtocolRow[] = [...protocols.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([protocol, acc]) => ({
      protocol,
      port: acc.port,
      bytes: acc.bytes,
      packets: acc.packets,
      flows: acc.flows,
      pct: totalBytes > 0 ? Math.round((acc.bytes / totalBytes) * 1000) / 10 : 0,
    }));

  /* interface totals — average Mbps across the window */
  const interfaceTotals: FlowInterfaceTotal[] = scoped.map((iface) => {
    const acc = interfaceAccumulators.get(iface.id) ?? {
      inBytes: 0,
      outBytes: 0,
      packets: 0,
      flows: 0,
    };
    const toMbps = (bytes: number) =>
      Math.round(((bytes * 8) / windowSec / 1_000_000) * 100) / 100;
    return {
      interfaceId: iface.id,
      name: iface.name,
      speedMbps: iface.speedMbps,
      inMbps: toMbps(acc.inBytes),
      outMbps: toMbps(acc.outBytes),
      bytes: acc.inBytes + acc.outBytes,
      packets: acc.packets,
      flows: acc.flows,
    };
  });

  const avgInMbps =
    Math.round(interfaceTotals.reduce((sum, t) => sum + t.inMbps, 0) * 100) /
    100;
  const avgOutMbps =
    Math.round(interfaceTotals.reduce((sum, t) => sum + t.outMbps, 0) * 100) /
    100;

  /* recent sample — newest first, deterministic tiebreakers */
  const sample = [...flows]
    .sort(
      (a, b) =>
        b.ts.localeCompare(a.ts) ||
        a.srcIp.localeCompare(b.srcIp) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, SAMPLE_LIMIT);

  return {
    windowStart: new Date(startBucket * FLOW_BUCKET_MS).toISOString(),
    windowEnd: new Date(
      (lastCompleteBucket + 1) * FLOW_BUCKET_MS
    ).toISOString(),
    bucketMs: FLOW_BUCKET_MS,
    buckets: bucketCount,
    totals: {
      bytes: totalBytes,
      packets: totalPackets,
      flows: flows.length,
      avgInMbps,
      avgOutMbps,
    },
    topTalkers,
    protocolDistribution,
    interfaceTotals,
    sample,
  };
}
