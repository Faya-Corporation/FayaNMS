import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import {
  authErrorToFail,
  requirePermission,
  requireSessionRead,
  requireSiteScope,
  sessionScopeFor,
} from "@/lib/auth/session";
import {
  scopedDeviceWhere,
  sessionSiteScope,
  siteScopeAllows,
} from "@/lib/auth/scope";
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
 *   Wave-9 (audit 9-b P2 F-2) — the read is now SITE-SCOPED (F-031):
 *     Permission posture: POST gates on "ztp.provision", but NO "ztp.read"
 *     permission exists in the seeded role matrix / authorization matrix —
 *     minting one here would silently drop every non-admin role off this
 *     read (a role-matrix + seed contract change, out of scope for a route
 *     fix). The F-008 session-read gate is therefore KEPT, and the leak is
 *     closed by scoping every payload the read returns:
 *       - Wildcard sessions (no `sites` claim — the single-tenant default):
 *         BYTE-IDENTICAL response to the pre-wave-9 route.
 *       - Sites-limited sessions: a claim is visible iff its EFFECTIVE site
 *         code is in scope — the claim's target site (siteId) when set,
 *         else its provisioned device's site (a claim provisions INTO that
 *         device's site). When neither resolves (no target site and the
 *         device row is absent, site-less, or itself out of scope) the
 *         claim composes exactly like a site-less device under
 *         scopedDeviceWhere's SQL parity (`site: { code: { in: … } }`
 *         cannot match NULL) → hidden, fail-closed; a deny-all scope sees
 *         an empty read. Out-of-scope device identity (hostname/mgmtIp)
 *         never enriches any row — the enrichment query is scope-composed.
 *       - The site catalog and the status counts are computed over the
 *         scoped set; the ZTP audit history is scoped by the claim its rows
 *         belong to (all three ZTP writers stamp resourceType "ZtpClaim"
 *         + resourceId = claim id), so a scoped session receives the 12
 *         most recent rows of ITS claims; wildcard keeps the original
 *         unfiltered take-12.
 *       - ZtpClaim carries only SCALAR siteId/deviceId (no Prisma relation
 *         — the phase-14 contract), so the row filter resolves in
 *         application code with the SAME central classifier
 *         (siteScopeAllows) instead of a hand-rolled predicate; the device
 *         enrichment query composes scopedDeviceWhere directly.
 *       - API-client bearer reads resolve null claims → WILDCARD (the
 *         documented sessionScopeFor posture for that plane); anonymous
 *         requests never reach scope evaluation (401 above).
 *
 * POST /api/v1/ztp/claims
 *   Create a claim and enqueue exactly one ZTP_PROVISION JobExecution (same
 *   mechanism the firmware-upgrade enqueue uses: QUEUED row + shared
 *   correlationId + audit, in one transaction). Guards:
 *     422 UNKNOWN_TEMPLATE     — templateId not in ZTP_TEMPLATES
 *     422 TEMPLATE_MISMATCH    — template belongs to another vendor
 *     422 UNKNOWN_VENDOR       — vendorKey not in the seeded vendor set
 *     422 SITE_NOT_FOUND       — siteId does not resolve
 *     403 SITE_SCOPE_FORBIDDEN — the session's site scope does not include
 *                                the target site (F-031 create surface,
 *                                site-scope wave 7)
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
  // Wave-9 scope resolution (see the GET docstring): null claims (the
  // API-client bearer plane) resolve WILDCARD by design; every anonymous
  // request has already been answered 401 by requireSessionRead above.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const scoped = scope.mode === "sites";

  const [claimRows, siteRows, vendorRows] = await Promise.all([
    db.ztpClaim.findMany({ orderBy: { createdAt: "desc" } }),
    db.site.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    db.vendor.findMany({ orderBy: { key: "asc" }, select: { key: true, name: true } }),
  ]);
  const siteById = new Map(siteRows.map((s) => [s.id, s]));

  // Device enrichment — scope-composed so out-of-scope device identity
  // (hostname/mgmtIp/site) can never reach a sites-limited session. The
  // site code in the select feeds the effective-site rule below. Wildcard
  // sessions get the base where unchanged (the parity guarantee).
  const deviceIds = claimRows.map((c) => c.deviceId).filter((id): id is string => Boolean(id));
  const devices = deviceIds.length
    ? await db.device.findMany({
        where: scopedDeviceWhere(scopeClaims, { id: { in: deviceIds } }),
        select: { id: true, hostname: true, mgmtIp: true, site: { select: { code: true } } },
      })
    : [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  // Row-level claim filter (wildcard → claimRows untouched). Effective site
  // = the claim's target site, else its provisioned device's site; neither
  // resolvable → hidden for sites-limited sessions (SQL-relation parity).
  const claims = scoped
    ? claimRows.filter((claim) => {
        const device = claim.deviceId ? deviceById.get(claim.deviceId) ?? null : null;
        const siteCode =
          (claim.siteId ? siteById.get(claim.siteId)?.code : undefined) ??
          device?.site?.code ??
          null;
        return siteScopeAllows(scope, siteCode);
      })
    : claimRows;

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

  // Site catalog: sites-limited sessions see only their own sites (order
  // preserved — the filter composes over the code-asc list).
  const catalogSites = scoped
    ? siteRows.filter((s) => siteScopeAllows(scope, s.code))
    : siteRows;

  // ZTP audit history (provisioning trail): wildcard keeps the original
  // fleet-wide take-12; sites-limited sessions get the 12 most recent rows
  // whose ZtpClaim resource is one of THEIR claims (all three ZTP writers
  // — POST below and the worker's ZTP_PROVISIONED / ZTP_PROVISION_FAILED —
  // stamp resourceType "ZtpClaim" + resourceId = claim id).
  const ztpAuditWhere = {
    action: { in: ["ZTP_CLAIM_CREATED", "ZTP_PROVISIONED", "ZTP_PROVISION_FAILED"] },
    ...(scoped ? { resourceType: "ZtpClaim", resourceId: { in: claimIds } } : {}),
  };
  const ztpAudits = scoped && claimIds.length === 0
    ? []
    : await db.auditEvent.findMany({
        where: ztpAuditWhere,
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
      });

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
      sites: catalogSites,
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
    // F-031 site-scope wave 7 (create surfaces): a claim provisions its
    // device into the target site, so a sites-limited session may only
    // claim into a site inside its scope — requireSiteScope answers 403
    // SITE_SCOPE_FORBIDDEN, mirroring POST /api/v1/devices's mutation
    // contract (the existence error precedes the scope 403, exactly like
    // the vendor 400 there).
    try {
      await requireSiteScope(request, site.code);
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
  }

  // ── Duplicate guards ──
  // The envelope is shared with the P2002 catch below so a concurrent
  // duplicate (which raced past this guard) answers the exact same error.
  const ztpClaimExistsMessage = `An active claim for serial ${serial} already exists (status ${
    ACTIVE_CLAIM_STATUSES.join("|")
  }) — failed or provisioned serials may re-claim`;
  const activeClaim = await db.ztpClaim.findFirst({
    where: { serial, status: { in: [...ACTIVE_CLAIM_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activeClaim) {
    return fail("ZTP_CLAIM_EXISTS", ztpClaimExistsMessage, 409);
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

  const createClaimAndJob = () =>
    db.$transaction(
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

  // Wave-9 (audit 9-b P3): a concurrent claim for the same serial raced
  // past the active-claim guard — ZtpClaim.serial @unique surfaces Prisma
  // P2002 inside the transaction. Answer the SAME 409 envelope the guard
  // produces instead of a raw 500; the aborted transaction committed
  // nothing (claim, job and audit roll back together).
  let claimAndJob: Awaited<ReturnType<typeof createClaimAndJob>>;
  try {
    claimAndJob = await createClaimAndJob();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return fail("ZTP_CLAIM_EXISTS", ztpClaimExistsMessage, 409);
    }
    throw error;
  }
  const [claim, job] = claimAndJob;

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
