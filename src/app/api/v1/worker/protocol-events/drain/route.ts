import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  protocolQueueFailure,
  sanitizeProtocolQueueError,
} from "@/lib/protocol/queue";
import { flowRecordsForQueue } from "@/lib/protocol/flow-records";
import { netFlowV5BatchSchema } from "@/lib/protocol/netflow-v5-schema";
import { z } from "zod";

export const dynamic = "force-dynamic";

const drainSchema = z.object({
  limit: z.number().int().min(1).max(50).default(25),
}).strict();

const LOCK_TIMEOUT_MS = 60_000;

type ClaimedProtocolEvent = {
  id: string;
  collectorId: string;
  protocol: string;
  sourceIp: string;
  sourcePort: number;
  receivedAt: Date;
  createdAt: Date;
  eventType: string;
  severity: string;
  message: string;
  protocolVersion: string | null;
  securityLevel: string | null;
  flowBatchJson: string | null;
  deviceId: string | null;
  attributesJson: string;
  correlationId: string;
  attempts: number;
  maxAttempts: number;
};

function eventAttributes(attributesJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(attributesJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Queue rows are written by the normalized ingest contract. A corrupt
    // attribute field is still deliverable without reintroducing raw payloads.
  }
  return {};
}

function eventAuditJson(
  row: {
    id: string;
    collectorId: string;
    protocol: string;
    sourceIp: string;
    sourcePort: number;
    receivedAt: Date;
    eventType: string;
    severity: string;
    message: string;
    protocolVersion: string | null;
    securityLevel: string | null;
    deviceId: string | null;
    attributesJson: string;
    correlationId: string;
  },
  status: string,
  attempt: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    queueId: row.id,
    collectorId: row.collectorId,
    protocol: row.protocol,
    sourceIp: row.sourceIp,
    sourcePort: row.sourcePort,
    receivedAt: row.receivedAt.toISOString(),
    eventType: row.eventType,
    severity: row.severity,
    message: row.message,
    protocolVersion: row.protocolVersion,
    securityLevel: row.securityLevel,
    deviceId: row.deviceId,
    attributes: eventAttributes(row.attributesJson),
    correlationId: row.correlationId,
    status,
    attempt,
    ...extra,
  });
}

/**
 * Claim due protocol events with a short lease. The conditional update keeps
 * two worker instances from delivering the same row; an abandoned lease is
 * eligible again after LOCK_TIMEOUT_MS.
 */
