import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  associateProtocolDevice,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  normalizeProtocolEvent,
  resolveProtocolIdempotency,
  validateProtocolIngestPolicy,
} from "../src/lib/protocol/ingest";
import type { NetFlowV5Batch } from "../src/lib/protocol/netflow-v5";

test("protocol normalization bounds messages and attributes", () => {
  const event = normalizeProtocolEvent({
    collectorId: "collector-a",
    protocol: "syslog",
    sourceIp: "192.0.2.20",
    sourcePort: 5514,
    receivedAt: new Date("2026-09-21T00:00:00.000Z"),
    eventType: "SYSLOG_MESSAGE",
    severity: "info",
    message: "x".repeat(9000),
    attributes: { keep: "y".repeat(900), drop: Number.NaN },
  });
  expect(event.message.length).toBe(2048);
  expect(event.attributes.keep).toBe("y".repeat(256));
  expect(event.attributes.drop).toBeNull();
});

test("protocol association: the SOURCE IP is the trust anchor (F-036 flip)", () => {
  // FLIPPED DELIBERATELY (batch-11): this test previously pinned the DEFECT
  // ("prefers hostname over source IP") — a spoofed hostname hint could
  // re-attribute any event. The source IP now wins outright.
  const candidates = [
    { id: "by-host", hostname: "router-a", mgmtIp: "192.0.2.21" },
    { id: "by-ip", hostname: "router-b", mgmtIp: "192.0.2.20" },
  ];
  const result = associateProtocolDevice(
    { sourceIp: "192.0.2.20", deviceHint: { hostname: "router-a" } },
    candidates,
  );
  expect(result.method).toBe("management-ip");
  expect(result.device?.id).toBe("by-ip");
  // The contradicted hostname claim is flagged (spoof indicator).
  expect(result.attributionUnverified).toBe(true);
});

test("protocol association: hostname agreeing with the source resolves verified", () => {
  const candidates = [{ id: "device-a", hostname: "router-a", mgmtIp: "192.0.2.20" }];
  const result = associateProtocolDevice(
    { sourceIp: "192.0.2.20", deviceHint: { hostname: "router-a" } },
    candidates,
  );
  expect(result.method).toBe("management-ip");
  expect(result.device?.id).toBe("device-a");
  expect(result.attributionUnverified).toBeUndefined();
});

test("protocol association: hostname-only attribution is honored but flagged unverified", () => {
  const candidates = [{ id: "device-a", hostname: "router-a", mgmtIp: "192.0.2.21" }];
  const result = associateProtocolDevice(
    { sourceIp: "192.0.2.99", deviceHint: { hostname: "router-a" } },
    candidates,
  );
  expect(result.method).toBe("hostname");
  expect(result.device?.id).toBe("device-a");
  expect(result.attributionUnverified).toBe(true);
});

test("protocol association: IP-only attribution (no hint) is verified with no flag", () => {
  const candidates = [{ id: "device-a", hostname: "router-a", mgmtIp: "192.0.2.20" }];
  const result = associateProtocolDevice(
    { sourceIp: "192.0.2.20", deviceHint: undefined },
    candidates,
  );
  expect(result.method).toBe("management-ip");
  expect(result.attributionUnverified).toBeUndefined();
  expect(associateProtocolDevice({ sourceIp: "10.9.9.9", deviceHint: undefined }, candidates)).toEqual({
    device: null,
    method: "unmatched",
  });
});

test("ingest route persists attributionUnverified and documents the IP-anchor contract (F-036)", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  expect(route).toContain("attributionUnverified: association.attributionUnverified ?? false");
  expect(route).toContain("unverified: association.attributionUnverified ?? false");
  // The retired "exact hostname first" claim must not come back.
  expect(route).not.toContain("exact hostname first");
  expect(route).toContain("SOURCE IP is the trust anchor");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  expect(schema).toContain("attributionUnverified");
});

