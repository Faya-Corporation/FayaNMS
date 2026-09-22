import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { normalizeEngineIdHex } from "@/lib/protocol/snmpv3-policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

const counterSchema = z.string().regex(/^\d{1,20}$/).nullable();
const pollResultSchema = z.object({
  polledAt: z.string().min(1).max(40),
  durationMs: z.number().int().min(0).max(120_000),
  requests: z.number().int().min(1).max(512),
  attempts: z.number().int().min(1).max(1_024),
  optionalFailures: z.number().int().min(0).max(512),
  engine: z.object({
    engineIdHex: z.string().regex(/^[0-9a-f]{10,128}$/i),
    boots: z.number().int().min(0),
    time: z.number().int().min(0),
  }).strict(),
  system: z.object({
    sysName: z.string().max(255).nullable(),
    sysDescr: z.string().max(512).nullable(),
    uptimeSeconds: z.number().int().min(0).nullable(),
    uptimeTicks: z.number().int().min(0).nullable(),
    interfaceCount: z.number().int().min(0).max(1_000_000).nullable(),
  }).strict(),
  interfaces: z.array(z.object({
    index: z.number().int().min(1).max(1_000_000),
    name: z.string().trim().min(1).max(255),
    operStatus: z.enum(["UP", "DOWN", "TESTING", "DORMANT", "NOT_PRESENT", "LOWER_LAYER_DOWN", "UNKNOWN"]),
    inOctets: counterSchema,
    outOctets: counterSchema,
  }).strict()).max(32),
}).strict();

const completeSchema = z.object({
  jobId: z.string().trim().min(1),
  result: z.unknown(),
}).strict();

export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "jobs");
  if (!auth.ok) {
    return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail("INVALID_BODY", "Request body must be valid JSON", 400); }
  const parsedBody = completeSchema.safeParse(body);
  if (!parsedBody.success) return fail("INVALID_BODY", firstIssueMessage(parsedBody.error), 400);
  const parsedResult = pollResultSchema.safeParse(parsedBody.data.result);
  if (!parsedResult.success) return fail("INVALID_RESULT", firstIssueMessage(parsedResult.error), 400);
  const result = parsedResult.data;

  let engineIdHex: string;
  try { engineIdHex = normalizeEngineIdHex(result.engine.engineIdHex); }
  catch { return fail("SNMP_ENGINE_ID_INVALID", "SNMPv3 poll returned an invalid engine ID", 400); }

  const job = await db.jobExecution.findUnique({ where: { id: parsedBody.data.jobId } });
  if (!job) return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  if (job.type !== "SNMP_POLL") return fail("JOB_TYPE_MISMATCH", "The referenced job is not an SNMPv3 poll", 409);
  if (job.status !== "RUNNING") {
    return ok({ jobId: job.id, updated: false, reason: "job status is " + job.status });
  }
  if (!job.targetId) return fail("TARGET_MISSING", "The SNMPv3 poll job has no device target", 409);

  const now = new Date();
  const persisted = await db.$transaction(async (tx) => {
    const device = await tx.device.findUnique({
      where: { id: job.targetId as string },
      select: {
        id: true,
        hostname: true,
        snmpEngineIdHex: true,
        snmpEngineBoots: true,
        snmpEngineTime: true,
        status: true,
      },
    });
    if (!device) return { kind: "missing" as const };
    if (!device.snmpEngineIdHex || device.snmpEngineIdHex.toLowerCase() !== engineIdHex) {
      return { kind: "engine-mismatch" as const };
    }
    // Completion is accepted only after the worker passes the server-side
    // engine boots/time acceptance endpoint.
    if (device.snmpEngineBoots !== result.engine.boots || device.snmpEngineTime !== result.engine.time) {
      return { kind: "engine-not-accepted" as const };
    }

    const deviceUpdate: { lastSeen: Date; uptimeSeconds?: bigint; status?: string } = { lastSeen: now };
    if (result.system.uptimeSeconds !== null) deviceUpdate.uptimeSeconds = BigInt(result.system.uptimeSeconds);
    if (device.status !== "MAINTENANCE") deviceUpdate.status = "ONLINE";
    await tx.device.update({ where: { id: device.id }, data: deviceUpdate });

    for (const item of result.interfaces) {
      await tx.deviceInterface.upsert({
        where: { deviceId_name: { deviceId: device.id, name: item.name } },
        create: { deviceId: device.id, name: item.name, operStatus: item.operStatus },
        update: { operStatus: item.operStatus },
      });
    }

    await tx.metricSample.create({
      data: { deviceId: device.id, metric: "LATENCY_MS", value: result.durationMs, ts: now },
    });
    await tx.jobExecution.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        progress: 100,
        finishedAt: now,
        error: null,
        resultJson: JSON.stringify(result),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorName: "system:snmp-poller",
        action: "SNMP_POLL_COMPLETED",
        resourceType: "Device",
        resourceId: device.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId: job.correlationId,
        afterJson: JSON.stringify({
          engineIdHex,
          boots: result.engine.boots,
          time: result.engine.time,
          sysName: result.system.sysName,
          interfaceCount: result.interfaces.length,
          optionalFailures: result.optionalFailures,
          durationMs: result.durationMs,
        }),
      },
    });
    return {
      kind: "ok" as const,
      deviceId: device.id,
      hostname: device.hostname,
      interfaces: result.interfaces.length,
    };
  }, { maxWait: 5_000, timeout: 20_000 });

  if (persisted.kind === "missing") return fail("DEVICE_NOT_FOUND", "The poll target device no longer exists", 404);
  if (persisted.kind === "engine-mismatch") return fail("SNMP_ENGINE_ID_MISMATCH", "SNMPv3 poll engine ID is not enrolled for the device", 409);
  if (persisted.kind === "engine-not-accepted") return fail("SNMP_ENGINE_STATE_NOT_ACCEPTED", "SNMPv3 engine state must be accepted before poll completion", 409);

  return ok({
    jobId: job.id,
    updated: true,
    status: "SUCCEEDED",
    deviceId: persisted.deviceId,
    hostname: persisted.hostname,
    interfaces: persisted.interfaces,
  });
}
