import { z } from "zod";
import { db } from "@/lib/db";

export const FLOW_RETENTION_KEY = "flows.retention";
export const DEFAULT_FLOW_RETENTION = { days: 14, enabled: true } as const;
export const FLOW_RETENTION_CHUNK_SIZE = 1_000;
export const FLOW_RETENTION_MAX_DELETES_PER_RUN = 10_000;

export const flowRetentionSchema = z.object({
  days: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
}).strict();

const storedFlowRetentionSchema = flowRetentionSchema.extend({
  lastPrunedAt: z.string().datetime().nullable().optional(),
  lastPruneResult: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export interface FlowRetentionPolicy {
  days: number;
  enabled: boolean;
}

export interface FlowRetentionView extends FlowRetentionPolicy {
  lastPrunedAt: string | null;
  lastPruneResult: Record<string, unknown> | null;
}

export function parseStoredFlowRetention(valueJson: string | null | undefined): FlowRetentionView {
  const fallback: FlowRetentionView = {
    ...DEFAULT_FLOW_RETENTION,
    lastPrunedAt: null,
    lastPruneResult: null,
  };
  if (!valueJson) return fallback;
  try {
    const parsed = storedFlowRetentionSchema.safeParse(JSON.parse(valueJson));
    if (!parsed.success) return fallback;
    return {
      days: parsed.data.days,
      enabled: parsed.data.enabled,
      lastPrunedAt: parsed.data.lastPrunedAt ?? null,
      lastPruneResult: parsed.data.lastPruneResult ?? null,
    };
  } catch {
    return fallback;
  }
}

export function flowRetentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

export function isFlowRecordExpired(receivedAt: Date, cutoff: Date): boolean {
  return receivedAt.getTime() < cutoff.getTime();
}

export function shouldPruneFlowRecords(policy: FlowRetentionPolicy): boolean {
  return policy.enabled;
}

export function readFlowRetentionSetting() {
  return db.setting.findUnique({ where: { key: FLOW_RETENTION_KEY } });
}
