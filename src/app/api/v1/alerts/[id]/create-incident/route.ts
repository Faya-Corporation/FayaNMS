import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission, requireSiteScope } from "@/lib/auth/session";
import {
  createIncidentForAlert,
  IncidentNumberConflictError,
} from "@/lib/incidents/create";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/alerts/[id]/create-incident — manual escalation (Task 5-a).
 *
 * Dedupe: 409 ALERT_ALREADY_LINKED when the alert already references an
 * incident (the engine links auto-created ones the same way). Reuses the
 * ONE shared incident-creation module (src/lib/incidents/create.ts) —
 * severity map CRITICAL→SEV1 … INFO→SEV4, SLA due by severity, device
 * link, SYSTEM event, INCIDENT_CREATED + ALERT_ESCALATED audits with the
 * acting user as the actor.
 *
 * F-031 wave-10 (audit 13-a F-3, mutation gate): the alert's device site
 * must be inside the session's scope before any state check or mint —
 * requireSiteScope answers 403 SITE_SCOPE_FORBIDDEN (the documented
 * mutation contract; a null site follows the documented unscoped-resource
 * rule), so an escalated incident can never target an out-of-scope site.
 */
const escalateSchema = z.object({
  title: z.string().trim().min(4).max(160).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): escalating an alert requires the
  // "incident.create" permission; the actor is the session principal.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "incident.create");
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
  const parsed = escalateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const alert = await db.alert.findUnique({
    where: { id },
    select: {
      id: true,
      severity: true,
      message: true,
      status: true,
      incidentId: true,
      device: {
        select: {
          id: true,
          hostname: true,
          siteId: true,
          site: { select: { code: true } },
        },
      },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  // F-031 wave-10: the scope gate runs BEFORE the state checks and the
  // mint (403-not-404 — mutations accept existence confirmation).
  try {
    await requireSiteScope(request, alert.device.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  if (alert.incidentId) {
    return fail(
      "ALERT_ALREADY_LINKED",
      "This alert is already linked to an incident",
      409
    );
  }
  if (alert.status === "RESOLVED") {
    return fail(
      "INVALID_STATE",
      "Resolved alerts cannot be escalated — reopen the underlying condition instead",
      409
    );
  }

  let result;
  try {
    result = await createIncidentForAlert({
      alert: {
        id: alert.id,
        severity: alert.severity,
        message: alert.message,
        deviceId: alert.device.id,
      },
      device: {
        id: alert.device.id,
        hostname: alert.device.hostname,
        siteId: alert.device.siteId,
      },
      source: "MANUAL",
      actorName: actor.name ?? "Unknown user",
      actorId: actor.id,
      title: parsed.data.title,
    });
  } catch (error) {
    // RT-014 — both number-retry attempts lost the @@unique race: answer a
    // typed retryable 409 instead of surfacing a raw Prisma error (the tx
    // rolled back atomically, so the alert is still unlinkable/escalatable).
    if (error instanceof IncidentNumberConflictError) {
      return fail(
        "INCIDENT_NUMBER_CONFLICT",
        "Concurrent incident creation exhausted the number retry — retry the request",
        409
      );
    }
    throw error;
  }

  if (!result.created || !result.incident) {
    return fail(
      "ALERT_ALREADY_LINKED",
      "This alert was just linked to an incident by another actor",
      409
    );
  }

  return ok(
    {
      incident: result.incident,
      message: `Incident ${result.incident.number} created from alert and linked.`,
    },
    undefined,
    201
  );
}
