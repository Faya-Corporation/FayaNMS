import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { parsePolicyScope, scopeDeviceWhere } from "../../_lib/scope";
import { isValidCronExpr } from "@/lib/cron";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
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

async function policyResponse(id: string) {
  const policy = await db.backupPolicy.findUnique({ where: { id } });
  if (!policy) return null;
  const scope = parsePolicyScope(policy.scopeJson);
  const [scopedDeviceCount, lastEnqueued] = await Promise.all([
    db.device.count({ where: scopeDeviceWhere(scope) }),
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
  const policy = await policyResponse(id);
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

  const updated = await db.backupPolicy.update({
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
    name: updated.name,
    cronExpr: updated.cronExpr,
    scope: parsePolicyScope(updated.scopeJson),
    retentionDays: updated.retentionDays,
    isActive: updated.isActive,
  };

  const correlationId = newCorrelationId("POL");
  const audit = await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "BACKUP_POLICY_UPDATED",
      resourceType: "BackupPolicy",
      resourceId: updated.id,
      resourceLabel: updated.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    },
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

  await db.backupPolicy.delete({ where: { id: policy.id } });

  const correlationId = newCorrelationId("POL");
  const audit = await db.auditEvent.create({
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

  return ok({ deleted: true, audit }, { correlationId });
}
