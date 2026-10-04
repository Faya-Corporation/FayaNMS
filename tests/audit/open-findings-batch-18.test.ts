/**
 * Open-findings batch 18 — F-048 (P3, A3-12, BACKLOG order):
 * protocol ingest had no idempotency key, so collector retries duplicated
 * queue rows and FlowRecords.
 *
 *   Collector delivery is at-least-once: a relay that retries after a lost
 *   202 re-POSTs the same event. Every accepted POST minted a fresh
 *   `newCorrelationId("NET")` and inserted a new ProtocolEventQueue row, so
 *   the drain persisted the same flows under a different queueId — duplicate
 *   FlowRecords double-counting bytes/talkers in flow analytics, plus
 *   duplicate audit rows. No dedupe window existed on (collectorId,
 *   flowSequence, receivedAt).
 *
 *   The closure (the BACKLOG plan, no schema change): the ingest payload
 *   accepts an optional bounded client `idempotencyKey` (1–128 chars,
 *   `[A-Za-z0-9._:-]`); a NetFlow v5 event without one derives the key from
 *   the datagram header (collectorId + sourceIp:sourcePort + flowSequence +
 *   unixSeconds + unixNanoseconds) — stable across collector retries because
 *   a retransmitted datagram decodes to the same header, while every new
 *   batch differs (exporters increment flowSequence). The key maps
 *   deterministically onto the queue row's correlationId, so the ingest
 *   transaction preflights a LIVE prior row (QUEUED/IN_FLIGHT/DELIVERED) by
 *   (collectorId, correlationId) — with NO new column or unique index. The
 *   check-then-insert is made race-safe by a transaction-scoped Postgres
 *   advisory lock (the established F-052 convention): a concurrent
 *   double-submit blocks until the first transaction commits, then observes
 *   the committed row. A retry that hits a live prior row is answered 200
 *   with `duplicate: true` and the ORIGINAL attempt's identifiers and writes
 *   no new queue row, audit row, or FlowRecord. The dedupe WINDOW is the
 *   lifetime of the original queue row (DELIVERED rows pruned by
 *   `protocolQueue.retention`, default 7 delivered days; a DEAD prior
 *   attempt releases the key so a retry re-queues). Outside the window — or
 *   with no key and no derivable NetFlow header — every accepted POST queues
 *   a new row exactly as before (documented at-least-once semantics).
 *
 *   Rig notes: the live pins run against the shared dev Postgres with a
 *   synthetic collector id and delete every row they create (beforeAll +
 *   afterAll); the background worker may drain the test rows concurrently,
 *   which is why the FlowRecord pin asserts that retries never attach
 *   records to a NEW queueId (timing-proof) instead of exact counts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { resolveProtocolIdempotency } from "../../src/lib/protocol/ingest";
import type { NetFlowV5Batch } from "../../src/lib/protocol/netflow-v5";

/*
 * Env discipline (batch-14 boot-path precedent): the suite mints its own
 * Ed25519 service identity IN-PROCESS instead of trusting the ambient .env
 * keypair, so the telemetry tokens mint + verify self-consistently in any
 * environment. The ambient values are restored afterAll.
 */
const serviceKeypair = generateKeyPairSync("ed25519");
const SERVICE_PUBLIC_SPKI = serviceKeypair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const SERVICE_PRIVATE_PKCS8 = serviceKeypair.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const SAVED_SERVICE_PRIVATE_KEY = process.env.FAYANMS_SERVICE_PRIVATE_KEY;
const SAVED_SERVICE_PUBLIC_KEYS = process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
process.env.FAYANMS_SERVICE_PRIVATE_KEY = SERVICE_PRIVATE_PKCS8;
process.env.FAYANMS_SERVICE_PUBLIC_KEYS = SERVICE_PUBLIC_SPKI;

const COLLECTOR = "f048-idem-collector";
const RECEIVED_AT = "2026-10-01T12:00:00.000Z";
const AUTH = {
  Authorization: `Bearer ${mintServiceToken({
    issuer: "fayanms:worker",
    subject: "worker:f048-idem-test",
    scopes: ["telemetry"],
  })}`,
};

const { POST } = await import("../../src/app/api/v1/ingest/protocol/route");

