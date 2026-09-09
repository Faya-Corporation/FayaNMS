import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { ALERT_RULE_METRICS, ALERT_RULE_OPERATORS } from "@/lib/alerts/evaluate";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /api/v1/alerts/rules/[id] — update or delete an alert rule (Task 5-a).
 *
 * PATCH: partial update — name (unique-checked), metric, operator,
 * threshold, durationMinutes, severity, scope (whole replace), isActive.
 * isActive=false pauses evaluation without deleting history. Audits
 * ALERT_RULE_UPDATED with before/after.
 *
 * DELETE: only when NO alert references the rule — otherwise 409
 * RULE_IN_USE with the reference count (deactivate instead, or delete the
 * alerts first). Audits ALERT_RULE_DELETED with before.
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
  .nullable()
  .optional();

const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  metric: z.enum(ALERT_RULE_METRICS).optional(),
  operator: z.enum(ALERT_RULE_OPERATORS).optional(),
  threshold: z.coerce.number().optional(),
  durationMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  scope: scopeSchema,
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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
  if (Object.keys(data).length === 0) {
    return fail("INVALID_BODY", "No updatable fields supplied", 400);
  }

  const before = await db.alertRule.findUnique({ where: { id } });
  if (!before) {
    return fail("RULE_NOT_FOUND", "Alert rule not found", 404);
  }

  if (data.name && data.name !== before.name) {
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
  }

  const after = await db.alertRule.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.metric !== undefined ? { metric: data.metric } : {}),
      ...(data.operator !== undefined ? { operator: data.operator } : {}),
      ...(data.threshold !== undefined ? { threshold: data.threshold } : {}),
      ...(data.durationMinutes !== undefined
        ? { durationMinutes: data.durationMinutes }
        : {}),
      ...(data.severity !== undefined ? { severity: data.severity } : {}),
      ...(data.scope !== undefined
        ? { scopeJson: data.scope ? JSON.stringify(data.scope) : null }
        : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });

  const correlationId = newCorrelationId("ARL");
  await db.auditEvent.create({
    data: {
      actorName: "Admin",
      action: "ALERT_RULE_UPDATED",
      resourceType: "AlertRule",
      resourceId: id,
      resourceLabel: after.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify({
        name: before.name,
        metric: before.metric,
        operator: before.operator,
        threshold: before.threshold,
        durationMinutes: before.durationMinutes,
        severity: before.severity,
        scopeJson: before.scopeJson,
        isActive: before.isActive,
      }),
      afterJson: JSON.stringify({
        name: after.name,
        metric: after.metric,
        operator: after.operator,
        threshold: after.threshold,
        durationMinutes: after.durationMinutes,
        severity: after.severity,
        scopeJson: after.scopeJson,
        isActive: after.isActive,
      }),
    },
  });

  return ok({ rule: after, audit: { correlationId } });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const before = await db.alertRule.findUnique({
    where: { id },
    include: { _count: { select: { alerts: true } } },
  });
  if (!before) {
    return fail("RULE_NOT_FOUND", "Alert rule not found", 404);
  }

  if (before._count.alerts > 0) {
    return fail(
      "RULE_IN_USE",
      `${before._count.alerts} alert(s) reference this rule — deactivate it instead of deleting`,
      409
    );
  }

  await db.alertRule.delete({ where: { id } });

  const correlationId = newCorrelationId("ARL");
  await db.auditEvent.create({
    data: {
      actorName: "Admin",
      action: "ALERT_RULE_DELETED",
      resourceType: "AlertRule",
      resourceId: id,
      resourceLabel: before.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify({
        name: before.name,
        metric: before.metric,
        operator: before.operator,
        threshold: before.threshold,
        severity: before.severity,
        isActive: before.isActive,
      }),
    },
  });

  return ok({ deleted: true, audit: { correlationId } });
}
