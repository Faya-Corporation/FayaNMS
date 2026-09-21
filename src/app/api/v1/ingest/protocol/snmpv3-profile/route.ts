import { db } from "@/lib/db";
import { newCorrelationId, fail, ok } from "../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

const profileLookupSchema = z.object({
  sourceIp: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(80),
  engineId: z.string().trim().regex(/^[0-9a-f]{2,128}$/i),
}).strict();

/**
 * POST /api/v1/ingest/protocol/snmpv3-profile — worker-only profile lookup.
 * Returns the vault reference, never a secret value. The worker resolves the
 * reference locally before verifying the packet. Lookup is constrained by
 * source management IP, SNMPv3 username, and an active device assignment.
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
  const parsed = profileLookupSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", "Invalid SNMPv3 profile lookup", 400);
  const device = await db.device.findFirst({
    where: { mgmtIp: parsed.data.sourceIp },
    select: {
      hostname: true,
      credentialProfile: { select: { id: true, type: true, username: true, secretRef: true } },
    },
  });
  const profile = device?.credentialProfile;
  if (
    !device ||
    !profile ||
    profile.type !== "SNMPV3" ||
    profile.username !== parsed.data.username
  ) {
    return fail("SNMP_PROFILE_NOT_FOUND", "No active SNMPv3 profile is bound to this source device", 404);
  }
  return ok({
    profile: {
      credentialProfileId: profile.id,
      hostname: device.hostname,
      username: profile.username,
      secretRef: profile.secretRef,
    },
    correlationId: newCorrelationId("SNMP"),
  });
}
