import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
import { ZTP_TEMPLATES, getZtpTemplate } from "@/lib/ztp/templates";
import { projectMgmtIp } from "@/lib/ztp/provision";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Zero-touch provisioning — claims (Phase 14-b)
 *
 * GET /api/v1/ztp/claims
 *   Everything the ZTP view needs in one read: claims (newest first, enriched
 *   with site/device/projected-mgmt-IP + the claim's latest ZTP_PROVISION
 *   job), the in-code template catalog (src/lib/ztp/templates.ts), vendor and
 *   site option lists, counts by status and the recent ZTP audit trail
 *   (provisioning history). Read-only → no audit event (app convention).
 *
 * POST /api/v1/ztp/claims
 *   Create a claim and enqueue exactly one ZTP_PROVISION JobExecution (same
 *   mechanism the firmware-upgrade enqueue uses: QUEUED row + shared
 *   correlationId + audit, in one transaction). Guards:
 *     422 UNKNOWN_TEMPLATE     — templateId not in ZTP_TEMPLATES
 *     422 TEMPLATE_MISMATCH    — template belongs to another vendor
 *     422 UNKNOWN_VENDOR       — vendorKey not in the seeded vendor set
 *     422 SITE_NOT_FOUND       — siteId does not resolve
 *     409 ZTP_CLAIM_EXISTS     — an ACTIVE claim (pending|provisioning) for
 *                                the serial already exists (failed/provisioned
 *                                serials may re-claim)
 *     409 HOSTNAME_TAKEN       — a Device already runs that hostname (the
 *                                provisioning step would fail later)
 *   The management IP is deliberately NOT part of the request — zero-touch
 *   means the platform projects it from the target site's /24
 *   (src/lib/ztp/provision.ts) and the worker assigns it at registration.
 * ───────────────────────────────────────────────────────────────────────────── */

const ACTIVE_CLAIM_STATUSES = ["pending", "provisioning"] as const;
const CLAIM_STATUSES = ["pending", "provisioning", "provisioned", "failed"] as const;

