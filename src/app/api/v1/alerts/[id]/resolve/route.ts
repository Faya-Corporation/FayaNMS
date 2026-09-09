import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/alerts/[id]/resolve — open statuses → RESOLVED (Task 5-a).
 * Works from ACTIVE | ACKNOWLEDGED | SUPPRESSED; audits ALERT_RESOLVED.
 * (Auto-resolution by the engine uses the same action name — the audit
 * actor distinguishes system:alert-engine from a human.)
 * Requires the "alert.ack" permission (Phase 19-C, audit AUTHZ-001 sweep
 * — was authentication-only via resolveActingUser).
 */
const resolveSchema = z.object({
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): resolving requires the
  // "alert.ack" permission; the actor is the session principal.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "alert.ack");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = resolveSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const alert = await db.alert.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      severity: true,
      message: true,
      device: { select: { id: true, hostname: true } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  if (alert.status === "RESOLVED") {
    return fail("INVALID_STATE", "This alert is already resolved", 409);
  }

  const previousStatus = alert.status;

  const updated = await db.alert.update({
    where: { id },
    data: { status: "RESOLVED", suppressReason: null },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "ALERT_RESOLVED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "RESOLVED",
        previousStatus,
        severity: alert.severity,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