test("ingestion route requires telemetry scope and stores no raw packet field", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  expect(route).toContain('authenticateServiceRequest(request, "telemetry")');
  expect(route).toContain("PROTOCOL_EVENT_QUEUED");
  expect(route).toContain("protocolEventQueue.create");
  expect(route).not.toContain("payloadBase64");
  expect(route).not.toContain("secretValue");
  const drainRoute = readFileSync("src/app/api/v1/worker/protocol-events/drain/route.ts", "utf8");
  expect(drainRoute).toContain("PROTOCOL_EVENT_DEAD_LETTERED");
  expect(drainRoute).toContain("status: { in: [\"QUEUED\", \"IN_FLIGHT\"] }");

  const profileRoute = readFileSync("src/app/api/v1/ingest/protocol/snmpv3-profile/route.ts", "utf8");
  expect(profileRoute).toContain('authenticateServiceRequest(request, "telemetry")');
  expect(profileRoute).toContain("secretRef");
  expect(profileRoute).not.toContain("secretValue");
  const deviceRoute = readFileSync("src/app/api/v1/devices/[id]/route.ts", "utf8");
  expect(deviceRoute).toContain("snmpEngineIdHex");
  expect(deviceRoute).toContain("snmpEngineBoots = null");
  const acceptRoute = readFileSync("src/app/api/v1/ingest/protocol/snmpv3-profile/accept/route.ts", "utf8");
  expect(acceptRoute).toContain('authenticateServiceRequest(request, "telemetry")');
  expect(acceptRoute).toContain("SNMP_REPLAY_RACE");
});

test("SNMP policy requires verified authPriv and a device-bound SNMPV3 profile", () => {
  const association = {
    device: { id: "device-a", hostname: "router-a", mgmtIp: "192.0.2.20" },
    method: "hostname" as const,
  };
  expect(
    validateProtocolIngestPolicy(
      { protocol: "snmp-trap", securityLevel: "unknown", deviceHint: { credentialProfileId: "profile-a" } },
      association,
      { id: "profile-a", type: "SNMPV3", deviceId: "device-a" },
    ),
  ).toMatchObject({ ok: false, code: "SNMP_AUTHPRIV_REQUIRED" });
  expect(
    validateProtocolIngestPolicy(
      { protocol: "snmp-trap", securityLevel: "authPriv", deviceHint: { credentialProfileId: "profile-a" } },
      association,
      { id: "profile-a", type: "SSH_PASSWORD", deviceId: "device-a" },
    ),
  ).toMatchObject({ ok: false, code: "SNMP_PROFILE_MISMATCH" });
  expect(
    validateProtocolIngestPolicy(
      { protocol: "snmp-trap", securityLevel: "authPriv", deviceHint: { credentialProfileId: "profile-a" } },
      association,
      { id: "profile-a", type: "SNMPV3", deviceId: "device-a" },
    ),
  ).toEqual({ ok: true });
});

/* ── F-048 (batch-18): ingest idempotency ─────────────────────────────────── */

function flowBatchFixture(overrides: Partial<NetFlowV5Batch["header"]> = {}): NetFlowV5Batch {
  return {
    header: {
      count: 1,
      systemUptimeMs: 4_000_000_001,
      unixSeconds: 1_758_412_800,
      unixNanoseconds: 123,
      flowSequence: 4_000_000_002,
      engineType: 1,
      engineId: 2,
      samplingMode: 2,
      samplingInterval: 100,
      ...overrides,
    },
    records: [{
      sourceIp: "192.0.2.1",
      destinationIp: "198.51.100.2",
      nextHopIp: "203.0.113.1",
      inputIfIndex: 7,
      outputIfIndex: 8,
      packets: "4000000001",
      octets: "4000000002",
      firstUptimeMs: "4000000003",
      lastUptimeMs: "4000000004",
      sourcePort: 443,
      destinationPort: 52000,
      tcpFlags: 18,
      protocol: 6,
      tos: 0,
      sourceAs: 64512,
      destinationAs: 64513,
      sourceMask: 24,
      destinationMask: 24,
    }],
  };
}

test("F-048: a client idempotency key maps deterministically to one correlation id", () => {
  const first = resolveProtocolIdempotency({
    collectorId: "collector-a",
    idempotencyKey: "retry-key-1",
    protocol: "syslog",
    sourceIp: "192.0.2.20",
    sourcePort: 5514,
  });
  const second = resolveProtocolIdempotency({
    collectorId: "collector-a",
    idempotencyKey: "retry-key-1",
    protocol: "syslog",
    sourceIp: "192.0.2.20",
    sourcePort: 5514,
  });
  expect(first).toMatchObject({ mode: "client" });
  expect(first?.correlationId).toBe(second?.correlationId);
  // Keys scope per collector and per value: different collector or key →
  // a different identity, so neither dedupes against the other.
  expect(
    resolveProtocolIdempotency({
      collectorId: "collector-a",
      idempotencyKey: "retry-key-2",
      protocol: "syslog",
      sourceIp: "192.0.2.20",
      sourcePort: 5514,
    })?.correlationId,
  ).not.toBe(first?.correlationId);
  expect(
    resolveProtocolIdempotency({
      collectorId: "collector-b",
      idempotencyKey: "retry-key-1",
      protocol: "syslog",
      sourceIp: "192.0.2.20",
      sourcePort: 5514,
    })?.correlationId,
  ).not.toBe(first?.correlationId);
});

