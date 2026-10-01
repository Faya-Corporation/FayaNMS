/**
 * RT-003 / F-003 — ProtocolEventQueue retention sweep.
 *
 * Every accepted protocol event inserts a queue row; delivery/dead-lettering
 * only flips its status. No `protocolEventQueue.deleteMany` existed anywhere,
 * so DELIVERED and DEAD rows grew forever (claim scans, queueDepth counts and
 * disk degrade monotonically on any deployment that accepts real telemetry).
 *
 * CRITICAL GUARD: FlowRecord.queueId is onDelete: Cascade — a naive queue
 * prune would cascade-delete live flow analytics. The sweep therefore only
 * deletes terminal rows that have NO FlowRecord reference; flow retention
 * (FLOW_RETENTION) reclaims the FlowRecords first and the queue rows follow
 * on a later sweep.
 *
 * The chunked, status-guarded sweep lives in
 * src/lib/protocol/queue-retention.ts (pruneProtocolEventQueue) — the same
 * engine-in-lib shape as runRollupAggregation — so these tests can exercise
 * repeated runs directly; the route adds the dual gate + 60 s throttle
 * (pinned by source contracts + the 401/429 route tests below).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import {
  DEFAULT_PROTOCOL_QUEUE_RETENTION,
  PROTOCOL_QUEUE_CHUNK_SIZE,
  PROTOCOL_QUEUE_MAX_DELETES_PER_RUN,
  PROTOCOL_QUEUE_RETENTION_KEY,
  isProtocolQueueRowExpired,
  parseStoredProtocolQueueRetention,
  pruneProtocolEventQueue,
} from "../../src/lib/protocol/queue-retention";

const DAY_MS = 86_400_000;
const COLLECTOR = "queue-retention-test-collector";
const CORRELATION = "QRT-TEST-CORRELATION";

let now = new Date();

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    collectorId: COLLECTOR,
    protocol: "syslog",
    sourceIp: "192.0.2.55",
    sourcePort: 5514,
    receivedAt: new Date(now.getTime() - 8 * DAY_MS),
    eventType: "SYSLOG_MESSAGE",
    severity: "info",
    message: "queue retention sweep test row",
    attributesJson: "{}",
    correlationId: CORRELATION,
    ...overrides,
  };
}

async function seedRows(rows: Array<Record<string, unknown>>) {
  for (const row of rows) {
    await db.protocolEventQueue.create({ data: queueRow(row) });
  }
}

async function testRows() {
  return db.protocolEventQueue.findMany({ where: { correlationId: CORRELATION } });
}

async function flowRecordFor(queueId: string, index: number) {
  return db.flowRecord.create({
    data: {
      queueId,
      recordIndex: index,
      collectorId: COLLECTOR,
      exporterAddress: "192.0.2.55",
      exporterPort: 2055,
      receivedAt: new Date(now.getTime() - 8 * DAY_MS),
      exportedAt: new Date(now.getTime() - 8 * DAY_MS),
      recordCount: 1,
      systemUptimeMs: BigInt(1_000_000),
      unixSeconds: BigInt(Math.floor((now.getTime() - 8 * DAY_MS) / 1000)),
      unixNanoseconds: BigInt(0),
      flowSequence: BigInt(index + 1),
      engineType: 0,
      engineId: 0,
      samplingMode: 0,
      samplingInterval: 0,
      sourceIp: "10.0.0.1",
      destinationIp: "10.0.0.2",
      nextHopIp: "0.0.0.0",
      inputIfIndex: 1,
      outputIfIndex: 2,
      packets: BigInt(10),
      octets: BigInt(1_000),
      firstUptimeMs: BigInt(100),
      lastUptimeMs: BigInt(200),
      sourcePort: 1024,
      destinationPort: 443,
      tcpFlags: 27,
      protocol: 6,
      tos: 0,
      sourceAs: 65001,
      destinationAs: 65002,
      sourceMask: 24,
      destinationMask: 24,
    },
  });
}

beforeAll(async () => {
  now = new Date();
  await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
});

afterAll(async () => {
  await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
});

describe("queue retention sweep (DB)", () => {
  test("prunes terminal DELIVERED rows past the delivered window", async () => {
    await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
    await seedRows([
      { status: "DELIVERED", deliveredAt: new Date(now.getTime() - 8 * DAY_MS) },
      { status: "DELIVERED", deliveredAt: new Date(now.getTime() - 1 * DAY_MS) },
    ]);
    const result = await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
    expect(result.outcome).toBe("pruned");
    const remaining = await testRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deliveredAt?.getTime()).toBe(now.getTime() - 1 * DAY_MS);
  });

  test("prunes DEAD rows only past the dead window", async () => {
    await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
    await seedRows([
      { status: "DEAD", updatedAt: new Date(now.getTime() - 31 * DAY_MS) },
      { status: "DEAD", updatedAt: new Date(now.getTime() - 10 * DAY_MS) },
    ]);
    await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
    const remaining = await testRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe("DEAD");
    expect(remaining[0].updatedAt.getTime()).toBe(now.getTime() - 10 * DAY_MS);
  });

  test("never prunes QUEUED or IN_FLIGHT rows (status-guarded)", async () => {
    await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
    await seedRows([
      { status: "QUEUED", createdAt: new Date(now.getTime() - 40 * DAY_MS), updatedAt: new Date(now.getTime() - 40 * DAY_MS) },
      { status: "IN_FLIGHT", createdAt: new Date(now.getTime() - 40 * DAY_MS), updatedAt: new Date(now.getTime() - 40 * DAY_MS), lockedAt: now },
    ]);
    await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
    const remaining = await testRows();
    expect(remaining.map((r) => r.status).sort()).toEqual(["IN_FLIGHT", "QUEUED"]);
  });

  test("skips queue rows that still own FlowRecords, reclaims them afterwards", async () => {
    await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
    const seeded = await seedOne({ status: "DELIVERED", deliveredAt: new Date(now.getTime() - 8 * DAY_MS) });
    const flow = await flowRecordFor(seeded.id, 0);
    // First sweep: the row owns flow analytics → survives despite its age.
    await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
    expect(await db.protocolEventQueue.findUnique({ where: { id: seeded.id } })).not.toBeNull();
    // Flow retention reclaims the record; the next sweep reclaims the row.
    await db.flowRecord.delete({ where: { id: flow.id } });
    await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
    expect(await db.protocolEventQueue.findUnique({ where: { id: seeded.id } })).toBeNull();
  });

  test("chunking caps deletes per run and repeated runs converge", async () => {
    await db.protocolEventQueue.deleteMany({ where: { correlationId: CORRELATION } });
    const stale = new Date(now.getTime() - 8 * DAY_MS);
    const total = PROTOCOL_QUEUE_MAX_DELETES_PER_RUN + 5;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < total; i += 1) {
      rows.push({ status: "DELIVERED", deliveredAt: stale, correlationId: `${CORRELATION}-bulk` });
    }
    await db.protocolEventQueue.createMany({ data: rows.map((r) => queueRow(r)) });
    try {
      const first = await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
      expect(first.queueRowsDeleted).toBeGreaterThanOrEqual(PROTOCOL_QUEUE_MAX_DELETES_PER_RUN);
      // The cap (not the data) stopped the run — a chunk is bounded too.
      const afterFirst = await db.protocolEventQueue.count({ where: { correlationId: `${CORRELATION}-bulk` } });
      expect(afterFirst).toBe(total - PROTOCOL_QUEUE_MAX_DELETES_PER_RUN);
      const second = await pruneProtocolEventQueue({ now, triggeredBy: "TEST" });
      expect(second.queueRowsDeleted).toBeGreaterThanOrEqual(5);
      expect(await db.protocolEventQueue.count({ where: { correlationId: `${CORRELATION}-bulk` } })).toBe(0);
    } finally {
      await db.protocolEventQueue.deleteMany({ where: { correlationId: `${CORRELATION}-bulk` } });
    }
  });

  test("writes the policy Setting bookkeeping and one summary audit row per run", async () => {
    const setting = await db.setting.findUnique({ where: { key: PROTOCOL_QUEUE_RETENTION_KEY } });
    expect(setting).not.toBeNull();
    const stored = parseStoredProtocolQueueRetention(setting?.valueJson);
    expect(stored.lastPrunedAt).not.toBeNull();
    expect(stored.lastPruneResult).toMatchObject({ outcome: "pruned" });
    const audits = await db.auditEvent.findMany({
      where: { action: "PROTOCOL_QUEUE_PRUNED", correlationId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorName).toBe("system:protocol-queue-retention-worker");
  });
});

async function seedOne(row: Record<string, unknown>) {
  await seedRows([row]);
  const rows = await testRows();
  return rows[rows.length - 1];
}

describe("queue retention policy (pure)", () => {
  test("defaults are conservative (7d delivered / 30d dead / enabled)", () => {
    expect(DEFAULT_PROTOCOL_QUEUE_RETENTION).toEqual({ deliveredDays: 7, deadDays: 30, enabled: true });
    const fallback = parseStoredProtocolQueueRetention(null);
    expect(fallback).toMatchObject({ deliveredDays: 7, deadDays: 30, enabled: true, lastPrunedAt: null });
  });

  test("parseStoredProtocolQueueRetention never throws on corrupt JSON", () => {
    expect(parseStoredProtocolQueueRetention("not json")).toMatchObject({ deliveredDays: 7 });
    expect(parseStoredProtocolQueueRetention("{\"deliveredDays\":0}")).toMatchObject({ deliveredDays: 7 });
    expect(
      parseStoredProtocolQueueRetention(
        JSON.stringify({ deliveredDays: 30, deadDays: 90, enabled: false })
      )
    ).toMatchObject({ deliveredDays: 30, deadDays: 90, enabled: false });
  });

  test("isProtocolQueueRowExpired applies the per-status windows", () => {
    const nowMs = now.getTime();
    expect(
      isProtocolQueueRowExpired(
        "DELIVERED",
        new Date(nowMs - 8 * DAY_MS),
        DEFAULT_PROTOCOL_QUEUE_RETENTION,
        now
      )
    ).toBe(true);
    expect(
      isProtocolQueueRowExpired(
        "DELIVERED",
        new Date(nowMs - 6 * DAY_MS),
        DEFAULT_PROTOCOL_QUEUE_RETENTION,
        now
      )
    ).toBe(false);
    expect(
      isProtocolQueueRowExpired(
        "DEAD",
        new Date(nowMs - 31 * DAY_MS),
        DEFAULT_PROTOCOL_QUEUE_RETENTION,
        now
      )
    ).toBe(true);
    expect(
      isProtocolQueueRowExpired(
        "DEAD",
        new Date(nowMs - 29 * DAY_MS),
        DEFAULT_PROTOCOL_QUEUE_RETENTION,
        now
      )
    ).toBe(false);
    // Non-terminal rows are never expiry candidates.
    expect(
      isProtocolQueueRowExpired(
        "QUEUED",
        new Date(nowMs - 400 * DAY_MS),
        DEFAULT_PROTOCOL_QUEUE_RETENTION,
        now
      )
    ).toBe(false);
  });

  test("sweep bounds are chunked", () => {
    expect(PROTOCOL_QUEUE_CHUNK_SIZE).toBe(1_000);
    expect(PROTOCOL_QUEUE_MAX_DELETES_PER_RUN).toBe(10_000);
  });
});

/* ── wiring contracts ─────────────────────────────────────────────────── */

