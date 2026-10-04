import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { nextPost, log } from "./next-client";
import { resolveVaultSecret } from "./vault";
import {
  decodeSnmpV3Trap,
  readSnmpV3UsmIdentity,
} from "../../scripts/protocol-lab/snmpv3";
import { normalizeEngineIdHex } from "../../src/lib/protocol/snmpv3-policy";
import { PROTOCOLS, type ProtocolName } from "../../src/lib/protocol/ingest";
import { decodeNetFlowV5Datagram, type NetFlowV5Batch } from "../../src/lib/protocol/netflow-v5";

const DEFAULT_PORTS: Record<ProtocolName, number> = {
  syslog: 5514,
  "snmp-trap": 1162,
  netflow: 2055,
  ipfix: 4739,
  sflow: 6343,
};
const MAX_PACKET_BYTES = 65_535;
const MAX_IN_FLIGHT = 32;
const MAX_PENDING_RELAYS = 256;
const MAX_RELAY_ATTEMPTS = 3;
const RELAY_BACKOFF_BASE_MS = 250;

export interface ProtocolCollectorMetrics {
  /** Collector env-enabled. `up` is the honest liveness signal (F-037). */
  enabled: boolean;
  /**
   * F-037: true only when enabled, at least one socket is configured, EVERY
   * configured socket completed its bind, and no bind failed. A bind failure
   * (EADDRINUSE/EACCES/…) previously still reported collector_up 1.
   */
  up: boolean;
  sockets: number;
  boundSockets: number;
  bindFailures: number;
  packetsReceived: number;
  packetsAccepted: number;
  packetsRejected: number;
  queueDrops: number;
  relayFailures: number;
  relayRetries: number;
  relayDeadLetters: number;
  relayQueueDepth: number;
}

let metrics: ProtocolCollectorMetrics = {
  enabled: false,
  up: false,
  sockets: 0,
  boundSockets: 0,
  bindFailures: 0,
  packetsReceived: 0,
  packetsAccepted: 0,
  packetsRejected: 0,
  queueDrops: 0,
  relayFailures: 0,
  relayRetries: 0,
  relayDeadLetters: 0,
  relayQueueDepth: 0,
};
let activeRelays = 0;
let activeVerifications = 0;

interface PendingRelay {
  event: Record<string, unknown>;
  attempt: number;
}

let relayQueue: PendingRelay[] = [];
let relayDraining = false;

export interface SnmpV3ProfileReference {
  credentialProfileId: string;
  hostname: string;
  username: string;
  secretRef: string;
  engineIdHex: string;
}

interface DecodedProtocolPayload {
  eventType: string;
  severity: string;
  message: string;
  protocolVersion: string;
  securityLevel?: "authPriv" | "community" | "unknown";
  deviceHint?: { hostname: string; credentialProfileId?: string };
  attributes: Record<string, string | number | boolean | null>;
  flowBatch?: NetFlowV5Batch;
}


function envKey(protocol: ProtocolName, suffix: string): string {
  return "FAYANMS_" + protocol.toUpperCase().replace(/-/g, "_") + suffix;
}

function portFor(protocol: ProtocolName): number {
  const key = envKey(protocol, "_PORT");
  const raw = process.env[key]?.trim();
  const port = raw ? Number(raw) : DEFAULT_PORTS[protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(key + " must be an integer UDP port from 1 to 65535");
  }
  return port;
}

function severityFromSyslog(priority: number): string {
  return ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"][priority % 8] ?? "INFO";
}

function parseSyslog(packet: Buffer): DecodedProtocolPayload {
  const text = packet.toString("utf8", 0, Math.min(packet.length, 8192));
  const priorityMatch = /^<([0-9]{1,3})>/.exec(text);
  const priority = priorityMatch ? Number(priorityMatch[1]) : 14;
  const stripped = priorityMatch ? text.slice(priorityMatch[0].length) : text;
  const fields = stripped.split(/\s+/);
  const is5424 = fields[0] === "1";
  const hostname = is5424 ? fields[2] : fields[0];
  return {
    eventType: "SYSLOG_MESSAGE",
    severity: severityFromSyslog(priority),
    message: stripped,
    protocolVersion: is5424 ? "RFC5424" : "RFC3164_OR_PLAIN",
    deviceHint: hostname && hostname !== "-" ? { hostname } : undefined,
    attributes: { facility: Math.floor(priority / 8), priority },
  };
}

