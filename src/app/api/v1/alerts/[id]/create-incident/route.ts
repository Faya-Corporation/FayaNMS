import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { createIncidentForAlert } from "@/lib/incidents/create";
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
      device: { select: { id: true, hostname: true, siteId: true } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
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

  const result = await createIncidentForAlert({
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
