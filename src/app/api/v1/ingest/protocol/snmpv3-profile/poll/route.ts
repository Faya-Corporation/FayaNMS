import { db } from "@/lib/db";
import { newCorrelationId, fail, ok } from "../../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { normalizeEngineIdHex } from "@/lib/protocol/snmpv3-policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

const profileSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  credentialProfileId: z.string().trim().min(1).max(120).optional(),
}).strict();

export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "telemetry");
  if (!auth.ok) {
    return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("INVALID_BODY", "Request body must be valid JSON", 400); }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", "Invalid SNMPv3 polling profile request", 400);

  const device = await db.device.findUnique({
    where: { id: parsed.data.deviceId },
    select: {
      id: true,
      hostname: true,
      mgmtIp: true,
      snmpEngineIdHex: true,
      snmpEngineBoots: true,
      snmpEngineTime: true,
      credentialProfile: {
        select: { id: true, type: true, username: true, secretRef: true, port: true },
      },
    },
  });
  if (!device || !device.snmpEngineIdHex) {
    return fail("SNMP_ENGINE_UNENROLLED", "SNMPv3 engine ID is not operator-enrolled for this device", 409);
  }
  const linked = device.credentialProfile;
  if (
    !linked ||
    linked.type !== "SNMPV3" ||
    (parsed.data.credentialProfileId && parsed.data.credentialProfileId !== linked.id)
  ) {
    return fail("SNMP_PROFILE_NOT_FOUND", "No matching SNMPv3 profile is bound to this device", 404);
  }

  let engineIdHex: string;
  try { engineIdHex = normalizeEngineIdHex(device.snmpEngineIdHex); }
  catch { return fail("SNMP_ENGINE_ID_INVALID", "Stored SNMPv3 engine ID is invalid", 500); }

  return ok({
    profile: {
      deviceId: device.id,
      hostname: device.hostname,
      mgmtIp: device.mgmtIp,
      port: linked.port,
      credentialProfileId: linked.id,
      username: linked.username,
      secretRef: linked.secretRef,
      engineIdHex,
      engineBoots: device.snmpEngineBoots,
      engineTime: device.snmpEngineTime,
    },
    correlationId: newCorrelationId("SNMP"),
  });
}