function postIngest(payload: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/v1/ingest/protocol", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

function syslogEvent(idempotencyKey?: string) {
  return {
    collectorId: COLLECTOR,
    protocol: "syslog",
    sourceIp: "192.0.2.48",
    sourcePort: 5514,
    receivedAt: RECEIVED_AT,
    eventType: "SYSLOG_MESSAGE",
    severity: "info",
    message: "F-048 idempotency probe",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function flowBatchFixture(sequence = 4_000_000_048): NetFlowV5Batch {
  return {
    header: {
      count: 1,
      systemUptimeMs: 4_000_000_001,
      unixSeconds: 1_758_412_800,
      unixNanoseconds: 123,
      flowSequence: sequence,
      engineType: 1,
      engineId: 2,
      samplingMode: 2,
      samplingInterval: 100,
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

function netflowEvent(sequence: number, receivedAt = RECEIVED_AT) {
  return {
    collectorId: COLLECTOR,
    protocol: "netflow",
    protocolVersion: "NETFLOW_V5",
    sourceIp: "192.0.2.48",
    sourcePort: 2055,
    receivedAt,
    eventType: "FLOW_RECORD_BATCH",
    severity: "info",
    message: "F-048 netflow probe",
    flowBatch: flowBatchFixture(sequence),
  };
}

async function queueRowCounts(correlationId: string) {
  return db.protocolEventQueue.count({ where: { collectorId: COLLECTOR, correlationId } });
}

beforeAll(async () => {
  await db.protocolEventQueue.deleteMany({ where: { collectorId: COLLECTOR } });
});

afterAll(async () => {
  if (SAVED_SERVICE_PRIVATE_KEY === undefined) delete process.env.FAYANMS_SERVICE_PRIVATE_KEY;
  else process.env.FAYANMS_SERVICE_PRIVATE_KEY = SAVED_SERVICE_PRIVATE_KEY;
  if (SAVED_SERVICE_PUBLIC_KEYS === undefined) delete process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
  else process.env.FAYANMS_SERVICE_PUBLIC_KEYS = SAVED_SERVICE_PUBLIC_KEYS;
  await db.protocolEventQueue.deleteMany({ where: { collectorId: COLLECTOR } });
});

describe("F-048 live ingest idempotency (DB)", () => {
  test("a retried POST with the same client key is answered from the ORIGINAL attempt", async () => {
    // The correlation id is deterministic, so audit rows from PREVIOUS runs of
    // this suite may exist — all assertions are deltas against this run.
    const preKey = syslogEvent("f048.retry-key-1");
    const derivedCorrelation = resolveProtocolIdempotency({
      collectorId: COLLECTOR,
      idempotencyKey: "f048.retry-key-1",
      protocol: "syslog",
      sourceIp: "192.0.2.48",
      sourcePort: 5514,
    })!.correlationId;
    const auditCount = () =>
      db.auditEvent.count({
        where: { action: "PROTOCOL_EVENT_QUEUED", correlationId: derivedCorrelation },
      });
    const auditsBefore = await auditCount();

    const first = await postIngest(preKey);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()).data;
    expect(firstBody).toMatchObject({ accepted: true, queued: true, duplicate: false });

    const retry = await postIngest(syslogEvent("f048.retry-key-1"));
    // Idempotent 2xx duplicate receipt — a naive retry loop stops retrying.
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()).data;
    expect(retryBody).toMatchObject({ accepted: true, queued: false, duplicate: true });
    expect(retryBody.queueId).toBe(firstBody.queueId);
    expect(retryBody.correlationId).toBe(firstBody.correlationId);

    // Exactly ONE queue row exists for the attempt, and the retry added ZERO
    // audit rows (the finding's duplicate-row/duplicate-audit harm).
    expect(await queueRowCounts(firstBody.correlationId)).toBe(1);
    expect(await auditCount()).toBe(auditsBefore + 1);
  });

  test("different keys are independent events — both ingested", async () => {
    const a = await (await postIngest(syslogEvent("f048.retry-key-2"))).json();
    const b = await (await postIngest(syslogEvent("f048.retry-key-3"))).json();
    expect(a.data.queueId).not.toBe(b.data.queueId);
    expect(a.data.correlationId).not.toBe(b.data.correlationId);
    expect(await queueRowCounts(a.data.correlationId)).toBe(1);
    expect(await queueRowCounts(b.data.correlationId)).toBe(1);
  });

  test("absent key keeps the legacy at-least-once behavior unchanged", async () => {
    // Identical payloads, NO key: every POST still queues its own row with a
    // fresh random correlation id — the pre- F-048 contract, untouched.
    const first = await postIngest(syslogEvent());
    expect(first.status).toBe(202);
    const firstBody = (await first.json()).data;
    expect(firstBody).toMatchObject({ queued: true, duplicate: false });
    const second = await postIngest(syslogEvent());
    expect(second.status).toBe(202);
    const secondBody = (await second.json()).data;
    expect(secondBody).toMatchObject({ queued: true, duplicate: false });
    expect(secondBody.correlationId).not.toBe(firstBody.correlationId);
    expect(secondBody.queueId).not.toBe(firstBody.queueId);
  });

  test("the client key is zod-bounded (1–128 chars, restricted charset)", async () => {
    const tooLong = await postIngest(syslogEvent("k".repeat(129)));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error.code).toBe("INVALID_BODY");
    const badCharset = await postIngest(syslogEvent("bad key!"));
    expect(badCharset.status).toBe(400);
    // Boundary: exactly 128 chars is accepted.
    const boundary = await postIngest(syslogEvent("k".repeat(128)));
    expect(boundary.status).toBe(202);
  });

  test("a concurrent double-submit cannot create duplicates (advisory-locked preflight inside the tx)", async () => {
    const [a, b] = await Promise.all([
      postIngest(syslogEvent("f048.race-key-1")),
      postIngest(syslogEvent("f048.race-key-1")),
    ]);
    const aBody = (await a.json()).data;
    const bBody = (await b.json()).data;
    // Exactly one 202 (queued) and one 200 (duplicate receipt) — the advisory
    // lock serializes the two transactions, so the loser's in-tx preflight
    // observes the winner's committed row instead of inserting a second one.
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const winner = a.status === 202 ? aBody : bBody;
    const loser = a.status === 202 ? bBody : aBody;
    expect(winner.queued).toBe(true);
    expect(loser.duplicate).toBe(true);
    expect(loser.queueId).toBe(winner.queueId);
    expect(loser.correlationId).toBe(winner.correlationId);
    expect(await queueRowCounts(winner.correlationId)).toBe(1);
  });

  test("NetFlow v5 without a client key dedupes on the derived header key", async () => {
    const first = await postIngest(netflowEvent(4_000_000_048));
    expect(first.status).toBe(202);
    const firstBody = (await first.json()).data;
    // The response correlation id IS the documented derived identity.
    expect(firstBody.correlationId).toBe(
      resolveProtocolIdempotency({
        collectorId: COLLECTOR,
        protocol: "netflow",
        protocolVersion: "NETFLOW_V5",
        sourceIp: "192.0.2.48",
        sourcePort: 2055,
        flowBatch: flowBatchFixture(4_000_000_048),
      })?.correlationId,
    );
    // A collector retry re-POSTs the same datagram (receivedAt may differ) —
    // still the same derived identity → duplicate receipt, original queueId.
    const retry = await postIngest(netflowEvent(4_000_000_048, "2026-10-01T12:00:05.000Z"));
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()).data;
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.queueId).toBe(firstBody.queueId);
    // A genuinely new batch (flowSequence incremented) is a new event.
    const next = await postIngest(netflowEvent(4_000_000_049));
    expect(next.status).toBe(202);
    const nextBody = (await next.json()).data;
    expect(nextBody.duplicate).toBe(false);
    expect(nextBody.correlationId).not.toBe(firstBody.correlationId);
  });

  test("retries never attach FlowRecords to a NEW queue row (no double-counted flows)", async () => {
    const original = await (await postIngest(netflowEvent(4_000_000_050))).json();
    await postIngest(netflowEvent(4_000_000_050, "2026-10-01T12:00:10.000Z"));
    await postIngest(netflowEvent(4_000_000_050, "2026-10-01T12:00:15.000Z"));
    // Whatever the concurrent worker drain has persisted so far, every
    // FlowRecord correlated to this datagram belongs to the ORIGINAL queue
    // row — a retry never mints a second queueId, so flow analytics cannot
    // double-count bytes/talkers (the finding's harm). Timing-proof: records
    // for the original row may exist or not, but never under another queueId.
    const records = await db.flowRecord.findMany({
      where: { queue: { collectorId: COLLECTOR, correlationId: original.data.correlationId } },
      select: { queueId: true },
    });
    expect(new Set(records.map((r) => r.queueId)).size).toBeLessThanOrEqual(1);
    for (const record of records) expect(record.queueId).toBe(original.data.queueId);
    expect(await queueRowCounts(original.data.correlationId)).toBe(1);
  });

  test("a DEAD prior attempt releases the key — the retry re-queues (at-least-once for failures)", async () => {
    const key = "f048.dead-key-1";
    const derived = resolveProtocolIdempotency({
      collectorId: COLLECTOR,
      idempotencyKey: key,
      protocol: "syslog",
      sourceIp: "192.0.2.48",
      sourcePort: 5514,
    });
    expect(derived).not.toBeNull();
    await db.protocolEventQueue.create({
      data: {
        collectorId: COLLECTOR,
        protocol: "syslog",
        sourceIp: "192.0.2.48",
        sourcePort: 5514,
        receivedAt: new Date(RECEIVED_AT),
        eventType: "SYSLOG_MESSAGE",
        severity: "info",
        message: "F-048 dead prior attempt",
        attributesJson: "{}",
        correlationId: derived!.correlationId,
        status: "DEAD",
      },
    });
    const retry = await postIngest(syslogEvent(key));
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()).data;
    expect(retryBody).toMatchObject({ queued: true, duplicate: false });
    // Two rows share the derived identity: the seeded DEAD row (excluded by
    // the live-status preflight filter) plus the fresh QUEUED retry row.
    expect(await queueRowCounts(derived!.correlationId)).toBe(2);
  });
});

