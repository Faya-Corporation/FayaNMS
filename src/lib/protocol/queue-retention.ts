import { z } from "zod";
import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";

/**
 * ProtocolEventQueue retention (RT-003 / F-003) — the sweep that keeps the
 * ingest hot table bounded.
 *
 * Every accepted protocol event inserts one queue row at ingest; the drain
 * only flips its status (DELIVERED / DEAD). No sweep existed, so terminal
 * rows grew forever and the claim scan (`@@index([status, nextAttemptAt])`)
 * and the drain's queueDepth count degraded monotonically.
 *
 * FK SAFETY (the reason this sweep is not a naive delete): FlowRecord.queueId
 * is `onDelete: Cascade` — deleting a DELIVERED queue row whose flow records
 * are still inside the flow-retention window would cascade-delete LIVE flow
 * analytics. The candidate filter therefore excludes every row that still
 * owns FlowRecords (`flowRecords: { none: {} }`); FLOW_RETENTION reclaims
 * the FlowRecords first and the queue rows follow on a later sweep.
 *
 * Semantics (mirrors the FLOW_RETENTION pattern):
 *   - policy Setting row "protocolQueue.retention" (operator-visible and
 *     editable like "flows.retention"), conservative defaults:
 *     delivered 7 days, dead 30 days, enabled;
 *   - DELIVERED rows are expired by deliveredAt, DEAD rows by updatedAt;
 *   - QUEUED and IN_FLIGHT rows can never be deleted (status-guarded
 *     candidates AND a status-guarded deleteMany — the drain's lease-update
 *     CAS spirit);
 *   - chunked: at most 1,000 rows per findMany/deleteMany statement and at
 *     most 10,000 rows per run — repeated runs converge;
 *   - one PROTOCOL_QUEUE_PRUNED summary audit row per run inside the SAME
 *     bounded transaction, plus lastPrunedAt/lastPruneResult bookkeeping in
 *     the Setting row. Never one audit row per deleted queue row.
 */

export const PROTOCOL_QUEUE_RETENTION_KEY = "protocolQueue.retention";
export const DEFAULT_PROTOCOL_QUEUE_RETENTION = {
  deliveredDays: 7,
  deadDays: 30,
  enabled: true,
} as const;
export const PROTOCOL_QUEUE_CHUNK_SIZE = 1_000;
export const PROTOCOL_QUEUE_MAX_DELETES_PER_RUN = 10_000;

export const protocolQueueRetentionSchema = z.object({
  deliveredDays: z.number().int().min(1).max(3650),
  deadDays: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
}).strict();