async function claimDueEvents(limit: number, now: Date) {
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  return db.$transaction(async (tx) => {
    const candidates = await tx.protocolEventQueue.findMany({
      where: {
        OR: [
          { status: "QUEUED", nextAttemptAt: { lte: now } },
          { status: "IN_FLIGHT", lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
    const claimed: ClaimedProtocolEvent[] = [];
    for (const row of candidates) {
      const guard =
        row.status === "QUEUED"
          ? { id: row.id, status: "QUEUED", nextAttemptAt: { lte: now } }
          : { id: row.id, status: "IN_FLIGHT", lockedAt: { lt: staleBefore } };
      const updated = await tx.protocolEventQueue.updateMany({
        where: guard,
        data: {
          status: "IN_FLIGHT",
          lockedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        claimed.push({ ...row, attempts: row.attempts + 1 });
      }
    }
    return claimed;
  });
}

function queuedFlowBatch(row: ClaimedProtocolEvent) {
  if (row.flowBatchJson === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.flowBatchJson);
  } catch {
    throw new Error("queued NetFlow batch is not valid JSON");
  }
  const parsed = netFlowV5BatchSchema.safeParse(value);
  if (!parsed.success || row.protocol !== "netflow" || row.protocolVersion !== "NETFLOW_V5") {
    throw new Error("queued NetFlow batch failed validation");
  }
  return parsed.data;
}

async function deliverEvent(row: ClaimedProtocolEvent): Promise<number> {
  const batch = queuedFlowBatch(row);
  const records = batch
    ? flowRecordsForQueue(batch, {
        queueId: row.id,
        deviceId: row.deviceId,
        collectorId: row.collectorId,
        exporterAddress: row.sourceIp,
        exporterPort: row.sourcePort,
        receivedAt: row.createdAt,
      })
    : [];
  const deliveredAt = new Date();
  return db.$transaction(async (tx) => {
    let persisted = 0;
    if (records.length > 0) {
      const inserted = await tx.flowRecord.createMany({ data: records, skipDuplicates: true });
      persisted = inserted.count;
    }
    const updated = await tx.protocolEventQueue.updateMany({
      where: { id: row.id, status: "IN_FLIGHT" },
      data: {
        status: "DELIVERED",
        deliveredAt,
        lockedAt: null,
        lastError: null,
      },
    });
    if (updated.count !== 1) throw new Error("protocol queue lease was lost");
    await tx.auditEvent.create({
      data: {
        actorName: "worker:protocol-event-drain",
        action: "PROTOCOL_EVENT_RECEIVED",
        resourceType: "ProtocolEventQueue",
        resourceId: row.id,
        resourceLabel: row.deviceId ?? row.sourceIp,
        result: "SUCCESS",
        correlationId: row.correlationId,
        afterJson: eventAuditJson(row, "DELIVERED", row.attempts, {
          flowRecordsPersisted: persisted,
        }),
      },
    });
    return persisted;
  });
}

async function recordFailure(
  row: ClaimedProtocolEvent,
  error: unknown,
): Promise<"QUEUED" | "DEAD" | "SKIPPED"> {
  const decision = protocolQueueFailure(row.attempts, row.maxAttempts, new Date(), error);
  try {
    const updated = await db.$transaction(async (tx) => {
      const changed = await tx.protocolEventQueue.updateMany({
        where: { id: row.id, status: "IN_FLIGHT" },
        data: {
          status: decision.status,
          nextAttemptAt: decision.nextAttemptAt,
          lockedAt: null,
          lastError: decision.lastError,
        },
      });
      if (changed.count !== 1) return false;
      if (decision.status === "DEAD") {
        await tx.auditEvent.create({
          data: {
            actorName: "worker:protocol-event-drain",
            action: "PROTOCOL_EVENT_DEAD_LETTERED",
            resourceType: "ProtocolEventQueue",
            resourceId: row.id,
            resourceLabel: row.deviceId ?? row.sourceIp,
            result: "FAILURE",
            correlationId: row.correlationId,
            afterJson: eventAuditJson(row, "DEAD", row.attempts, {
              error: decision.lastError,
            }),
          },
        });
      }
      return true;
    });
    return updated ? decision.status : "SKIPPED";
  } catch (failure) {
    // Keep the row IN_FLIGHT for lease recovery if the failure bookkeeping
    // itself is unavailable. The next drain will reclaim it after the lease.
    sanitizeProtocolQueueError(failure);
    return "SKIPPED";
  }
}

/**
 * POST /api/v1/worker/protocol-events/drain — durable protocol handoff.
 *
 * This route is jobs-scoped and called by the worker scheduler. Delivery in
 * this slice means the normalized event is committed to the audit/event sink;
 * alert evaluation and live monitoring fan-out remain separate capabilities.
 */
export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "jobs");
  if (!auth.ok) return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty request bodies are accepted as the default drain request.
  }
  const parsed = drainSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  const claimed = await claimDueEvents(parsed.data.limit, new Date());
  let delivered = 0;
  let flowRecordsPersisted = 0;
  let requeued = 0;
  let deadLettered = 0;
  for (const row of claimed) {
    try {
      flowRecordsPersisted += await deliverEvent(row);
      delivered += 1;
      continue;
    } catch (error) {
      const result = await recordFailure(row, error);
      if (result === "QUEUED") requeued += 1;
      if (result === "DEAD") deadLettered += 1;
      continue;
    }
  }

  const queueDepth = await db.protocolEventQueue.count({
    where: { status: { in: ["QUEUED", "IN_FLIGHT"] } },
  });
  return ok({
    claimed: claimed.length,
    delivered,
    flowRecordsPersisted,
    requeued,
    deadLettered,
    queueDepth,
    processedAt: new Date().toISOString(),
  });
}
