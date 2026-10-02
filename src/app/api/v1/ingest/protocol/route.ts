import { db } from "@/lib/db";
import { newCorrelationId, fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  associateProtocolDevice,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  normalizeProtocolEvent,
  PROTOCOLS,
  resolveProtocolIdempotency,
  validateProtocolIngestPolicy,
} from "@/lib/protocol/ingest";
import { PROTOCOL_QUEUE_DEFAULT_MAX_ATTEMPTS } from "@/lib/protocol/queue";
import {
  netFlowV5BatchSchema,
  protocolFlowBatchContractIssue,
  serializedFlowBatchWithinLimit,
} from "@/lib/protocol/netflow-v5-schema";
import { z } from "zod";

export const dynamic = "force-dynamic";

const attributeSchema = z.union([z.string().max(256), z.number(), z.boolean(), z.null()]);
const ingestSchema = z.object({
  collectorId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  protocol: z.enum(PROTOCOLS),
  sourceIp: z.string().trim().min(1).max(64),
  sourcePort: z.coerce.number().int().min(1).max(65535),
  receivedAt: z.coerce.date().optional(),
  eventType: z.string().trim().min(1).max(120),
  severity: z.string().trim().min(1).max(32),
  message: z.string().max(8192),
  protocolVersion: z.string().trim().max(32).optional(),
  securityLevel: z.enum(["authPriv", "community", "unknown"]).optional(),
  deviceHint: z.object({
    hostname: z.string().trim().max(255).optional(),
    credentialProfileId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  }).strict().optional(),
  attributes: z.record(z.string().max(64), attributeSchema).optional(),
  // F-048 (batch-18): optional client idempotency key. When present — or
  // derivable for NetFlow v5 from the datagram header — a retry that reaches
  // a still-live queue row is answered from the ORIGINAL attempt (200
  // duplicate receipt) instead of inserting a duplicate row.
  idempotencyKey: z.string().trim().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).regex(IDEMPOTENCY_KEY_PATTERN).optional(),
  flowBatch: netFlowV5BatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const message = protocolFlowBatchContractIssue(value);
  if (message) ctx.addIssue({ code: "custom", path: ["flowBatch"], message });
});

/**
 * POST /api/v1/ingest/protocol — authenticated collector event relay.
 * UDP packets are never trusted as device identity. F-036 (batch-11): the
 * event's SOURCE IP is the trust anchor — an exact mgmtIp match attributes
 * the device outright; a hostname hint is honored only when it AGREES with
 * that resolution, or (no source match) for the legitimate relay/NAT case
 * with the event flagged `attributionUnverified` (queue column + response).
 * A hostname that CONTRADICTS the source-resolved device never wins the
 * attribution — the event keeps the source-verified device and the
 * contradiction is flagged. SNMP traps are stricter: only verified authPriv
 * traffic with an exact SNMPV3 CredentialProfile bound to the associated
 * device is accepted. Raw packets and secret material are intentionally not
 * accepted or stored.
 *
 * Accepted events are written to ProtocolEventQueue in the same transaction as
 * the queue audit entry. The worker drains that durable handoff separately,
 * so a temporary audit/worker failure does not lose the normalized event.
 *
 * F-048 (batch-18) — ingest idempotency: the payload may carry an optional
 * bounded `idempotencyKey` (1–128 chars, [A-Za-z0-9._:-]). When a key is
 * present — or, without one, derivable for NetFlow v5 as
 * (collectorId, sourceIp, sourcePort, flowSequence, unixSeconds,
 * unixNanoseconds) — the queue row's correlationId is derived from that key
 * and the ingest transaction takes a transaction-scoped Postgres advisory
 * lock on it, then preflights a LIVE prior row (QUEUED/IN_FLIGHT/DELIVERED)
 * for (collectorId, correlationId) — race-safe: a concurrent double-submit
 * blocks on the lock until the first transaction commits, then observes the
 * committed row. A retry that hits a live prior row is answered 200 with
 * `duplicate: true` plus the ORIGINAL attempt's queueId/status/correlationId
 * and writes NO new queue row, audit row, or FlowRecord; the first delivery
 * stays at-least-once (202, `queued: true`). The dedupe window is the
 * lifetime of the original queue row — DELIVERED rows are pruned by
 * `protocolQueue.retention` (default 7 delivered days), and a DEAD prior
 * attempt releases the key so a retry is re-queued. Outside the window, or
 * with no key and no derivable NetFlow header, every accepted POST queues a
 * new row exactly as before (documented at-least-once semantics).
 */
