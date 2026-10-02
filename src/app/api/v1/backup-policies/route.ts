import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../_lib/api";
import { parsePolicyScope, scopeDeviceWhere } from "../_lib/scope";
import { isValidCronExpr } from "@/lib/cron";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/backup-policies — policy list with per-policy computed stats
 *      (scoped device count, lastEnqueuedAt of the most recent policy-tagged
 *      CONFIG_BACKUP job). The worker tick reads these rows every 30 s, so
 *      created/edited policies become live schedules immediately.
 * POST /api/v1/backup-policies — create a policy (audited, BACKUP_POLICY_CREATED).
 *
 * scopeJson canonical keys: siteCodes (site codes, "*" = all),
 * criticalities (LOW|MEDIUM|HIGH|CRITICAL), statuses (include filter:
 * ONLINE|DEGRADED|MAINTENANCE|UNKNOWN — OFFLINE/UNMANAGED are never
 * scheduled). An empty scope object means fleet-wide.
 */

const CRITICALITY_VALUES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
// UNMANAGED/OFFLINE are always excluded by the scheduler, so the include
// filter only accepts statuses a scheduled backup can actually target.
const STATUS_VALUES = [
  "ONLINE",
  "DEGRADED",
  "MAINTENANCE",
  "UNKNOWN",
] as const;

const scopeSchema = z.object({
  siteCodes: z
    .array(z.string().trim().min(1).max(64))
    .max(64)
    .optional(),
  criticalities: z
    .array(z.enum(CRITICALITY_VALUES))
    .optional(),
  statuses: z
    .array(z.enum(STATUS_VALUES))
    .optional(),
});

const policySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  cronExpr: z
    .string()
    .trim()
    .min(1, "cronExpr is required")
    .max(120)
    .refine(isValidCronExpr, {
      message:
        "cronExpr must be a 5-field numeric cron (minute hour day-of-month month day-of-week), e.g. 0 2 * * *",
    }),
  scope: scopeSchema.optional(),
  retentionDays: z.coerce.number().int().min(1).max(3650).default(90),
  isActive: z.boolean().default(true),
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
  const policies = await db.backupPolicy.findMany({
    orderBy: { name: "asc" },
  });

  const rows = await Promise.all(
    policies.map(async (policy) => {
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
    })
  );

  return ok(rows, { policies: rows.length });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = policySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): creating backup policies requires
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

  const existing = await db.backupPolicy.findUnique({
    where: { name: data.name },
    select: { id: true },
  });
  if (existing) {
    return fail(
      "NAME_TAKEN",
      `A backup policy named "${data.name}" already exists`,
      409
    );
  }

  const correlationId = newCorrelationId("POL");

  try {
    const policy = await db.backupPolicy.create({
      data: {
        name: data.name,
        cronExpr: data.cronExpr,
        scopeJson: serializeScope(data.scope ?? {}),
        retentionDays: data.retentionDays,
        isActive: data.isActive,
      },
    });

    const audit = await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "BACKUP_POLICY_CREATED",
        resourceType: "BackupPolicy",
        resourceId: policy.id,
        resourceLabel: policy.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          name: policy.name,
          cronExpr: policy.cronExpr,
          scope: data.scope ?? {},
          retentionDays: policy.retentionDays,
          isActive: policy.isActive,
        }),
      },
    });

    return ok({ policy, audit }, { correlationId }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Unique constraint")) {
      return fail(
        "NAME_TAKEN",
        `A backup policy named "${data.name}" already exists`,
        409
      );
    }
    return fail("CREATE_FAILED", "The backup policy could not be created", 500);
  }
}
