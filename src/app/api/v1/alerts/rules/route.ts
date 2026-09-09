import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { ALERT_RULE_METRICS, ALERT_RULE_OPERATORS } from "@/lib/alerts/evaluate";
import { parsePolicyScope } from "../../_lib/scope";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /api/v1/alerts/rules — alert rule management (Task 5-a).
 *
 * GET: every rule with open-alert count + scoped device count (scope
 * resolved through the same helpers the evaluator uses).
 *
 * POST: create. Zod: name (unique → 409 NAME_TAKEN), metric in the allowed
 * set incl. the AVAILABILITY pseudo-metric, operator, threshold number,
 * durationMinutes 1–1440, severity token, scopeJson optional object
 * ({ siteCodes?, criticalities?, deviceRoles? } — arrays of strings).
 * Audits ALERT_RULE_CREATED (ARL-XXXXXX correlation).
 */

const scopeSchema = z
  .object({
    siteCodes: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    criticalities: z
      .array(z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]))
      .max(4)
      .optional(),
    deviceRoles: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  })
  .strict()
  .optional();

const createRuleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  metric: z.enum(ALERT_RULE_METRICS),
  operator: z.enum(ALERT_RULE_OPERATORS).default("GT"),
  threshold: z.coerce.number(),
  durationMinutes: z.coerce.number().int().min(1).max(1440).default(5),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
  scope: scopeSchema,
  isActive: z.boolean().default(true),
});

export async function GET() {
  const rules = await db.alertRule.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      metric: true,
      operator: true,
      threshold: true,
      durationMinutes: true,
      severity: true,
      scopeJson: true,
      isActive: true,
      _count: { select: { alerts: true } },
    },
  });

  // Scoped device count per rule (cheap: few rules, indexed fleet).
  const openAlerts = await db.alert.groupBy({
    by: ["ruleId"],
    _count: { _all: true },
    where: { status: { in: ["ACTIVE", "ACKNOWLEDGED", "SUPPRESSED"] } },
  });
  const openByRule = new Map(
    openAlerts.map((row) => [row.ruleId, row._count._all])
  );

  const rows = await Promise.all(
    rules.map(async (rule) => {
      const scope = parsePolicyScope(rule.scopeJson);
      const excluded = ["UNMANAGED"];
      if (rule.metric !== "AVAILABILITY") excluded.push("OFFLINE");
      const count = await db.device.count({
        where: {
          AND: [
            { status: { notIn: excluded } },
            ...(scope.criticalities
              ? [{ criticality: { in: scope.criticalities } }]
              : []),
            ...(scope.siteCodes && !scope.siteCodes.includes("*")
              ? [{ site: { code: { in: scope.siteCodes } } }]
              : []),
          ],
        },
      });
      let scopeSummary: { siteCodes?: string[]; criticalities?: string[]; deviceRoles?: string[] } = {};
      if (rule.scopeJson) {
        try {
          const parsedScope: unknown = JSON.parse(rule.scopeJson);
          if (parsedScope && typeof parsedScope === "object") {
            const obj = parsedScope as Record<string, unknown>;
            if (Array.isArray(obj.siteCodes)) scopeSummary.siteCodes = obj.siteCodes as string[];
            if (Array.isArray(obj.criticality)) scopeSummary.criticalities = obj.criticality as string[];
            if (Array.isArray(obj.criticalities)) scopeSummary.criticalities = obj.criticalities as string[];
            if (Array.isArray(obj.deviceRoles)) scopeSummary.deviceRoles = obj.deviceRoles as string[];
          }
        } catch {
          scopeSummary = {};
        }
      }
      return {
        ...rule,
        openAlerts: openByRule.get(rule.id) ?? 0,
        scopedDeviceCount: count,
        scope: scopeSummary,
      };
    })
  );

  return ok(rows);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): alert rules are system
  // administration — creating them requires "admin.system" and the audit
  // row is attributed to the session principal (hardcoded "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "admin.system");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const nameTaken = await db.alertRule.findUnique({
    where: { name: data.name },
    select: { id: true },
  });
  if (nameTaken) {
    return fail(
      "NAME_TAKEN",
      `An alert rule named "${data.name}" already exists`,
      409
    );
  }

  const created = await db.alertRule.create({
    data: {
      name: data.name,
      metric: data.metric,
      operator: data.operator,
      threshold: data.threshold,
      durationMinutes: data.durationMinutes,
      severity: data.severity,
      scopeJson: data.scope ? JSON.stringify(data.scope) : null,
      isActive: data.isActive,
    },
  });

  const correlationId = newCorrelationId("ARL");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "ALERT_RULE_CREATED",
      resourceType: "AlertRule",
      resourceId: created.id,
      resourceLabel: created.name,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        name: created.name,
        metric: created.metric,
        operator: created.operator,
        threshold: created.threshold,
        durationMinutes: created.durationMinutes,
        severity: created.severity,
        scope: data.scope ?? null,
        isActive: created.isActive,
      }),
    },
  });

  return ok({ rule: created, audit: { correlationId } }, undefined, 201);
}
