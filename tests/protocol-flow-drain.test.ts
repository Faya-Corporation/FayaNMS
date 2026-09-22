import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flowRecordsForQueue } from "../src/lib/protocol/flow-records";
import type { NetFlowV5Batch } from "../src/lib/protocol/netflow-v5";

function threeRecordBatch(): NetFlowV5Batch {
  const record = {
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
  };
  return {
    header: {
      count: 3,
      systemUptimeMs: 4_000_000_001,
      unixSeconds: 1_758_412_800,
      unixNanoseconds: 123_456_789,
      flowSequence: 4_000_000_002,
      engineType: 1,
      engineId: 2,
      samplingMode: 2,
      samplingInterval: 100,
    },
    records: [record, record, record],
  };
}

test("maps every batch record to its idempotent queue key and exporter context", () => {
  const rows = flowRecordsForQueue(threeRecordBatch(), {
    queueId: "queue-1",
    deviceId: null,
    collectorId: "collector-a",
    exporterAddress: "192.0.2.200",
    exporterPort: 2055,
    receivedAt: new Date("2026-09-23T00:00:00.000Z"),
  });

  expect(rows).toHaveLength(3);
  expect(rows.map(({ queueId, recordIndex }) => [queueId, recordIndex])).toEqual([
    ["queue-1", 0], ["queue-1", 1], ["queue-1", 2],
  ]);
  expect(rows[0]).toMatchObject({
    deviceId: null,
    exporterAddress: "192.0.2.200",
    exporterPort: 2055,
    sourceIp: "192.0.2.1",
    flowSequence: 4_000_000_002n,
    packets: 4_000_000_001n,
  });
  expect(rows[0].receivedAt.toISOString()).toBe("2026-09-23T00:00:00.000Z");
  expect(rows[0].exportedAt.toISOString()).toBe("2025-09-21T00:00:00.123Z");
});

test("drain persists all flow rows before delivery state in one transaction", () => {
  const route = readFileSync("src/app/api/v1/worker/protocol-events/drain/route.ts", "utf8");
  const delivery = route.slice(route.indexOf("async function deliverEvent"));
  expect(delivery.indexOf("tx.flowRecord.createMany")).toBeLessThan(
    delivery.indexOf("tx.protocolEventQueue.updateMany"),
  );
  expect(delivery).toContain('throw new Error("protocol queue lease was lost")');
  expect(delivery).toContain("skipDuplicates: true");
  expect(route).toContain("flowRecordsPersisted");
  expect(route).toContain("netFlowV5BatchSchema.safeParse");
});

test("queue audit records only flow metadata and dead-lettering retains the batch", () => {
  const ingest = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  expect(ingest).toContain("flowBatch: input.flowBatch ? {");
  expect(ingest).toContain("flowSequence: input.flowBatch.header.flowSequence");
  expect(ingest).not.toContain("rawDatagram");

  const drain = readFileSync("src/app/api/v1/worker/protocol-events/drain/route.ts", "utf8");
  const failure = drain.slice(drain.indexOf("async function recordFailure"), drain.indexOf("async function deliverEvent"));
  expect(failure).not.toContain("flowBatchJson:");
  const scheduler = readFileSync("mini-services/worker/scheduler.ts", "utf8");
  expect(scheduler).toContain("flowRecordsPersisted");
});