function readVersion(packet: Buffer): number | null {
  return packet.length >= 4 ? packet.readUInt32BE(0) : null;
}

function parseBinary(protocol: ProtocolName, packet: Buffer): DecodedProtocolPayload | null {
  if (protocol === "snmp-trap") {
    if (packet.length < 2 || packet[0] !== 0x30) return null;
    return {
      eventType: "SNMP_TRAP",
      severity: "INFO",
      message: "SNMP trap packet received",
      protocolVersion: "BER",
      securityLevel: "unknown",
      attributes: { bytes: packet.length },
    };
  }
  if (protocol === "netflow" && packet.length >= 2 && packet.readUInt16BE(0) === 5) {
    const flowBatch = decodeNetFlowV5Datagram(packet);
    if (!flowBatch) return null;
    return {
      eventType: "FLOW_RECORD_BATCH",
      severity: "INFO",
      message: "NetFlow v5 packet received",
      protocolVersion: "NETFLOW_V5",
      attributes: { version: 5, count: flowBatch.header.count },
      flowBatch,
    };
  }
  const version = readVersion(packet);
  if (version === null) return null;
  const expected = protocol === "netflow" ? [5, 9] : protocol === "ipfix" ? [10] : [5];
  if (!expected.includes(version)) return null;
  return {
    eventType: protocol === "sflow" ? "SFLOW_SAMPLE" : "FLOW_RECORD_BATCH",
    severity: "INFO",
    message: protocol + " packet received",
    protocolVersion: protocol.toUpperCase() + "_V" + version,
    attributes: { bytes: packet.length, version },
  };
}

export function decodeProtocolPacket(
  protocol: ProtocolName,
  packet: Buffer,
  remote: Pick<RemoteInfo, "address" | "port">,
) {
  if (packet.length === 0 || packet.length > MAX_PACKET_BYTES) return null;
  const parsed = protocol === "syslog" ? parseSyslog(packet) : parseBinary(protocol, packet);
  if (!parsed) return null;
  return {
    collectorId: process.env.FAYANMS_PROTOCOL_COLLECTOR_ID?.trim() || "worker-1",
    protocol,
    sourceIp: remote.address,
    sourcePort: remote.port,
    receivedAt: new Date().toISOString(),
    ...parsed,
  };
}

/* ───────────────────────── F-037 secret cache ──────────────────────────
 *
 * HISTORY: every datagram on the snmp-trap socket triggered a full vault
 * resolution (provider=file re-reads the secrets JSON; provider=exec SPAWNS
 * a process). An unauthenticated UDP flood therefore bought the worker one
 * file read or process spawn PER PACKET — asymmetric attacker→defender
 * cost. The closure is the BACKLOG plan's named decision: cache the
 * RESOLVED secret per profile behind a short TTL, and single-flight the
 * in-flight resolution so a concurrent burst for the same profile costs
 * exactly ONE vault round-trip.
 *
 * SEMANTICS (pinned by tests/audit/open-findings-batch-21.test.ts):
 *   - Keyed by credentialProfileId + secretRef — entries NEVER leak across
 *     profiles (different profile ⇒ different key even if a ref collides).
 *   - The cached value is exactly the string resolveVaultSecret returned —
 *     no trimming, no normalization, no fallback; verification still fails
 *     closed on any other value.
 *   - TTL default 30s (SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS): bounds the
 *     staleness window after a vault rotation to ≤30s while collapsing
 *     per-packet resolutions; during the window a rotated secret fails USM
 *     auth (fail-closed, packetsRejected), never a wrong-accept.
 *   - FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS overrides the TTL, clamped to
 *     [250ms, 600s] — the low bound keeps the cache from being effectively
 *     disabled by a typo, and lets the lab exercise real expiry quickly.
 *   - Bounded to 256 entries (oldest-inserted evicted): the key includes
 *     attacker-influenced profile data, so the map must not grow with it.
 *   - Failed resolutions are never cached; concurrent callers of a failing
 *     resolution share the single in-flight rejection (fail-closed).
 *   - stop() clears the cache: resolved VALUES do not outlive the collector.
 */

