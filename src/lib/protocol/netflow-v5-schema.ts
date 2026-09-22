import { isIPv4 } from "node:net";
import { z } from "zod";
import { PROTOCOLS } from "./ingest";

const MAX_SERIALIZED_FLOW_BATCH_BYTES = 16 * 1024;
const uint8 = z.number().int().min(0).max(255);
const uint16 = z.number().int().min(0).max(65_535);
const uint32 = z.number().int().min(0).max(4_294_967_295);
const uint32Text = z.string()
  .regex(/^\d{1,10}$/)
  .refine((value) => BigInt(value) <= 4_294_967_295n, "Expected an unsigned 32-bit integer");
const ipv4 = z.string().refine(isIPv4, "Expected IPv4 address");

const headerSchema = z.object({
  count: z.number().int().min(1).max(30),
  systemUptimeMs: uint32,
  unixSeconds: uint32,
  unixNanoseconds: z.number().int().min(0).max(999_999_999),
  flowSequence: uint32,
  engineType: uint8,
  engineId: uint8,
  samplingMode: z.number().int().min(0).max(3),
  samplingInterval: z.number().int().min(0).max(16_383),
}).strict();

const recordSchema = z.object({
  sourceIp: ipv4,
  destinationIp: ipv4,
  nextHopIp: ipv4,
  inputIfIndex: uint16,
  outputIfIndex: uint16,
  packets: uint32Text,
  octets: uint32Text,
  firstUptimeMs: uint32Text,
  lastUptimeMs: uint32Text,
  sourcePort: uint16,
  destinationPort: uint16,
  tcpFlags: uint8,
  protocol: uint8,
  tos: uint8,
  sourceAs: uint16,
  destinationAs: uint16,
  sourceMask: uint8,
  destinationMask: uint8,
}).strict();

export const netFlowV5BatchSchema = z.object({
  header: headerSchema,
  records: z.array(recordSchema).min(1).max(30),
}).strict().superRefine((batch, ctx) => {
  if (batch.header.count !== batch.records.length) {
    ctx.addIssue({ code: "custom", path: ["records"], message: "count must match records length" });
  }
});

export function protocolFlowBatchContractIssue(value: {
  protocol: string;
  protocolVersion?: string;
  flowBatch?: unknown;
}): string | null {
  if (value.flowBatch && (value.protocol !== "netflow" || value.protocolVersion !== "NETFLOW_V5")) {
    return "flowBatch requires NetFlow v5";
  }
  if (value.protocol === "netflow" && value.protocolVersion === "NETFLOW_V5" && !value.flowBatch) {
    return "NetFlow v5 requires a decoded batch";
  }
  return null;
}

export const protocolFlowBatchSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  protocolVersion: z.string().trim().max(32).optional(),
  flowBatch: netFlowV5BatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const message = protocolFlowBatchContractIssue(value);
  if (message) {
    ctx.addIssue({ code: "custom", path: ["flowBatch"], message });
  }
});

export function serializedFlowBatchWithinLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      && Buffer.byteLength(serialized, "utf8") <= MAX_SERIALIZED_FLOW_BATCH_BYTES;
  } catch {
    return false;
  }
}
