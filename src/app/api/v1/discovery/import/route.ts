import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/discovery/import — turn discovered candidates into real
 * devices.
 *
 * Body: { jobId, ips: string[] (1..50), siteId?, credentialProfileId?,
 *         criticality, managed }
 *
 * For every requested ip the matching candidate is looked up in the job's
 * resultJson (persistence-free discovery pattern — see GET /api/v1/discovery).
 * Devices are created transaction-safe with hostname from the candidate and
 * vendor resolved from the candidate's vendorGuess against the Vendor table
 * (case-insensitive by key). Failures are per-row and collected in `skipped`:
 *   - ip not part of the scan results
 *   - duplicate hostname or mgmtIp (in DB or within this batch)
 *   - vendorGuess with no matching vendor row
 *
 * On success the job's resultJson is rewritten: every imported candidate is
 * flagged `imported: true` and the top level gains an `importedIps` array
 * (raw candidate fields are preserved). One DEVICE_CREATED AuditEvent is
 * written per created device with the scan's correlationId.
 */

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const importSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  ips: z
    .array(z.string().trim().regex(IPV4_PATTERN, "must be a valid IPv4 address"))
    .min(1, "at least one IP is required")
    .max(50, "import is limited to 50 candidates at a time"),
  siteId: z.string().trim().min(1).optional(),
  credentialProfileId: z.string().trim().min(1).optional(),
  // criticality: LOW | MEDIUM | HIGH | CRITICAL
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  managed: z.boolean().default(true),
});

interface DiscoveryCandidate {
  ip: string;
  hostname: string;
  vendorGuess: string;
  modelGuess?: string;
  subnet?: string;
  mgmtPort?: number;
  openPorts?: number[];
  protocols?: string[];
  confidence?: number;
  osFingerprint?: string;
  discoveredAt?: string;
  imported?: boolean;
}

interface PendingImport {
  ip: string;
  candidate: DiscoveryCandidate;
  vendorId: string;
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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { jobId, ips, siteId, credentialProfileId, criticality, managed } =
    parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): importing candidates creates real
  // devices — it requires the "device.write" permission and the audit rows
  // are attributed to the session principal (hardcoded "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const job = await db.jobExecution.findUnique({ where: { id: jobId } });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced discovery job does not exist", 404);
  }
  if (job.type !== "DISCOVERY") {
    return fail("INVALID_JOB", "The referenced job is not a discovery scan", 400);
  }

  const result = safeParseJson(job.resultJson);
  const candidates = (Array.isArray(result.candidates)
    ? (result.candidates as DiscoveryCandidate[])
    : []
  ).filter((c) => c && typeof c.ip === "string" && typeof c.hostname === "string");
  const byIp = new Map(candidates.map((c) => [c.ip, c]));

  if (siteId) {
    const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) {
      return fail("SITE_NOT_FOUND", "The selected site does not exist", 400);
    }
  }
  if (credentialProfileId) {
    const profile = await db.credentialProfile.findUnique({
      where: { id: credentialProfileId },
      select: { id: true },
    });
    if (!profile) {
      return fail(
        "CREDENTIAL_PROFILE_NOT_FOUND",
        "The selected credential profile does not exist",
        400
      );
    }
  }

  const vendors = await db.vendor.findMany({ select: { id: true, key: true } });
  const vendorByKey = new Map(vendors.map((v) => [v.key.toLowerCase(), v.id]));

  // Dedupe the request while preserving order.
  const requestedIps = Array.from(new Set(ips));

  // Pre-load conflicting hostnames / mgmt IPs (single round trip).
  const requestedCandidates = requestedIps
    .map((ip) => byIp.get(ip))
    .filter((c): c is DiscoveryCandidate => Boolean(c));
  const [existingHostnames, existingIps] = await Promise.all([
    db.device.findMany({
      where: { hostname: { in: requestedCandidates.map((c) => c.hostname) } },
      select: { hostname: true },
    }),
    db.device.findMany({
      where: { mgmtIp: { in: requestedIps } },
      select: { mgmtIp: true },
    }),
  ]);
  const takenHostnames = new Set(existingHostnames.map((d) => d.hostname));
  const takenIps = new Set(existingIps.map((d) => d.mgmtIp));

  // Plan the batch first: per-row validation errors go to `skipped`, the rest
  // is created inside one transaction. Hostname/ip are reserved immediately so
  // duplicates inside the same batch are detected too.
  const skipped: { ip: string; reason: string }[] = [];
  const pending: PendingImport[] = [];

  for (const ip of requestedIps) {
    const candidate = byIp.get(ip);
    if (!candidate) {
      skipped.push({ ip, reason: "IP is not part of this scan's results" });
      continue;
    }
    if (takenHostnames.has(candidate.hostname) || takenIps.has(ip)) {
      skipped.push({ ip, reason: "duplicate" });
      continue;
    }
    const vendorId = vendorByKey.get(candidate.vendorGuess.toLowerCase());
    if (!vendorId) {
      skipped.push({ ip, reason: "unknown vendor" });
      continue;
    }
    takenHostnames.add(candidate.hostname);
    takenIps.add(ip);
    pending.push({ ip, candidate, vendorId });
  }

  const created: { id: string; hostname: string; ip: string }[] = [];

  if (pending.length > 0) {
    await db.$transaction(async (tx) => {
      for (const entry of pending) {
        const device = await tx.device.create({
          data: {
            hostname: entry.candidate.hostname,
            displayName: entry.candidate.hostname,
            mgmtIp: entry.ip,
            vendorId: entry.vendorId,
            model: entry.candidate.modelGuess ?? null,
            siteId: siteId ?? null,
            status: managed ? "UNKNOWN" : "UNMANAGED",
            criticality,
            healthScore: 0,
            backupCompliance: "UNKNOWN",
            tagsJson: JSON.stringify(["discovered"]),
            notes: `Discovered via scan ${job.correlationId}`,
          },
          select: { id: true, hostname: true, mgmtIp: true },
        });
        created.push({
          id: device.id,
          hostname: device.hostname,
          ip: device.mgmtIp,
        });

        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Unknown user",
            action: "DEVICE_CREATED",
            resourceType: "Device",
            resourceId: device.id,
            resourceLabel: device.hostname,
            result: "SUCCESS",
            correlationId: job.correlationId,
            afterJson: JSON.stringify({
              hostname: device.hostname,
              mgmtIp: device.mgmtIp,
              vendor: entry.candidate.vendorGuess,
              model: entry.candidate.modelGuess ?? null,
              siteId: siteId ?? null,
              credentialProfileId: credentialProfileId ?? null,
              criticality,
              status: managed ? "UNKNOWN" : "UNMANAGED",
              source: "DISCOVERY",
              scanCorrelationId: job.correlationId,
            }),
          },
        });
      }

      // Mark the imported candidates in the job's resultJson (raw fields kept).
      const importedSet = new Set(created.map((d) => d.ip));
      const previouslyImported = Array.isArray(result.importedIps)
        ? (result.importedIps as string[])
        : [];
      const updatedCandidates = candidates.map((c) =>
        importedSet.has(c.ip) ? { ...c, imported: true } : c
      );
      await tx.jobExecution.update({
        where: { id: job.id },
        data: {
          resultJson: JSON.stringify({
            ...result,
            candidates: updatedCandidates,
            importedIps: Array.from(new Set([...previouslyImported, ...importedSet])),
          }),
        },
      });
    });
  }

  return ok({ created: created.length, devices: created, skipped });
}