test("deleteMany exists ONLY in the retention sweep", () => {
  // Pure-node source walk — no external binary dependency. The previous
  // `execSync("rg -l …")` version silently returned zero hits on CI runner
  // images without ripgrep (the `|| true` swallowed the spawn failure) and
  // produced a false red.
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && readFileSync(p, "utf8").includes("protocolEventQueue.deleteMany")) {
        hits.push(p);
      }
    }
  };
  walk("src");
  expect(hits).toEqual(["src/lib/protocol/queue-retention.ts"]);
});

test("prune route is dual-gated, throttled, and chunked", () => {
  const route = readFileSync("src/app/api/v1/protocol/queue/retention/prune/route.ts", "utf8");
  expect(route).toContain('requireServiceOrPermission(request, "admin.system", "jobs")');
  expect(route).toContain('"PROTOCOL_QUEUE_PRUNE_THROTTLED"');
  expect(route).toContain("429");
  expect(route).toContain("pruneProtocolEventQueue");
});

test("prune route rejects anonymous callers", async () => {
  const { POST } = await import("../../src/app/api/v1/protocol/queue/retention/prune/route");
  const response = await POST(
    new Request("http://localhost/api/v1/protocol/queue/retention/prune", { method: "POST" })
  );
  expect(response.status).toBe(401);
});

