import type { NetFlowV5Batch } from "./netflow-v5";

export interface FlowQueueContext {
  queueId: string;
  deviceId: string | null;
  collectorId: string;
  exporterAddress: string;
  exporterPort: number;
  receivedAt: Date;
}

export function flowRecordsForQueue(batch: NetFlowV5Batch, context: FlowQueueContext) {
  const header = batch.header;
  const exportedAt = new Date(
    header.unixSeconds * 1_000 + Math.trunc(header.unixNanoseconds / 1_000_000),
  );

  return batch.records.map((record, recordIndex) => ({
    ...context,
    recordIndex,
    exportedAt,
    recordCount: header.count,
    systemUptimeMs: BigInt(header.systemUptimeMs),
    unixSeconds: BigInt(header.unixSeconds),
    unixNanoseconds: BigInt(header.unixNanoseconds),
    flowSequence: BigInt(header.flowSequence),
    engineType: header.engineType,
    engineId: header.engineId,
    samplingMode: header.samplingMode,
    samplingInterval: header.samplingInterval,
    ...record,
    packets: BigInt(record.packets),
    octets: BigInt(record.octets),
    firstUptimeMs: BigInt(record.firstUptimeMs),
    lastUptimeMs: BigInt(record.lastUptimeMs),
  }));
}
