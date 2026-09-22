import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

const pollSchema = z.object({
  credentialProfileId: z.string().trim().min(1).max(120).optional(),
  maxInterfaces: z.number().int().min(1).max(32).default(8),
  interfaceIndexes: z.array(z.number().int().min(1).max(1_000_000)).max(32).optional(),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || id.length > 64) return fail("INVALID_ID", "Invalid device id", 400);

  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("INVALID_BODY", "Request body must be valid JSON", 400); }
  const parsed = pollSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try { actor = await requirePermission(request, "device.read"); }
  catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const device = await db.device.findUnique({
    where: { id },
    select: {
      id: true,
      hostname: true,
      snmpEngineIdHex: true,
      credentialProfile: { select: { id: true, type: true } },
    },
  });
  if (!device) return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  if (!device.snmpEngineIdHex) {
    return fail("SNMP_ENGINE_UNENROLLED", "Enroll the device SNMPv3 engine ID before polling", 409);
  }
  if (
    !device.credentialProfile ||
    device.credentialProfile.type !== "SNMPV3" ||
    (parsed.data.credentialProfileId && parsed.data.credentialProfileId !== device.credentialProfile.id)
  ) {
    return fail("SNMP_PROFILE_NOT_FOUND", "The device has no matching SNMPv3 credential profile", 409);
  }

  const existing = await db.jobExecution.findFirst({
    where: { type: "SNMP_POLL", targetType: "DEVICE", targetId: id, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  });
  if (existing) return fail("SNMP_POLL_IN_FLIGHT", "An SNMPv3 poll is already queued or running for this device", 409);

  const interfaceIndexes = parsed.data.interfaceIndexes
    ? Array.from(new Set(parsed.data.interfaceIndexes))
    : undefined;
  const correlationId = newJobCorrelationId();
  const payload = {
    deviceId: id,
    credentialProfileId: device.credentialProfile.id,
    maxInterfaces: parsed.data.maxInterfaces,
    ...(interfaceIndexes ? { interfaceIndexes } : {}),
  };

  const [job, audit] = await db.$transaction([
    db.jobExecution.create({
      data: {
        type: "SNMP_POLL",
        targetType: "DEVICE",
        targetId: id,
        status: "QUEUED",
        progress: 0,
        priority: 5,
        maxAttempts: 3,
        payloadJson: JSON.stringify(payload),
        correlationId,
      },
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "SNMP_POLL_QUEUED",
        resourceType: "Device",
        resourceId: id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          credentialProfileId: device.credentialProfile.id,
          maxInterfaces: parsed.data.maxInterfaces,
          interfaceIndexes: interfaceIndexes ?? null,
        }),
      },
    }),
  ]);

  return ok(
    {
      jobId: job.id,
      correlationId,
      status: job.status,
      deviceId: id,
      hostname: device.hostname,
      credentialProfileId: device.credentialProfile.id,
      audit: { id: audit.id, action: audit.action },
    },
    { correlationId },
    201,
  );
}