const storedProtocolQueueRetentionSchema = protocolQueueRetentionSchema.extend({
  lastPrunedAt: z.string().datetime().nullable().optional(),
  lastPruneResult: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export interface ProtocolQueueRetentionPolicy {
  deliveredDays: number;
  deadDays: number;
  enabled: boolean;
}

export interface ProtocolQueueRetentionView extends ProtocolQueueRetentionPolicy {
  lastPrunedAt: string | null;
  lastPruneResult: Record<string, unknown> | null;
}

export interface ProtocolQueuePruneResult {
  outcome: "pruned" | "disabled";
  queueRowsDeleted: number;
  durationMs: number;
  deliveredDays: number;
  deadDays: number;
  correlationId: string;
  triggeredBy: string;
  prunedAt: string;
}

/** Parse the stored Setting into a fully-defaulted view. Never throws. */
export function parseStoredProtocolQueueRetention(
  valueJson: string | null | undefined
): ProtocolQueueRetentionView {
  const fallback: ProtocolQueueRetentionView = {
    ...DEFAULT_PROTOCOL_QUEUE_RETENTION,
    lastPrunedAt: null,
    lastPruneResult: null,
  };
  if (!valueJson) return fallback;
  try {
    const parsed = storedProtocolQueueRetentionSchema.safeParse(JSON.parse(valueJson));
    if (!parsed.success) return fallback;
    return {
      deliveredDays: parsed.data.deliveredDays,
      deadDays: parsed.data.deadDays,
      enabled: parsed.data.enabled,
      lastPrunedAt: parsed.data.lastPrunedAt ?? null,
      lastPruneResult: parsed.data.lastPruneResult ?? null,
    };
  } catch {
    return fallback;
  }
}

export function readProtocolQueueRetentionSetting() {
  return db.setting.findUnique({ where: { key: PROTOCOL_QUEUE_RETENTION_KEY } });
}

export function shouldPruneProtocolQueue(policy: ProtocolQueueRetentionPolicy): boolean {
  return policy.enabled;
}

/**
 * Pure expiry rule for one TERMINAL queue row (RT-003): DELIVERED ages by
 * its delivery time, DEAD by its last update, and non-terminal rows are
 * never candidates. Exported so the regression suite pins the windows.
 */
export function isProtocolQueueRowExpired(
  status: string,
  terminalAt: Date,
  policy: Pick<ProtocolQueueRetentionPolicy, "deliveredDays" | "deadDays">,
  now: Date
): boolean {
  if (status === "DELIVERED") {
    return terminalAt.getTime() < now.getTime() - policy.deliveredDays * 86_400_000;
  }
  if (status === "DEAD") {
    return terminalAt.getTime() < now.getTime() - policy.deadDays * 86_400_000;
  }
  return false;
}

/**
 * Run ONE bounded, chunked queue-retention sweep. Called by the
 * /api/v1/protocol/queue/retention/prune route (service JWT from the
 * PROTOCOL_QUEUE_RETENTION job, admin session for manual runs).
 */
export async function pruneProtocolEventQueue(
  opts: { now?: Date; triggeredBy?: string } = {}
): Promise<ProtocolQueuePruneResult> {
  const now = opts.now ?? new Date();
  const triggeredBy = opts.triggeredBy ?? "SCHEDULE";
  const policy = parseStoredProtocolQueueRetention(
    (await readProtocolQueueRetentionSetting())?.valueJson
  );
  const deliveredCut = new Date(now.getTime() - policy.deliveredDays * 86_400_000);
  const deadCut = new Date(now.getTime() - policy.deadDays * 86_400_000);
  const correlationId = newCorrelationId("RET");
  const startedAt = Date.now();

  const result = await db.$transaction(
    async (tx) => {
      let queueRowsDeleted = 0;
      if (shouldPruneProtocolQueue(policy)) {
        const batches = PROTOCOL_QUEUE_MAX_DELETES_PER_RUN / PROTOCOL_QUEUE_CHUNK_SIZE;
        for (let batchNumber = 0; batchNumber < batches; batchNumber += 1) {
          const expired = await tx.protocolEventQueue.findMany({
            where: {
              // FK safety — FlowRecord.queueId is onDelete: Cascade. A row
              // that still owns flow analytics is NEVER deleted here; the
              // next sweep reclaims it once flow retention removed them.
              flowRecords: { none: {} },
              status: { in: ["DELIVERED", "DEAD"] },
              OR: [
                { status: "DELIVERED", deliveredAt: { lt: deliveredCut } },
                { status: "DEAD", updatedAt: { lt: deadCut } },
              ],
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: PROTOCOL_QUEUE_CHUNK_SIZE,
            select: { id: true },
          });
          if (expired.length === 0) break;
          // Status-guarded delete (same CAS spirit as the drain's lease
          // updates): only terminal rows can ever leave this table.
          const deleted = await tx.protocolEventQueue.deleteMany({
            where: {
              id: { in: expired.map((row) => row.id) },
              status: { in: ["DELIVERED", "DEAD"] },
            },
          });
          queueRowsDeleted += deleted.count;
        }
      }

      const durationMs = Date.now() - startedAt;
      const prunedAt = now.toISOString();
      const outcome = policy.enabled ? "pruned" : "disabled";
      const pruneResult: ProtocolQueuePruneResult = {
        outcome,
        queueRowsDeleted,
        durationMs,
        deliveredDays: policy.deliveredDays,
        deadDays: policy.deadDays,
        correlationId,
        triggeredBy,
        prunedAt,
      };
      const updatedPolicy = {
        deliveredDays: policy.deliveredDays,
        deadDays: policy.deadDays,
        enabled: policy.enabled,
        lastPrunedAt: prunedAt,
        lastPruneResult: {
          outcome,
          queueRowsDeleted,
          durationMs,
          deliveredCutoff: deliveredCut.toISOString(),
          deadCutoff: deadCut.toISOString(),
          triggeredBy,
          prunedAt,
          correlationId,
        },
      };
      await tx.setting.upsert({
        where: { key: PROTOCOL_QUEUE_RETENTION_KEY },
        update: { valueJson: JSON.stringify(updatedPolicy) },
        create: { key: PROTOCOL_QUEUE_RETENTION_KEY, valueJson: JSON.stringify(updatedPolicy) },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:protocol-queue-retention-worker",
          action: "PROTOCOL_QUEUE_PRUNED",
          resourceType: "ProtocolEventQueue",
          resourceLabel: "Protocol queue retention prune",
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({ ...pruneResult, cutoffs: { delivered: deliveredCut.toISOString(), dead: deadCut.toISOString() } }),
        },
      });
      return pruneResult;
    },
    { maxWait: 5_000, timeout: 30_000 }
  );

  return result;
}