export const SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS = 30_000;
const SNMPV3_SECRET_CACHE_TTL_MIN_MS = 250;
const SNMPV3_SECRET_CACHE_TTL_MAX_MS = 600_000;
const SNMPV3_SECRET_CACHE_MAX_ENTRIES = 256;

/** Effective TTL (clamped). Re-read per resolution so the lab can exercise expiry. */
export function snmpv3SecretCacheTtlMs(): number {
  const parsed = Number.parseInt(
    process.env.FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS ?? "",
    10,
  );
  if (!Number.isFinite(parsed)) return SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS;
  return Math.min(
    SNMPV3_SECRET_CACHE_TTL_MAX_MS,
    Math.max(SNMPV3_SECRET_CACHE_TTL_MIN_MS, parsed),
  );
}

export interface SnmpV3SecretCacheStats {
  entries: number;
  /** Actual vault round-trips (file re-reads / exec spawns). */
  resolutions: number;
  /** Served from the TTL cache without touching the vault. */
  cacheHits: number;
  /** Joined an already in-flight resolution (single-flight). */
  coalesced: number;
  /** Entries dropped because their TTL had expired. */
  expired: number;
  /** Entries evicted by the capacity bound. */
  evictions: number;
}

interface SnmpV3SecretCacheEntry {
  secret: string;
  expiresAt: number;
}

const snmpV3SecretCache = new Map<string, SnmpV3SecretCacheEntry>();
const snmpV3SecretInFlight = new Map<string, Promise<string>>();
const snmpV3SecretCacheCounters = {
  resolutions: 0,
  cacheHits: 0,
  coalesced: 0,
  expired: 0,
  evictions: 0,
};

export function getSnmpV3SecretCacheStats(): SnmpV3SecretCacheStats {
  return { ...snmpV3SecretCacheCounters, entries: snmpV3SecretCache.size };
}

/** Clear cached secrets (and in-flight map); called by stop() and between lab runs. */
export function resetSnmpV3SecretCache(): void {
  snmpV3SecretCache.clear();
  snmpV3SecretInFlight.clear();
  snmpV3SecretCacheCounters.resolutions = 0;
  snmpV3SecretCacheCounters.cacheHits = 0;
  snmpV3SecretCacheCounters.coalesced = 0;
  snmpV3SecretCacheCounters.expired = 0;
  snmpV3SecretCacheCounters.evictions = 0;
}

/**
 * Resolve the profile's vault secret through the TTL cache + single-flight.
 * The ONLY path from the per-packet decoder to resolveVaultSecret.
 */
async function resolveSnmpV3ProfileSecret(
  profile: SnmpV3ProfileReference,
): Promise<string> {
  const key = profile.credentialProfileId + "@" + profile.secretRef;
  const cached = snmpV3SecretCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      snmpV3SecretCacheCounters.cacheHits += 1;
      return cached.secret;
    }
    snmpV3SecretCache.delete(key);
    snmpV3SecretCacheCounters.expired += 1;
  }
  const inFlight = snmpV3SecretInFlight.get(key);
  if (inFlight) {
    snmpV3SecretCacheCounters.coalesced += 1;
    return inFlight;
  }
  snmpV3SecretCacheCounters.resolutions += 1;
  const resolution = resolveVaultSecret(profile.secretRef)
    .then((secret) => {
      while (snmpV3SecretCache.size >= SNMPV3_SECRET_CACHE_MAX_ENTRIES) {
        const oldest = snmpV3SecretCache.keys().next().value;
        if (oldest === undefined) break;
        snmpV3SecretCache.delete(oldest);
        snmpV3SecretCacheCounters.evictions += 1;
      }
      snmpV3SecretCache.set(key, {
        secret,
        expiresAt: Date.now() + snmpv3SecretCacheTtlMs(),
      });
      return secret;
    })
    .finally(() => {
      snmpV3SecretInFlight.delete(key);
    });
  snmpV3SecretInFlight.set(key, resolution);
  return resolution;
}

