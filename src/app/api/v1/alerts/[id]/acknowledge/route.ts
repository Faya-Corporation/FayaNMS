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
 * POST /api/v1/alerts/[id]/acknowledge — ACTIVE → ACKNOWLEDGED (Task 5-a).
 * 404 ALERT_NOT_FOUND; 409 INVALID_STATE for any other source status.
 * Stamps acknowledgedBy/At (the session principal) and audits
 * ALERT_ACKNOWLEDGED. Requires the "alert.ack" permission (Phase 19-C,
 * audit AUTHZ-001 sweep — was authentication-only via resolveActingUser).
 */
const ackSchema = z.object({
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): acknowledging requires the
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
  const parsed = ackSchema.safeParse(body ?? {});
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
  if (alert.status !== "ACTIVE") {
    return fail(
      "INVALID_STATE",
      `Only ACTIVE alerts can be acknowledged — this alert is ${alert.status}`,
      409
    );
  }

  const now = new Date();

  const updated = await db.alert.update({
    where: { id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedById: actor.id,
      acknowledgedAt: now,
    },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "ALERT_ACKNOWLEDGED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "ACKNOWLEDGED",
        severity: alert.severity,
        message: alert.message,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