test("second immediate route call is throttled", async () => {
  const { POST } = await import("../../src/app/api/v1/protocol/queue/retention/prune/route");
  const auth = {
    Authorization: `Bearer ${mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:queue-retention-test",
      scopes: ["jobs"],
    })}`,
  };
  // The sweep tests above persisted a fresh lastPrunedAt — backdate it past
  // the 60 s window so the FIRST route call goes through (the persisted
  // lastPrunedAt is the restart-safe throttle fallback).
  const backdated = {
    ...DEFAULT_PROTOCOL_QUEUE_RETENTION,
    lastPrunedAt: new Date(Date.now() - 61_000).toISOString(),
    lastPruneResult: { outcome: "pruned", queueRowsDeleted: 0 },
  };
  await db.setting.upsert({
    where: { key: PROTOCOL_QUEUE_RETENTION_KEY },
    update: { valueJson: JSON.stringify(backdated) },
    create: { key: PROTOCOL_QUEUE_RETENTION_KEY, valueJson: JSON.stringify(backdated) },
  });
  const request = () =>
    new Request("http://localhost/api/v1/protocol/queue/retention/prune", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ triggeredBy: "TEST" }),
    });
  const first = await POST(request());
  expect(first.status).toBe(200);
  const second = await POST(request());
  expect(second.status).toBe(429);
  const body = await second.json();
  expect(body.error.code).toBe("PROTOCOL_QUEUE_PRUNE_THROTTLED");
});

