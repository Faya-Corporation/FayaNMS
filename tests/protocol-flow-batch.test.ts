import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  netFlowV5BatchSchema,
  protocolFlowBatchSchema,
  serializedFlowBatchWithinLimit,
} from "../src/lib/protocol/netflow-v5-schema";

function validBatch() {
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

test("accepts bounded v5 flow batches and enforces the protocol contract", () => {
  const batch = validBatch();
  expect(netFlowV5BatchSchema.safeParse(batch).success).toBe(true);
  expect(protocolFlowBatchSchema.safeParse({
    protocol: "netflow", protocolVersion: "NETFLOW_V5", flowBatch: batch,
  }).success).toBe(true);
  expect(serializedFlowBatchWithinLimit(batch)).toBe(true);
});

test("rejects a count mismatch, empty batches, and more than 30 records", () => {
  const mismatch = validBatch();
  mismatch.header.count = 2;
  expect(netFlowV5BatchSchema.safeParse(mismatch).success).toBe(false);
  expect(netFlowV5BatchSchema.safeParse({ ...validBatch(), records: [] }).success).toBe(false);
  expect(netFlowV5BatchSchema.safeParse({
    ...validBatch(),
    header: { ...validBatch().header, count: 31 },
    records: Array.from({ length: 31 }, () => validBatch().records[0]),
  }).success).toBe(false);
});

test("rejects invalid addresses, out-of-range counters, and protocol mismatches", () => {
  const invalidAddress = validBatch();
  invalidAddress.records[0].sourceIp = "192.0.2.999";
  expect(netFlowV5BatchSchema.safeParse(invalidAddress).success).toBe(false);

  const invalidCounter = validBatch();
  invalidCounter.records[0].packets = "4294967296";
  expect(netFlowV5BatchSchema.safeParse(invalidCounter).success).toBe(false);

  const negativeCounter = validBatch();
  negativeCounter.records[0].octets = "-1";
  expect(netFlowV5BatchSchema.safeParse(negativeCounter).success).toBe(false);

  expect(protocolFlowBatchSchema.safeParse({
    protocol: "syslog", protocolVersion: "NETFLOW_V5", flowBatch: validBatch(),
  }).success).toBe(false);
  expect(protocolFlowBatchSchema.safeParse({
    protocol: "netflow", protocolVersion: "NETFLOW_V5",
  }).success).toBe(false);
});

test("rejects a serialized batch over the 16 KiB ingest limit", () => {
  expect(serializedFlowBatchWithinLimit({ payload: "x".repeat(16 * 1024) })).toBe(false);
});

test("ingest validates and bounds batches before database access, then queues the typed JSON", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  expect(route.indexOf("serializedFlowBatchWithinLimit(parsed.data.flowBatch)")).toBeLessThan(
    route.indexOf("db.device.findUnique"),
  );
  expect(route).toContain("flowBatchJson: input.flowBatch ? JSON.stringify(input.flowBatch) : null");
  expect(route).toContain("flowRecordsAccepted: input.flowBatch?.records.length ?? 0");
});
