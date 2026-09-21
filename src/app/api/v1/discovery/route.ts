import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/discovery — recent DISCOVERY jobs (last 10, newest first).
 *   Returns per job: id, correlationId, status, progress, timestamps, the
 *   subnets from payloadJson, the parsed candidates from resultJson (when
 *   SUCCEEDED), how many candidates were imported and the scan duration.
 *
 * POST /api/v1/discovery — queue a discovery scan.
 *   Body: { subnets: string[] (1..4, /24-/32), name?: string }
 *   Creates a QUEUED JobExecution (type DISCOVERY, target SYSTEM) which the
 *   worker mini-service picks up via /api/v1/worker/claim. Candidates are
 *   persistence-free: they land in the job's resultJson and are turned into
 *   real devices by POST /api/v1/discovery/import.
 */

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const CIDR_PATTERN = new RegExp(
  `^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\/(3[0-2]|2[4-9])$`
);

const createSchema = z.object({
  subnets: z
    .array(z.string().trim().regex(CIDR_PATTERN, "must be a CIDR like 10.40.0.0/24 with a /24-/32 prefix"))
    .min(1, "at least one subnet is required")
    .max(4, "a scan is limited to 4 /24-or-smaller subnets"),
  name: z.string().trim().max(120).optional(),
});

interface DiscoveryCandidate {
  ip: string;
  hostname: string;
  vendorGuess: string;
  modelGuess?: string;
  mgmtPort?: number;
  protocols?: string[];
  confidence?: number;
  osFingerprint?: string;
  discoveredAt?: string;
  imported?: boolean;
}

function safeParseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function GET() {
  const jobs = await db.jobExecution.findMany({
    where: { type: "DISCOVERY" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const rows = jobs.map((job) => {
    const payload = safeParseJson(job.payloadJson);
    const result = safeParseJson(job.resultJson);
    const rawCandidates = Array.isArray(result.candidates)
      ? (result.candidates as DiscoveryCandidate[])
      : [];
    const candidates =
      job.status === "SUCCEEDED" && rawCandidates.length > 0 ? rawCandidates : [];
    const subnets = Array.isArray(payload.subnets)
      ? (payload.subnets as unknown[]).map((s) => String(s))
      : [];

    return {
      id: job.id,
      correlationId: job.correlationId,
      name: typeof payload.name === "string" && payload.name ? payload.name : null,
      status: job.status,
      progress: job.progress,
      error: job.error,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      subnets,
      candidateCount: candidates.length,
      importedCount: candidates.filter((c) => c.imported === true).length,
      scannedSubnets:
        typeof result.scannedSubnets === "number" ? result.scannedSubnets : null,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : null,
      candidates,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  });

  return ok(rows);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { subnets, name } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): queueing discovery scans requires
  // the "device.write" permission (the import turns candidates into real
  // devices); the audit row is attributed to the session principal
  // (hardcoded "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const correlationId = newJobCorrelationId();

  const [job, audit] = await db.$transaction([
    db.jobExecution.create({
      data: {
        type: "DISCOVERY",
        targetType: "SYSTEM",
        targetId: null,
        status: "QUEUED",
        progress: 0,
        priority: 5,
        maxAttempts: 3,
        payloadJson: JSON.stringify({ subnets, ...(name ? { name } : {}) }),
        correlationId,
      },
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DISCOVERY_QUEUED",
        resourceType: "SYSTEM",
        resourceLabel: name ?? subnets.join(", "),
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({ subnets, name: name ?? null }),
      },
    }),
  ]);

  return ok(
    {
      jobId: job.id,
      correlationId: job.correlationId,
      status: job.status,
      audit: { id: audit.id, action: audit.action },
    },
    { correlationId },
    201
  );
}
