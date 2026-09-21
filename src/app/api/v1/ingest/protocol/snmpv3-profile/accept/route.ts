import { db } from "@/lib/db";
import { newCorrelationId, fail, ok } from "../../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { evaluateSnmpV3EngineObservation, normalizeEngineIdHex } from "@/lib/protocol/snmpv3-policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

const acceptSchema = z.object({
  sourceIp: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(80),
  credentialProfileId: z.string().trim().min(1).max(120),
  engineIdHex: z.string().trim().regex(/^[0-9a-f]{10,128}$/i),
  boots: z.coerce.number().int().min(0),
  time: z.coerce.number().int().min(0),
}).strict();

export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "telemetry");
  if (!auth.ok) return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);
  let body: unknown;
  try { body = await request.json(); } catch { return fail("INVALID_BODY", "Request body must be valid JSON", 400); }
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", "Invalid SNMPv3 acceptance payload", 400);
  const device = await db.device.findFirst({
    where: { mgmtIp: parsed.data.sourceIp },
    select: {
      id: true,
      snmpEngineIdHex: true,
      snmpEngineBoots: true,
      snmpEngineTime: true,
      credentialProfile: { select: { id: true, type: true, username: true } },
    },
  });
  const profile = device?.credentialProfile;
  if (!device || !profile || profile.id !== parsed.data.credentialProfileId || profile.type !== "SNMPV3" || profile.username !== parsed.data.username) {
    return fail("SNMP_PROFILE_NOT_FOUND", "No active SNMPv3 profile is bound to this source device", 404);
  }
  let engineIdHex: string;
  try { engineIdHex = normalizeEngineIdHex(parsed.data.engineIdHex); } catch { return fail("SNMP_ENGINE_ID_INVALID", "SNMPv3 engine ID is invalid", 400); }
  const decision = evaluateSnmpV3EngineObservation(
    { engineIdHex: device.snmpEngineIdHex, boots: device.snmpEngineBoots, time: device.snmpEngineTime },
    { engineIdHex, boots: parsed.data.boots, time: parsed.data.time },
  );
  if (!decision.ok) return fail(decision.code, decision.message, 409);
  const updated = await db.device.updateMany({
    where: { id: device.id, snmpEngineIdHex: device.snmpEngineIdHex, snmpEngineBoots: device.snmpEngineBoots, snmpEngineTime: device.snmpEngineTime },
    data: { snmpEngineBoots: decision.next.boots, snmpEngineTime: decision.next.time, snmpEngineLastSeenAt: new Date() },
  });
  if (updated.count !== 1) return fail("SNMP_REPLAY_RACE", "SNMPv3 engine state changed concurrently; packet was rejected", 409);
  return ok({ accepted: true, correlationId: newCorrelationId("SNMP") });
}
