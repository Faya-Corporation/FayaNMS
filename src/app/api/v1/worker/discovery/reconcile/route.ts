import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const cidr = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(\d|[12]\d|3[0-2])$/;

const candidateSchema = z.object({
  ip: z.string().trim().regex(ipv4),
  hostname: z.string().trim().min(1).max(255),
  subnet: z.string().trim().regex(cidr),
  vendorGuess: z.literal("generic"),
  mgmtPort: z.number().int().min(1).max(65_535).optional(),
  openPorts: z.array(z.number().int().min(1).max(65_535)).max(4).optional(),
  protocols: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
  confidence: z.number().int().min(0).max(100),
  osFingerprint: z.string().trim().min(1).max(120),
}).strict();

const reconcileSchema = z.object({
  jobId: z.string().trim().min(1).max(64),
  candidates: z.array(candidateSchema).max(1_024),
}).strict();

/**
 * Persist bounded wire-derived discovery evidence and reconcile exact known
 * management IPs. Reverse DNS and TCP reachability never create a Device,
 * infer a vendor, or create a topology edge.
 */
export async function POST(request: Request) {
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) return fail(service.code, service.message, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = reconcileSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  const job = await db.jobExecution.findUnique({
    where: { id: parsed.data.jobId },
    select: { id: true, type: true, status: true, correlationId: true },
  });
  if (!job) return fail("JOB_NOT_FOUND", "The referenced discovery job does not exist", 404);
  if (job.type !== "DISCOVERY") return fail("INVALID_JOB", "The referenced job is not a discovery job", 400);
  if (job.status !== "RUNNING") {
    return ok({ jobId: job.id, observed: 0, matchedDevices: 0, unmatched: 0, lastSeenUpdated: 0, updated: false });
  }

  const ips = Array.from(new Set(parsed.data.candidates.map((candidate) => candidate.ip)));
  const devices = ips.length > 0
    ? await db.device.findMany({
        where: { mgmtIp: { in: ips } },
        select: { id: true, mgmtIp: true },
      })
    : [];
  const deviceByIp = new Map(devices.map((device) => [device.mgmtIp, device.id]));
  const now = new Date();
  const matchedIds = Array.from(new Set(
    parsed.data.candidates
      .map((candidate) => deviceByIp.get(candidate.ip))
      .filter((id): id is string => typeof id === "string"),
  ));
  const unmatched = parsed.data.candidates.filter((candidate) => !deviceByIp.has(candidate.ip)).length;

  const result = await db.$transaction(async (tx) => {
    const observations = await tx.discoveryObservation.createMany({
      data: parsed.data.candidates.map((candidate) => ({
        jobId: job.id,
        deviceId: deviceByIp.get(candidate.ip) ?? null,
        correlationId: job.correlationId,
        subnet: candidate.subnet,
        ip: candidate.ip,
        hostname: candidate.hostname,
        reachable: true,
        openPortsJson: JSON.stringify(
          Array.from(new Set(candidate.openPorts ?? (candidate.mgmtPort ? [candidate.mgmtPort] : []))).sort((a, b) => a - b),
        ),
        protocolsJson: JSON.stringify(Array.from(new Set(candidate.protocols ?? [])).sort()),
        confidence: candidate.confidence,
        osFingerprint: candidate.osFingerprint,
        observedAt: now,
      })),
      skipDuplicates: true,
    });
    const updatedDevices = matchedIds.length > 0
      ? await tx.device.updateMany({
          where: { id: { in: matchedIds } },
          data: { lastSeen: now },
        })
      : { count: 0 };
    await tx.auditEvent.create({
      data: {
        actorName: "worker:discovery-reconcile",
        action: "DISCOVERY_RECONCILED",
        resourceType: "DiscoveryJob",
        resourceId: job.id,
        resourceLabel: job.correlationId,
        result: "SUCCESS",
        correlationId: job.correlationId,
        afterJson: JSON.stringify({
          observationsCreated: observations.count,
          matchedDevices: matchedIds.length,
          unmatched,
          lastSeenUpdated: updatedDevices.count,
          evidence: "TCP_REACHABILITY_AND_REVERSE_DNS",
        }),
      },
    });
    return {
      observationsCreated: observations.count,
      lastSeenUpdated: updatedDevices.count,
    };
  });

  return ok({
    jobId: job.id,
    observed: result.observationsCreated,
    matchedDevices: matchedIds.length,
    unmatched,
    lastSeenUpdated: result.lastSeenUpdated,
    updated: true,
  });
}