/* ── F-048 source contracts (no-schema-change dedupe, drain skipDuplicates) ─ */

describe("F-048 source contracts", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  const drain = readFileSync("src/app/api/v1/worker/protocol-events/drain/route.ts", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const collector = readFileSync("mini-services/worker/protocol-collector.ts", "utf8");
  const netflowRunbook = readFileSync("docs/runbooks/netflow-v5.md", "utf8");
  const networkLab = readFileSync("docs/runbooks/network-lab.md", "utf8");

  test("the preflight is INSIDE the ingest transaction under the advisory lock (race-safe)", () => {
    const txStart = route.indexOf("db.$transaction(async (tx) => {");
    const txEnd = route.indexOf("if (queued.kind === \"duplicate\")");
    const lock = route.indexOf("pg_advisory_xact_lock");
    const preflight = route.indexOf("tx.protocolEventQueue.findFirst");
    expect(txStart).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(txStart);
    expect(preflight).toBeGreaterThan(lock);
    expect(txEnd).toBeGreaterThan(preflight);
    // The F-052 Postgres advisory-lock convention (blocking xact variant).
    expect(route).toContain("pg_advisory_xact_lock(hashtextextended(");
    // Same convention as the F-052 tick enqueues (established in-repo pattern).
    expect(route).toContain("F-052");
  });

  test("the dedupe match is collector-scoped and live-status-filtered (window semantics)", () => {
    expect(route).toContain("collectorId: event.collectorId");
    expect(route).toContain('status: { in: ["QUEUED", "IN_FLIGHT", "DELIVERED"] }');
    // DEAD is deliberately absent from the live set — a dead-lettered prior
    // attempt releases the key so the retry re-queues (at-least-once).
    expect(route).not.toContain('"DEAD"]');
  });

  test("first delivery stays at-least-once (202) and duplicates answer the documented receipt", () => {
    expect(route).toContain("duplicate: true");
    expect(route).toContain("duplicate: false");
    expect(route).toContain("undefined, 202");
    expect(route).toContain("undefined, 200");
    // The receipt returns the ORIGINAL attempt's identifiers.
    expect(route).toContain("queueId: queued.duplicate.id");
    expect(route).toContain("correlationId: queued.duplicate.correlationId");
  });

  test("the drain keeps skipDuplicates across FlowRecord rows (lease-recovery re-delivery never duplicates)", () => {
    expect(drain).toContain("tx.flowRecord.createMany({ data: records, skipDuplicates: true })");
    // And the dedupe target that makes skipDuplicates meaningful:
    expect(schema).toContain("@@unique([queueId, recordIndex])");
  });

  test("the in-repo collector relay re-POSTs the same payload, so NetFlow relays auto-dedupe", () => {
    expect(collector).toContain('nextPost("/api/v1/ingest/protocol", item.event, 5_000)');
  });

  test("the collector API docs document the window and key semantics", () => {
    expect(netflowRunbook).toContain("## Idempotency (F-048)");
    expect(netflowRunbook).toContain("idempotencyKey");
    expect(netflowRunbook).toContain("duplicate: true");
    expect(netflowRunbook).toContain("protocolQueue.retention");
    expect(netflowRunbook).toContain("7 delivered days");
    expect(netflowRunbook).toContain("at-least-once");
    expect(networkLab).toContain("F-048");
    // The API contract itself carries the window (route docstring).
    expect(route).toContain("dedupe window");
    expect(route).toContain("protocolQueue.retention");
  });

  test("no schema change was needed (the dedupe rides the existing correlationId column)", () => {
    expect(schema).toContain("@@index([correlationId])");
    // No new idempotency column/index was introduced on the queue model.
    expect(schema).not.toContain("idempotencyKey");
    expect(schema).not.toContain("dedupeKey");
  });
});
