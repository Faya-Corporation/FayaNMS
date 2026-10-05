import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { authErrorToFail, requirePermission, requireSiteScope } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/alerts/[id]/unsuppress — SUPPRESSED → ACTIVE (Task 5-a).
 * Clears suppressReason (parentAlertId is kept for grouping context).
 * Audits ALERT_UNSUPPRESSED.
 *
 * F-031 wave-10 (audit 13-a F-3, mutation gate): the alert's device site
 * must be inside the session's scope before any state check or mutation —
 * requireSiteScope answers 403 SITE_SCOPE_FORBIDDEN (the documented
 * mutation contract; a null site follows the documented unscoped-resource
 * rule).
 */
const unsuppressSchema = z.object({
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): unsuppressing requires the
  // "alert.suppress" permission; the actor is the session principal.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "alert.suppress");
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
  const parsed = unsuppressSchema.safeParse(body ?? {});
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
      suppressReason: true,
      device: { select: { id: true, hostname: true, site: { select: { code: true } } } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  // F-031 wave-10: the scope gate runs BEFORE the state check and the
  // mutation (403-not-404 — mutations accept existence confirmation).
  try {
    await requireSiteScope(request, alert.device.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  if (alert.status !== "SUPPRESSED") {
    return fail(
      "INVALID_STATE",
      `Only SUPPRESSED alerts can be unsuppressed — this alert is ${alert.status}`,
      409
    );
  }

  const updated = await db.alert.update({
    where: { id },
    data: { status: "ACTIVE", suppressReason: null },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "ALERT_UNSUPPRESSED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "ACTIVE",
        previousReason: alert.suppressReason,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
