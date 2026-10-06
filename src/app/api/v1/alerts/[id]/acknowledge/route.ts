import { db } from "@/lib/db";
import { auditAttribution } from "@/lib/auth/api-client-auth";
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
 * POST /api/v1/alerts/[id]/acknowledge — ACTIVE → ACKNOWLEDGED (Task 5-a).
 * 404 ALERT_NOT_FOUND; 409 INVALID_STATE for any other source status.
 * Stamps acknowledgedBy/At (the session principal) and audits
 * ALERT_ACKNOWLEDGED. Requires the "alert.ack" permission (Phase 19-C,
 * audit AUTHZ-001 sweep — was authentication-only via resolveActingUser).
 *
 * P1-012: this route is the CERTIFIED API-client opt-in (allowApiClients).
 * A client principal's id is NOT a User row, so acknowledgedById (a User
 * FK, nullable) stays NULL for client acknowledgements — the
 * ALERT_ACKNOWLEDGED audit row carries the client attribution (actorId =
 * the ApiClient row id) as the accountability record.
 *
 * F-031 wave-10 (audit 13-a F-3, mutation gate): the alert's device site
 * must be inside the session's scope before any state check or mutation —
 * requireSiteScope answers 403 SITE_SCOPE_FORBIDDEN (the documented
 * mutation contract; a null site follows the documented unscoped-resource
 * rule). The API-client bearer plane is UNSCOPED by documented posture
 * (authorization-matrix §5.1 "Plane boundaries"), so the P1-012 opt-in
 * skips the session-scope gate deliberately.
 */
const ackSchema = z.object({
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): acknowledging requires the
  // "alert.ack" permission; the actor is the session principal — or, since
  // P1-012, an authenticated API client with an "alerts.write" scope (the
  // certified opt-in; acknowledgedById stays null, the audit row
  // attributes to the client row).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "alert.ack", { allowApiClients: true });
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
      device: { select: { id: true, hostname: true, site: { select: { code: true } } } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  // F-031 wave-10: the scope gate runs BEFORE the state check and the
  // mutation (403-not-404 — mutations accept existence confirmation).
  // P1-A05 (GA re-audit 2026-10-06): the previous api-client bypass is
  // REMOVED — API clients now carry a RESOURCE scope (ApiClient.siteScopeJson
  // resolved through sessionScopeFor), so the gate enforces it exactly as it
  // does for human sessions. A wildcard-scope client passes unchanged.
  try {
    await requireSiteScope(request, alert.device.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  if (alert.status !== "ACTIVE") {
    return fail(
      "INVALID_STATE",
      `Only ACTIVE alerts can be acknowledged — this alert is ${alert.status}`,
      409
    );
  }

  const now = new Date();
  // P1-012: a client principal is not a User row — the nullable FK stays
  // null and the audit trail is the accountability record.
  const acknowledgedById = actor.role === "api-client" ? null : actor.id;

  const updated = await db.alert.update({
    where: { id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedById,
      acknowledgedAt: now,
    },
  });

  const correlationId = newCorrelationId("ALR");
  // P1-012: client principals attribute as actorId=null + "api-client: <name>"
  // + viaApiClientId in the payload (AuditEvent.actorId is a User FK).
  const attribution = auditAttribution(actor);
  await db.auditEvent.create({
    data: {
      actorId: attribution.actorId,
      actorName: attribution.actorName,
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
        viaApiClientId: attribution.viaApiClientId,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