export async function decodeVerifiedSnmpV3Trap(
  packet: Buffer,
  remote: Pick<RemoteInfo, "address" | "port">,
  profile: SnmpV3ProfileReference,
) {
  const identity = readSnmpV3UsmIdentity(new Uint8Array(packet));
  if (identity.username !== profile.username) {
    throw new Error("SNMPv3 profile username mismatch");
  }
  if (normalizeEngineIdHex(identity.engineId) !== profile.engineIdHex.toLowerCase()) {
    throw new Error("SNMPv3 profile engine ID mismatch");
  }
  // F-037: consult the per-profile TTL cache BEFORE the vault — a packet
  // storm for one persona must cost one vault round-trip per TTL, not one
  // per datagram.
  const secret = await resolveSnmpV3ProfileSecret(profile);
  const decoded = decodeSnmpV3Trap(
    new Uint8Array(packet),
    {
      engineId: identity.engineId,
      username: profile.username,
      secret,
    },
  );
  const notification = decoded.varBinds.find(
    (varBind) => varBind.oid === "1.3.6.1.6.3.1.1.4.1.0",
  );
  return {
    collectorId: process.env.FAYANMS_PROTOCOL_COLLECTOR_ID?.trim() || "worker-1",
    protocol: "snmp-trap" as const,
    sourceIp: remote.address,
    sourcePort: remote.port,
    receivedAt: new Date().toISOString(),
    eventType: "SNMP_TRAP",
    severity: "INFO",
    message: "Verified SNMPv3 authPriv trap",
    protocolVersion: "SNMPV3_USM_AUTHPRIV",
    securityLevel: "authPriv" as const,
    deviceHint: {
      hostname: profile.hostname,
      credentialProfileId: profile.credentialProfileId,
    },
    attributes: {
      requestId: decoded.requestId,
      engineId: Buffer.from(decoded.engineId).toString("hex").slice(0, 64),
      varBindCount: decoded.varBinds.length,
      notificationOid:
        typeof notification?.value === "string" ? notification.value : null,
    },
  };
}

export function getProtocolCollectorMetrics(): ProtocolCollectorMetrics {
  return {
    ...metrics,
    // F-037: derived live — enabled alone is not liveness; a bind failure
    // must surface as collector_up 0.
    up:
      metrics.enabled &&
      metrics.sockets > 0 &&
      metrics.boundSockets === metrics.sockets &&
      metrics.bindFailures === 0,
  };
}

