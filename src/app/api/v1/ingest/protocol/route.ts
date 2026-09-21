import { db } from "@/lib/db";
import { newCorrelationId, fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { associateProtocolDevice, normalizeProtocolEvent, PROTOCOLS } from "@/lib/protocol/ingest";
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
  deviceHint: z.object({ hostname: z.string().trim().max(255).optional() }).optional(),
  attributes: z.record(z.string().max(64), attributeSchema).optional(),
}).strict();

/**
 * POST /api/v1/ingest/protocol — authenticated collector event relay.
 * UDP packets are never trusted as device identity. Association is an
 * ordered hint: exact hostname first, exact management IP second; unmatched
 * events are retained as unassociated audit history. Raw packets and secret
 * material are intentionally not accepted or stored.
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
  const event = normalizeProtocolEvent(input);
  const correlationId = newCorrelationId("NET");

  await db.auditEvent.create({
    data: {
      actorName: "collector:" + event.collectorId,
      action: "PROTOCOL_EVENT_RECEIVED",
      resourceType: "ProtocolEvent",
      resourceId: association.device?.id ?? null,
      resourceLabel: association.device?.hostname ?? event.sourceIp,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({ ...event, association: { method: association.method, deviceId: association.device?.id ?? null } }),
    },
  });

  return ok({
    accepted: true,
    correlationId,
    protocol: event.protocol,
    associatedDevice: association.device
      ? { id: association.device.id, hostname: association.device.hostname, method: association.method }
      : null,
  }, undefined, 202);
}