export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "telemetry");
  if (!auth.ok) return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = ingestSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  if (parsed.data.flowBatch && !serializedFlowBatchWithinLimit(parsed.data.flowBatch)) {
    return fail("INVALID_BODY", "Flow batch exceeds the 16 KiB limit", 400);
  }

  const input = { ...parsed.data, receivedAt: parsed.data.receivedAt ?? new Date() };
  const [hostnameMatch, ipMatch] = await Promise.all([
    input.deviceHint?.hostname
      ? db.device.findUnique({ where: { hostname: input.deviceHint.hostname }, select: { id: true, hostname: true, mgmtIp: true } })
      : Promise.resolve(null),
    db.device.findFirst({ where: { mgmtIp: input.sourceIp }, select: { id: true, hostname: true, mgmtIp: true } }),
  ]);
  const association = associateProtocolDevice(input, [
    ...(hostnameMatch ? [hostnameMatch] : []),
    ...(ipMatch && ipMatch.id !== hostnameMatch?.id ? [ipMatch] : []),
  ]);
  let credentialProfile: { id: string; type: string } | null = null;
  if (
    input.protocol === "snmp-trap" &&
    association.device &&
    input.deviceHint?.credentialProfileId
  ) {
    credentialProfile = await db.credentialProfile.findFirst({
      where: {
        id: input.deviceHint.credentialProfileId,
        type: "SNMPV3",
        devices: { some: { id: association.device.id } },
      },
      select: { id: true, type: true },
    });
  }
  const policy = validateProtocolIngestPolicy(
    input,
    association,
    credentialProfile
      ? { ...credentialProfile, deviceId: association.device?.id ?? "" }
      : null,
  );
  if (!policy.ok) return fail(policy.code, policy.message, 400);

  const event = normalizeProtocolEvent(input);
  const idempotency = resolveProtocolIdempotency({
    collectorId: event.collectorId,
    idempotencyKey: input.idempotencyKey,
    protocol: event.protocol,
    protocolVersion: event.protocolVersion ?? undefined,
    sourceIp: event.sourceIp,
    sourcePort: event.sourcePort,
    flowBatch: input.flowBatch,
  });
  const correlationId = idempotency?.correlationId ?? newCorrelationId("NET");
  const queued = await db.$transaction(async (tx) => {
    if (idempotency) {
      // F-048 (batch-18): the idempotency preflight runs INSIDE the ingest
      // transaction under a transaction-scoped advisory lock (same Postgres
      // convention as the F-052 tick enqueues). The lock serializes two
      // concurrent submits of the same key: the loser blocks until the
      // winner's transaction commits, so its preflight below observes the
      // committed row and returns the duplicate receipt instead of inserting
      // a second queue row. The DB match is (collectorId, correlationId,
      // status) — the hash only ever narrows contention, never widens it.
      // A DEAD prior attempt matches nothing (key released → the retry is
      // re-queued per at-least-once semantics).
      // pg_advisory_xact_lock returns void, which $queryRaw cannot
      // deserialize — wrap it so the statement yields a plain integer row.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${correlationId}, 0))) AS ingest_dedupe_lock`;
      const duplicate = await tx.protocolEventQueue.findFirst({
        where: {
          collectorId: event.collectorId,
          correlationId,
          status: { in: ["QUEUED", "IN_FLIGHT", "DELIVERED"] },
        },
        select: { id: true, status: true, correlationId: true },
      });
      if (duplicate) return { kind: "duplicate" as const, duplicate };
    }
    const queueEntry = await tx.protocolEventQueue.create({
      data: {
        collectorId: event.collectorId,
        protocol: event.protocol,
        sourceIp: event.sourceIp,
        sourcePort: event.sourcePort,
        receivedAt: new Date(event.receivedAt),
        eventType: event.eventType,
        severity: event.severity,
        message: event.message,
        protocolVersion: event.protocolVersion,
        securityLevel: event.securityLevel,
        flowBatchJson: input.flowBatch ? JSON.stringify(input.flowBatch) : null,
        deviceId: association.device?.id ?? null,
        attributionUnverified: association.attributionUnverified ?? false,
        attributesJson: JSON.stringify(event.attributes),
        correlationId,
        status: "QUEUED",
        attempts: 0,
        maxAttempts: PROTOCOL_QUEUE_DEFAULT_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorName: "collector:" + event.collectorId,
        action: "PROTOCOL_EVENT_QUEUED",
        resourceType: "ProtocolEventQueue",
        resourceId: queueEntry.id,
        resourceLabel: association.device?.hostname ?? event.sourceIp,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          protocol: event.protocol,
          sourceIp: event.sourceIp,
          sourcePort: event.sourcePort,
          receivedAt: event.receivedAt,
          eventType: event.eventType,
          severity: event.severity,
          message: event.message,
          protocolVersion: event.protocolVersion,
          securityLevel: event.securityLevel,
          attributes: event.attributes,
          flowBatch: input.flowBatch ? {
            recordCount: input.flowBatch.header.count,
            flowSequence: input.flowBatch.header.flowSequence,
            unixSeconds: input.flowBatch.header.unixSeconds,
          } : undefined,
          association: {
            method: association.method,
            deviceId: association.device?.id ?? null,
            attributionUnverified: association.attributionUnverified ?? false,
          },
          idempotency: idempotency ? { mode: idempotency.mode } : null,
          status: "QUEUED",
        }),
      },
    });
    return { kind: "queued" as const, queueEntry };
  });

  if (queued.kind === "duplicate") {
    // F-048: idempotent duplicate receipt — 2xx so a naive retry loop stops
    // retrying, with the original attempt's identifiers for reconciliation.
    // No queue row, audit row, or FlowRecord is written for the retry.
    return ok({
      accepted: true,
      queued: false,
      duplicate: true,
      queueId: queued.duplicate.id,
      status: queued.duplicate.status,
      correlationId: queued.duplicate.correlationId,
      protocol: event.protocol,
      flowRecordsAccepted: input.flowBatch?.records.length ?? 0,
      associatedDevice: association.device
        ? {
            id: association.device.id,
            hostname: association.device.hostname,
            method: association.method,
            unverified: association.attributionUnverified ?? false,
          }
        : null,
    }, undefined, 200);
  }

  return ok({
    accepted: true,
    queued: true,
    duplicate: false,
    queueId: queued.queueEntry.id,
    status: queued.queueEntry.status,
    correlationId,
    protocol: event.protocol,
    flowRecordsAccepted: input.flowBatch?.records.length ?? 0,
    associatedDevice: association.device
      ? {
          id: association.device.id,
          hostname: association.device.hostname,
          method: association.method,
          unverified: association.attributionUnverified ?? false,
        }
      : null,
  }, undefined, 202);
}