export function startProtocolCollector(): { stop: () => void } | null {
  if (process.env.FAYANMS_PROTOCOL_COLLECTOR_ENABLED?.trim().toLowerCase() !== "true") {
    return null;
  }
  const host = process.env.FAYANMS_PROTOCOL_COLLECTOR_BIND?.trim() || "127.0.0.1";
  const protocols = PROTOCOLS.filter(
    (protocol) => process.env[envKey(protocol, "_DISABLED")]?.trim().toLowerCase() !== "true",
  );
  const sockets: Socket[] = [];
  metrics = { ...metrics, enabled: true, sockets: 0, boundSockets: 0, bindFailures: 0 };

  const relayDelayMs = (attempt: number) =>
    Math.min(5_000, RELAY_BACKOFF_BASE_MS * 2 ** attempt);

  const drainRelays = async (): Promise<void> => {
    if (relayDraining) return;
    relayDraining = true;
    try {
      while (relayQueue.length > 0) {
        const item = relayQueue.shift();
        metrics.relayQueueDepth = relayQueue.length;
        if (!item) continue;
        activeRelays += 1;
        try {
          await nextPost("/api/v1/ingest/protocol", item.event, 5_000);
          metrics.packetsAccepted += 1;
        } catch {
          const nextAttempt = item.attempt + 1;
          if (nextAttempt < MAX_RELAY_ATTEMPTS) {
            metrics.relayRetries += 1;
            relayQueue.push({ ...item, attempt: nextAttempt });
            metrics.relayQueueDepth = relayQueue.length;
            await new Promise((resolve) => setTimeout(resolve, relayDelayMs(nextAttempt)));
          } else {
            metrics.relayFailures += 1;
            metrics.relayDeadLetters += 1;
          }
        } finally {
          activeRelays -= 1;
        }
      }
    } finally {
      relayDraining = false;
      metrics.relayQueueDepth = relayQueue.length;
    }
  };

  const relay = (event: Record<string, unknown>) => {
    if (relayQueue.length >= MAX_PENDING_RELAYS) {
      metrics.queueDrops += 1;
      return;
    }
    relayQueue.push({ event, attempt: 0 });
    metrics.relayQueueDepth = relayQueue.length;
    void drainRelays();
  };

  const verifyAndRelaySnmpTrap = async (packet: Buffer, remote: RemoteInfo) => {
    if (activeRelays + activeVerifications >= MAX_IN_FLIGHT) {
      metrics.queueDrops += 1;
      return;
    }
    activeVerifications += 1;
    try {
      const identity = readSnmpV3UsmIdentity(new Uint8Array(packet));
      const profileResult = await nextPost(
        "/api/v1/ingest/protocol/snmpv3-profile",
        {
          sourceIp: remote.address,
          username: identity.username,
          engineId: Buffer.from(identity.engineId).toString("hex"),
        },
        5_000,
      );
      if (
        !profileResult ||
        typeof profileResult !== "object" ||
        !("profile" in profileResult) ||
        !profileResult.profile ||
        typeof profileResult.profile !== "object"
      ) {
        throw new Error("SNMPv3 profile lookup returned no profile");
      }
      const profile = profileResult.profile as Partial<SnmpV3ProfileReference>;
      if (
        typeof profile.credentialProfileId !== "string" ||
        typeof profile.hostname !== "string" ||
        typeof profile.username !== "string" ||
        typeof profile.secretRef !== "string" ||
        typeof profile.engineIdHex !== "string"
      ) {
        throw new Error("SNMPv3 profile lookup returned an invalid profile");
      }
      const event = await decodeVerifiedSnmpV3Trap(packet, remote, {
        credentialProfileId: profile.credentialProfileId,
        hostname: profile.hostname,
        username: profile.username,
        secretRef: profile.secretRef,
        engineIdHex: profile.engineIdHex.toLowerCase(),
      });
      await nextPost(
        "/api/v1/ingest/protocol/snmpv3-profile/accept",
        {
          sourceIp: remote.address,
          username: identity.username,
          credentialProfileId: profile.credentialProfileId,
          engineIdHex: Buffer.from(identity.engineId).toString("hex"),
          boots: identity.boots,
          time: identity.time,
        },
        5_000,
      );
      relay(event);
    } catch {
      // Fail closed. Error messages never include packet bytes or secrets.
      metrics.packetsRejected += 1;
    } finally {
      activeVerifications -= 1;
    }
  };

  for (const protocol of protocols) {
    const socket = createSocket("udp4");
    socket.on("message", (packet, remote) => {
      metrics.packetsReceived += 1;
      if (protocol === "snmp-trap") {
        void verifyAndRelaySnmpTrap(packet, remote);
        return;
      }
      const event = decodeProtocolPacket(protocol, packet, remote);
      if (!event) {
        metrics.packetsRejected += 1;
        return;
      }
      relay(event);
    });
    // F-037: a pre-bind 'error' is a BIND failure (dgram reports EADDRINUSE
    // and friends through the error event; the bind callback only runs on
    // success) — it must surface in the up metric, not vanish into
    // relayFailures while collector_up keeps reporting 1.
    let bound = false;
    const port = portFor(protocol);
    socket.on("error", (error) => {
      if (!bound) {
        metrics.bindFailures += 1;
        void log(
          "protocol collector " + protocol + " bind failed on " + host + ":" + port + ": " + error.message,
        );
        return;
      }
      metrics.relayFailures += 1;
      void log("protocol collector " + protocol + " socket error: " + error.message);
    });
    socket.bind(port, host, () => {
      bound = true;
      metrics.boundSockets += 1;
    });
    sockets.push(socket);
  }
  metrics.sockets = sockets.length;
  void log("protocol collector enabled on " + host + " for " + protocols.join(","));
  return {
    stop: () => {
      for (const socket of sockets) socket.close();
      metrics.sockets = 0;
      metrics.enabled = false;
      metrics.boundSockets = 0;
      metrics.bindFailures = 0;
      // Resolved secret VALUES must not outlive the collector (F-037 rig note).
      resetSnmpV3SecretCache();
    },
  };
}