test("F-048: NetFlow v5 without a client key derives the key from the datagram header", () => {
  const input = {
    collectorId: "worker-1",
    protocol: "netflow" as const,
    protocolVersion: "NETFLOW_V5",
    sourceIp: "192.0.2.30",
    sourcePort: 2055,
  };
  const first = resolveProtocolIdempotency({ ...input, flowBatch: flowBatchFixture() });
  // A collector retry re-encodes the SAME datagram (receivedAt may differ) —
  // the derived identity must be stable because only header fields feed it.
  const retry = resolveProtocolIdempotency({
    ...input,
    flowBatch: flowBatchFixture(),
  });
  expect(first).toMatchObject({ mode: "derived" });
  expect(first?.correlationId).toBe(retry?.correlationId);
  // A genuinely new batch differs: flowSequence increments per datagram.
  expect(
    resolveProtocolIdempotency({
      ...input,
      flowBatch: flowBatchFixture({ flowSequence: 4_000_000_003 }),
    })?.correlationId,
  ).not.toBe(first?.correlationId);
  // A different exporter peer is a different identity (never deduped together).
  expect(
    resolveProtocolIdempotency({
      ...input,
      sourceIp: "192.0.2.31",
      flowBatch: flowBatchFixture(),
    })?.correlationId,
  ).not.toBe(first?.correlationId);
  // A client key, when supplied, wins over the derivation.
  expect(
    resolveProtocolIdempotency({
      ...input,
      idempotencyKey: "explicit-key",
      flowBatch: flowBatchFixture(),
    }),
  ).toMatchObject({ mode: "client" });
});

test("F-048: events with no key and no derivable NetFlow header stay at-least-once", () => {
  expect(
    resolveProtocolIdempotency({
      collectorId: "collector-a",
      protocol: "syslog",
      sourceIp: "192.0.2.20",
      sourcePort: 5514,
    }),
  ).toBeNull();
  expect(
    resolveProtocolIdempotency({
      collectorId: "collector-a",
      protocol: "snmp-trap",
      sourceIp: "192.0.2.20",
      sourcePort: 1162,
    }),
  ).toBeNull();
  // NetFlow v5 WITHOUT a decoded batch (v9/IPFIX/sFlow metadata relays) has
  // no header identity to derive from — legacy behavior, null.
  expect(
    resolveProtocolIdempotency({
      collectorId: "collector-a",
      protocol: "netflow",
      protocolVersion: "NETFLOW_V9",
      sourceIp: "192.0.2.20",
      sourcePort: 2055,
    }),
  ).toBeNull();
});

test("F-048: the ingest route preflights a live prior row INSIDE the transaction under the advisory lock", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  // The lock + preflight live inside db.$transaction (race-safe), not around it.
  const txStart = route.indexOf("db.$transaction(async (tx) => {");
  const lock = route.indexOf("pg_advisory_xact_lock");
  const preflight = route.indexOf("tx.protocolEventQueue.findFirst");
  expect(txStart).toBeGreaterThan(-1);
  expect(lock).toBeGreaterThan(txStart);
  expect(preflight).toBeGreaterThan(lock);
  // The dedupe match is scoped to the collector, the derived correlation id,
  // and LIVE statuses only — a DEAD prior attempt releases the key.
  expect(route).toContain('status: { in: ["QUEUED", "IN_FLIGHT", "DELIVERED"] }');
  expect(route).toContain("duplicate: true");
  expect(route).toContain("duplicate: false");
  // The zod bound uses the shared constant (1–128, bounded charset).
  expect(route).toContain("IDEMPOTENCY_KEY_MAX_LENGTH");
  expect(route).toContain("IDEMPOTENCY_KEY_PATTERN");
  expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  // The dedupe WINDOW is documented on the API contract itself.
  expect(route).toContain("dedupe window");
  expect(route).toContain("protocolQueue.retention");
});