test("route is registered on the machine surface and the session-exempt list", () => {
  const proxy = readFileSync("src/proxy.ts", "utf8");
  expect(proxy.split('"/api/v1/protocol/queue/retention/prune"').length - 1).toBe(2);
});

test("tick enqueues at most one PROTOCOL_QUEUE_RETENTION per dedupe window", () => {
  const tick = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
  expect(tick).toContain("PROTOCOL_QUEUE_RETENTION_DEDUPE_HOURS = 24");
  expect(tick).toContain('type: "PROTOCOL_QUEUE_RETENTION"');
  expect(tick).toContain("enqueueProtocolQueueRetention(now)");
  expect(tick).toContain("protocolQueueRetentionEnqueued");
});

test("worker runner claims and dispatches PROTOCOL_QUEUE_RETENTION", () => {
  const runner = readFileSync("mini-services/worker/runner.ts", "utf8");
  expect(runner).toContain('job.type === "PROTOCOL_QUEUE_RETENTION"');
  expect(runner).toContain('"/api/v1/protocol/queue/retention/prune"');
  expect(runner).toContain("PROTOCOL_QUEUE_PRUNE_THROTTLED");
  const claimBody = runner.slice(runner.indexOf("types: ["), runner.indexOf("\"] as"));
  expect(claimBody).toContain('"PROTOCOL_QUEUE_RETENTION"');
});

test("claim request accepts the full job-type list", () => {
  const claim = readFileSync("src/app/api/v1/worker/claim/route.ts", "utf8");
  expect(claim).toContain(".max(14)");
});

test("worker completion contract accepts the queue-retention summary", () => {
  const complete = readFileSync("src/app/api/v1/worker/complete/route.ts", "utf8");
  expect(complete).toContain('job.type === "PROTOCOL_QUEUE_RETENTION"');
  expect(complete).toContain('z.enum(["pruned", "disabled"])');
  expect(complete).toContain("queueRowsDeleted: z.number().int().nonnegative()");
});