/** RFC-ish hostname: dot-separated labels of letters/digits/hyphens, 3..63. */
const RFC_HOSTNAME =
  /^(?=.{3,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const createClaimSchema = z.object({
  serial: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{4,64}$/, "serial must be 4-64 alphanumerics or dashes"),
  hostname: z.string().trim().regex(RFC_HOSTNAME, "hostname must be RFC-ish (3-63 chars)"),
  vendorKey: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(80),
  templateId: z.string().trim().min(1).max(64),
  siteId: z.string().trim().min(1).max(64).optional(),
  requestedBy: z.string().trim().min(3).max(120).optional(),
});

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

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const [claims, siteRows, vendorRows, ztpAudits] = await Promise.all([
    db.ztpClaim.findMany({ orderBy: { createdAt: "desc" } }),
    db.site.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    db.vendor.findMany({ orderBy: { key: "asc" }, select: { key: true, name: true } }),
    db.auditEvent.findMany({
      where: { action: { in: ["ZTP_CLAIM_CREATED", "ZTP_PROVISIONED", "ZTP_PROVISION_FAILED"] } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        action: true,
        result: true,
        actorName: true,
        resourceLabel: true,
        correlationId: true,
        createdAt: true,
      },
    }),
  ]);

  // Resolve the latest ZTP_PROVISION job per claim via the enqueue-time
  // targetId link (no JSON querying — the id is indexed through the lookup).
  const claimIds = claims.map((c) => c.id);
  const ztpJobs = claimIds.length
    ? await db.jobExecution.findMany({
        where: { type: "ZTP_PROVISION", targetId: { in: claimIds } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          targetId: true,
          status: true,
          progress: true,
          correlationId: true,
          createdAt: true,
        },
      })
    : [];
  const latestJobByClaim = new Map<string, (typeof ztpJobs)[number]>();
  for (const job of ztpJobs) {
    if (job.targetId && !latestJobByClaim.has(job.targetId)) {
      latestJobByClaim.set(job.targetId, job);
    }
  }

  // Resolve sites + devices for the enriched rows.
  const siteById = new Map(siteRows.map((s) => [s.id, s]));
  const deviceIds = claims.map((c) => c.deviceId).filter((id): id is string => Boolean(id));
  const devices = deviceIds.length
    ? await db.device.findMany({
        where: { id: { in: deviceIds } },
        select: { id: true, hostname: true, mgmtIp: true },
      })
    : [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const vendorNameByKey = new Map(vendorRows.map((v) => [v.key, v.name]));

  const rows = claims.map((claim) => {
    const site = claim.siteId ? siteById.get(claim.siteId) ?? null : null;
    const device = claim.deviceId ? deviceById.get(claim.deviceId) ?? null : null;
    const activeJob = latestJobByClaim.get(claim.id) ?? null;
    // Display status: a pending/provisioning claim whose job is RUNNING is
    // provisioning right now (the persisted flip happens at completion).
    const effectiveStatus =
      (claim.status === "pending" || claim.status === "provisioning") &&
      activeJob?.status === "RUNNING"
        ? "provisioning"
        : claim.status;
    return {
      id: claim.id,
      serial: claim.serial,
      hostname: claim.hostname,
      vendorKey: claim.vendorKey,
      vendorName: vendorNameByKey.get(claim.vendorKey) ?? claim.vendorKey,
      model: claim.model,
      templateId: claim.templateId,
      siteId: claim.siteId,
      siteCode: site?.code ?? null,
      siteName: site?.name ?? null,
      deviceId: claim.deviceId,
      deviceHostname: device?.hostname ?? null,
      status: claim.status,
      effectiveStatus,
      requestedBy: claim.requestedBy,
      // Actual address once provisioned; projected (next free in the site
      // /24) while pending — computed fresh per read, never stored.
      mgmtIp: device?.mgmtIp ?? null,
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
      activeJob: activeJob
        ? {
            id: activeJob.id,
            correlationId: activeJob.correlationId,
            status: activeJob.status,
            progress: activeJob.progress,
            createdAt: activeJob.createdAt.toISOString(),
          }
        : null,
    };
  });

  // Projected addresses for the claims without a device (parallel, cheap).
  const projected: Record<string, string> = {};
  for (const row of rows) {
    if (!row.mgmtIp && row.status !== "provisioned") {
      projected[row.id] = await projectMgmtIp(row.siteId);
    }
  }

  const counts = {
    total: rows.length,
    pending: rows.filter((r) => r.status === "pending").length,
    provisioning: rows.filter((r) => r.effectiveStatus === "provisioning").length,
    provisioned: rows.filter((r) => r.status === "provisioned").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };

  return ok(
    {
      claims: rows.map((row) => ({ ...row, projectedMgmtIp: projected[row.id] ?? null })),
      templates: ZTP_TEMPLATES.map((t) => ({
        id: t.id,
        vendorKey: t.vendorKey,
        name: t.name,
        description: t.description,
        lines: t.lines,
      })),
      vendors: vendorRows.map((v) => ({
        key: v.key,
        name: v.name,
        hasTemplate: ZTP_TEMPLATES.some((t) => t.vendorKey === v.key),
      })),
      sites: siteRows,
      counts,
      history: ztpAudits.map((a) => ({
        action: a.action,
        result: a.result,
        actorName: a.actorName,
        resourceLabel: a.resourceLabel,
        correlationId: a.correlationId,
        createdAt: a.createdAt.toISOString(),
      })),
      meta: { computedAt: new Date().toISOString() },
    },
    undefined,
    200
  );
}

export async function POST(request: Request) {

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { serial, hostname, vendorKey, model, templateId } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): zero-touch provisioning requires
  // the "ztp.provision" permission; the actor is the session principal
  // (resolveActingUser replaced, "Admin" fallback removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "ztp.provision");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  // ── Domain validation (template ↔ vendor ↔ seeded set ↔ site) ──
  const template = getZtpTemplate(templateId);
  if (!template) {
    return fail(
      "UNKNOWN_TEMPLATE",
      `Template "${templateId}" does not exist — available: ${ZTP_TEMPLATES.map((t) => t.id).join(", ")}`,
      422
    );
  }
  if (template.vendorKey !== vendorKey) {
    return fail(
      "TEMPLATE_MISMATCH",
      `Template "${template.id}" provisions ${template.vendorKey} devices, not ${vendorKey}`,
      422
    );
  }
  const vendor = await db.vendor.findUnique({ where: { key: vendorKey } });
  if (!vendor) {
    return fail("UNKNOWN_VENDOR", `Vendor "${vendorKey}" is not in the vendor set`, 422);
  }
  if (parsed.data.siteId) {
    const site = await db.site.findUnique({ where: { id: parsed.data.siteId } });
    if (!site) {
      return fail("SITE_NOT_FOUND", "The referenced site does not exist", 422);
    }
  }

  // ── Duplicate guards ──
  const activeClaim = await db.ztpClaim.findFirst({
    where: { serial, status: { in: [...ACTIVE_CLAIM_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activeClaim) {
    return fail(
      "ZTP_CLAIM_EXISTS",
      `An active claim for serial ${serial} already exists (status ${
        ACTIVE_CLAIM_STATUSES.join("|")
      }) — failed or provisioned serials may re-claim`,
      409
    );
  }
  const hostnameTaken = await db.device.findUnique({
    where: { hostname },
    select: { id: true },
  });
  if (hostnameTaken) {
    return fail(
      "HOSTNAME_TAKEN",
      `A device with hostname ${hostname} already exists — provisioning would collide`,
      409
    );
  }

  const actorName = actor.name ?? "Unknown user";
  const correlationId = newJobCorrelationId();
  const projectedMgmtIp = await projectMgmtIp(parsed.data.siteId ?? null);

  const [claim, job] = await db.$transaction(
    async (tx) => {
      const created = await tx.ztpClaim.create({
        data: {
          serial,
          hostname,
          vendorKey,
          model,
          templateId,
          siteId: parsed.data.siteId ?? null,
          requestedBy: parsed.data.requestedBy ?? null,
          status: "pending",
        },
      });

      const createdJob = await tx.jobExecution.create({
        data: {
          type: "ZTP_PROVISION",
          targetType: "ZTP_CLAIM",
          targetId: created.id,
          status: "QUEUED",
          progress: 0,
          priority: 5,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            claimId: created.id,
            serial,
            hostname,
            vendorKey,
            model,
            templateId,
          }),
          correlationId,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName,
          action: "ZTP_CLAIM_CREATED",
          resourceType: "ZtpClaim",
          resourceId: created.id,
          resourceLabel: `${hostname} (${serial})`,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            claimId: created.id,
            serial,
            hostname,
            vendorKey,
            model,
            templateId,
            siteId: parsed.data.siteId ?? null,
            projectedMgmtIp,
            jobId: createdJob.id,
          }),
        },
      });

      return [created, createdJob] as const;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      claim: {
        id: claim.id,
        serial: claim.serial,
        hostname: claim.hostname,
        vendorKey: claim.vendorKey,
        model: claim.model,
        templateId: claim.templateId,
        siteId: claim.siteId,
        status: claim.status,
        requestedBy: claim.requestedBy,
        createdAt: claim.createdAt.toISOString(),
      },
      jobId: job.id,
      correlationId,
      projectedMgmtIp,
      type: "ZTP_PROVISION",
      status: "QUEUED",
    },
    { actor: actorName },
    200
  );
}
