import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { parsePolicyScope, scopeDeviceWhere } from "../../_lib/scope";
import { isValidCronExpr } from "@/lib/cron";
import {
  authErrorToFail,
  requirePermission,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { backupPolicyScopeDenial } from "../policy-scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET    /api/v1/backup-policies/[id] — single policy with computed stats.
 * PATCH  /api/v1/backup-policies/[id] — partial update (audited, BACKUP_POLICY_UPDATED,
 *        beforeJson + afterJson). Scope is replaced whole when provided.
 * DELETE /api/v1/backup-policies/[id] — delete (audited, BACKUP_POLICY_DELETED).
 *        Policies are standalone rows — nothing references them, so a plain
 *        delete cannot orphan backup history.
 */

const CRITICALITY_VALUES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const STATUS_VALUES = ["ONLINE", "DEGRADED", "MAINTENANCE", "UNKNOWN"] as const;

const scopeSchema = z.object({
  siteCodes: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
  criticalities: z.array(z.enum(CRITICALITY_VALUES)).optional(),
  statuses: z.array(z.enum(STATUS_VALUES)).optional(),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(120).optional(),
    cronExpr: z
      .string()
      .trim()
      .min(1, "cronExpr is required")
      .max(120)
      .refine(isValidCronExpr, {
        message:
          "cronExpr must be a 5-field numeric cron (minute hour day-of-month month day-of-week), e.g. 0 2 * * *",
      })
      .optional(),
    scope: scopeSchema.optional(),
    retentionDays: z.coerce.number().int().min(1).max(3650).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

/** Canonical scope object → serialized scopeJson (empty keys dropped). */
function serializeScope(scope: z.infer<typeof scopeSchema>): string {
  const cleaned: Record<string, string[]> = {};
  if (scope.siteCodes && scope.siteCodes.length > 0)
    cleaned.siteCodes = Array.from(new Set(scope.siteCodes));
  if (scope.criticalities && scope.criticalities.length > 0)
    cleaned.criticalities = Array.from(new Set(scope.criticalities));
  if (scope.statuses && scope.statuses.length > 0)
    cleaned.statuses = Array.from(new Set(scope.statuses));
  return JSON.stringify(cleaned);
}

const ID_MAX = 64;

async function findPolicyOr404(id: string) {
  if (!id || id.length > ID_MAX) return null;
  return db.backupPolicy.findUnique({ where: { id } });
}

async function policyResponse(request: Request, id: string) {
  const policy = await db.backupPolicy.findUnique({ where: { id } });
  if (!policy) return null;
  const scope = parsePolicyScope(policy.scopeJson);
  const [scopedDeviceCount, lastEnqueued] = await Promise.all([
    // F-031 wave-10 (audit 13-c F-9): twin-divergence regression fix — the
    // detail count now intersects the policy's device scope with the
    // SESSION's site scope EXACTLY like the list route (route.ts, wave-9):
    // scopedDeviceWhere(await sessionScopeFor(request), scopeDeviceWhere).
    // Wildcard sessions compose the identical base where (parity); a
    // sites-limited session sees how many of ITS devices the policy would
    // schedule, not the fleet-wide count.
    db.device.count({
      where: scopedDeviceWhere(await sessionScopeFor(request), scopeDeviceWhere(scope)),
    }),
    db.jobExecution.findFirst({
      where: {
        type: "CONFIG_BACKUP",
        payloadJson: { contains: `"policyId":"${policy.id}"` },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return {
    id: policy.id,
    name: policy.name,
    cronExpr: policy.cronExpr,
    scope: {
      siteCodes: scope.siteCodes ?? [],
      criticalities: scope.criticalities ?? [],
      statuses: scope.statuses ?? [],
    },
    retentionDays: policy.retentionDays,
    isActive: policy.isActive,
    scopedDeviceCount,
    lastEnqueuedAt: lastEnqueued?.createdAt.toISOString() ?? null,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
  const { id } = await params;
  const policy = await policyResponse(request, id);
  if (!policy) {
    return fail("POLICY_NOT_FOUND", "The requested backup policy does not exist", 404);
  }
  return ok(policy);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): editing backup policies requires
  // the "config.backup" permission; the audit row is attributed to the
  // session principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const policy = await findPolicyOr404(id);
  if (!policy) {
    return fail("POLICY_NOT_FOUND", "The requested backup policy does not exist", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  // P1-A03 (GA re-audit 2026-10-06 — supersedes the POST route's old 13-c
  // F-10 owner note): PATCH replaces the scope WHOLE when provided, so the
  // guard evaluates the EFFECTIVE post-replacement site list: a provided
  // scope without siteCodes (or with an empty array) serializes to a
  // fleet-wide scopeJson and is therefore denied for site-limited sessions,
  // exactly like an explicit "*". When the patch does not touch scope at
  // all, the actor cannot widen anything and no check is needed. Wildcard
  // sessions are byte-unchanged.
  if (data.scope !== undefined) {
    const scope = sessionSiteScope(await sessionScopeFor(request));
    if (scope.mode === "sites") {
      const denial = backupPolicyScopeDenial(scope.codes, data.scope.siteCodes);
      if (denial) {
        return fail("SITE_SCOPE_FORBIDDEN", denial, 403);
      }
    }
  }

  // Validate site codes against the inventory (or "*" for fleet-wide).
  if (data.scope?.siteCodes && data.scope.siteCodes.length > 0) {
    const codes = data.scope.siteCodes;
    if (!codes.includes("*")) {
      const sites = await db.site.findMany({
        where: { code: { in: codes } },
        select: { code: true },
      });
      const known = new Set(sites.map((site) => site.code));
      const unknown = codes.filter((code) => !known.has(code));
      if (unknown.length > 0) {
        return fail(
          "SITE_CODE_INVALID",
          `Unknown site code(s): ${unknown.join(", ")}`,
          400
        );
      }
    }
  }

  if (data.name && data.name !== policy.name) {
    const nameOwner = await db.backupPolicy.findUnique({
      where: { name: data.name },
      select: { id: true },
    });
    if (nameOwner && nameOwner.id !== policy.id) {
      return fail(
        "NAME_TAKEN",
        `A backup policy named "${data.name}" already exists`,
        409
      );
    }
  }

  const before = {
    name: policy.name,
    cronExpr: policy.cronExpr,
    scope: parsePolicyScope(policy.scopeJson),
    retentionDays: policy.retentionDays,
    isActive: policy.isActive,
  };

  const correlationId = newCorrelationId("POL");

  // F-11 (audit 13-c): the update and its BACKUP_POLICY_UPDATED audit row
  // land in ONE transaction (the baselines/cmdb pattern) — a failed audit
  // write can no longer leave an unaudited policy change behind.
  const [updated, audit] = await db.$transaction(async (tx) => {
    const next = await tx.backupPolicy.update({
      where: { id: policy.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.cronExpr !== undefined ? { cronExpr: data.cronExpr } : {}),
        ...(data.scope !== undefined ? { scopeJson: serializeScope(data.scope) } : {}),
        ...(data.retentionDays !== undefined
          ? { retentionDays: data.retentionDays }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    const after = {
      name: next.name,
      cronExpr: next.cronExpr,
      scope: parsePolicyScope(next.scopeJson),
      retentionDays: next.retentionDays,
      isActive: next.isActive,
    };

    const auditRow = await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "BACKUP_POLICY_UPDATED",
        resourceType: "BackupPolicy",
        resourceId: next.id,
        resourceLabel: next.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
      },
    });

    return [next, auditRow] as const;
  });

  return ok({ policy: updated, audit }, { correlationId });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): deleting backup policies requires
  // the "config.backup" permission; the audit row is attributed to the
  // session principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(_request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const policy = await findPolicyOr404(id);
  if (!policy) {
    return fail("POLICY_NOT_FOUND", "The requested backup policy does not exist", 404);
  }

  const correlationId = newCorrelationId("POL");

  // F-11 (audit 13-c): the delete and its BACKUP_POLICY_DELETED audit row
  // land in ONE transaction (the baselines/cmdb pattern) — a failed audit
  // write can no longer leave an unaudited policy deletion behind.
  const audit = await db.$transaction(async (tx) => {
    await tx.backupPolicy.delete({ where: { id: policy.id } });

    return tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "BACKUP_POLICY_DELETED",
        resourceType: "BackupPolicy",
        resourceId: policy.id,
        resourceLabel: policy.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({
          name: policy.name,
          cronExpr: policy.cronExpr,
          scope: parsePolicyScope(policy.scopeJson),
          retentionDays: policy.retentionDays,
          isActive: policy.isActive,
        }),
      },
    });
  });

  return ok({ deleted: true, audit }, { correlationId });
}
