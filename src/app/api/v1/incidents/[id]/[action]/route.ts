import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import {
  INCIDENT_TRANSITIONS,
  isTransitionAllowed,
} from "@/lib/incidents/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/incidents/[id]/[action] — incident lifecycle actions (Task 5-b).
 *
 * One handler serves every lifecycle action (the action is validated against
 * the shared transition table in src/lib/incidents/lifecycle.ts):
 *
 *   acknowledge        NEW → ACKNOWLEDGED; sets acknowledgedAt first time
 *                      only — re-acknowledging is idempotent-ok (200, no
 *                      duplicate event), not a 409.
 *   assign             NEW | ACKNOWLEDGED | ASSIGNED → ASSIGNED; body needs
 *                      ownerId (validated user) and/or ownerTeam.
 *   investigate        any open status → INVESTIGATING   { note? }
 *   mitigate           any open status → MITIGATING      { note? }
 *   monitor            any open status → MONITORING      { note? }
 *   resolve            any open status → RESOLVED; sets resolvedAt; 409 when
 *                      already RESOLVED/CLOSED/POST_INCIDENT_REVIEW. The
 *                      note lands on the timeline and is appended to the
 *                      description for the PIR export.
 *   review             RESOLVED → POST_INCIDENT_REVIEW (opens the PIR flow)
 *   close              RESOLVED | POST_INCIDENT_REVIEW → CLOSED; sets
 *                      closedAt; already-CLOSED is idempotent-ok (200).
 *   save-pir           writes rootCause/correctiveAction/preventiveAction
 *                      (all three required); allowed in RESOLVED |
 *                      POST_INCIDENT_REVIEW | CLOSED; audits
 *                      INCIDENT_PIR_SAVED.
 *   link-change        { changeId } — validates the change exists, links it.
 *   unlink-change      clears the change link (409 when none is linked).
 *
 * Every action resolves the acting user from the session principal (never a
 * seeded default; P19 fallback), writes a USER IncidentEvent with actor
 * attribution and an audit row (INCIDENT_<ACTION>), all in one short
 * interactive transaction. Authorization (Phase 19-C, audit AUTHZ-001
 * sweep): every action requires "incident.write" EXCEPT "close", which
 * requires "incident.close". 409 INVALID_STATE on illegal transitions;
 * 404 INCIDENT_NOT_FOUND.
 */

const ID_MAX = 64;

const bodySchema = z.object({
  note: z.string().trim().max(2000).optional(),
  resolutionNote: z.string().trim().max(2000).optional(),
  ownerId: z.string().trim().max(64).optional(),
  ownerTeam: z.string().trim().max(80).optional(),
  changeId: z.string().trim().max(64).optional(),
  rootCause: z.string().trim().min(3, "Root cause is required").max(4000).optional(),
  correctiveAction: z
    .string()
    .trim()
    .min(3, "Corrective action is required")
    .max(4000)
    .optional(),
  preventiveAction: z
    .string()
    .trim()
    .min(3, "Preventive action is required")
    .max(4000)
    .optional(),
});

const SAVE_PIR_ACTIONS = new Set(["save-pir"]);
const LINK_ACTIONS = new Set(["link-change", "unlink-change"]);

function summary(incident: {
  id: string;
  number: string;
  title: string;
  status: string;
  severity: string;
  ownerId: string | null;
  ownerTeam: string | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  changeId: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
}) {
  return {
    id: incident.id,
    number: incident.number,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    ownerId: incident.ownerId,
    ownerTeam: incident.ownerTeam,
    acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    closedAt: incident.closedAt?.toISOString() ?? null,
    changeId: incident.changeId,
    pir: {
      rootCause: incident.rootCause,
      correctiveAction: incident.correctiveAction,
      preventiveAction: incident.preventiveAction,
    },
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid incident id", 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): lifecycle actions require
  // "incident.write"; closing an incident is its own permission
  // ("incident.close"). The actor is the session principal.
  const permission = action === "close" ? "incident.close" : "incident.write";
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, permission);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const input = parsed.data;

  const transition = INCIDENT_TRANSITIONS[action];
  if (!transition && !SAVE_PIR_ACTIONS.has(action) && !LINK_ACTIONS.has(action)) {
    return fail("UNKNOWN_ACTION", `Unknown incident action "${action}"`, 404);
  }

  const correlationId = newCorrelationId("INC");

  // save-pir / link-change need their required fields up front.
  if (action === "save-pir") {
    const missing = (["rootCause", "correctiveAction", "preventiveAction"] as const).filter(
      (field) => !input[field]
    );
    if (missing.length > 0) {
      return fail(
        "INVALID_BODY",
        `Missing PIR field(s): ${missing.join(", ")}`,
        400
      );
    }
  }
  if (action === "link-change" && !input.changeId) {
    return fail("INVALID_BODY", "changeId is required to link a change", 400);
  }
  if (action === "assign" && !input.ownerId && !input.ownerTeam) {
    return fail(
      "INVALID_BODY",
      "Provide ownerId (a user) and/or ownerTeam to assign this incident",
      400
    );
  }

  try {
    const result = await db.$transaction(
      async (tx) => {
        const incidentRow = await tx.incident.findUnique({
          where: { id },
          select: {
            id: true,
            number: true,
            title: true,
            description: true,
            severity: true,
            status: true,
            ownerId: true,
            ownerTeam: true,
            acknowledgedAt: true,
            resolvedAt: true,
            closedAt: true,
            changeId: true,
            rootCause: true,
            correctiveAction: true,
            preventiveAction: true,
          },
        });
        if (!incidentRow) return { notFound: true as const };

        const actorId = actor.id;
        const actorName = actor.name ?? "Unknown user";
        const note = input.note ?? input.resolutionNote;

        // ── save-pir ────────────────────────────────────────────────────
        if (action === "save-pir") {
          if (
            !["RESOLVED", "POST_INCIDENT_REVIEW", "CLOSED"].includes(
              incidentRow.status
            )
          ) {
            return { conflict: "PIR fields can be saved once the incident is RESOLVED" };
          }
          const updated = await tx.incident.update({
            where: { id: incidentRow.id },
            data: {
              rootCause: input.rootCause,
              correctiveAction: input.correctiveAction,
              preventiveAction: input.preventiveAction,
            },
          });
          await tx.incidentEvent.create({
            data: {
              incidentId: incidentRow.id,
              kind: "USER",
              message: `Post-incident review saved by ${actorName} (root cause, corrective and preventive actions).`,
              actorId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actorId,
              actorName,
              action: "INCIDENT_PIR_SAVED",
              resourceType: "Incident",
              resourceId: incidentRow.id,
              resourceLabel: `${incidentRow.number} — ${incidentRow.title.slice(0, 60)}`,
              result: "SUCCESS",
              correlationId,
              afterJson: JSON.stringify({
                status: incidentRow.status,
                rootCauseLength: input.rootCause?.length ?? 0,
                correctiveActionLength: input.correctiveAction?.length ?? 0,
                preventiveActionLength: input.preventiveAction?.length ?? 0,
              }),
            },
          });
          return { incident: summary(updated) };
        }

        // ── link-change / unlink-change ─────────────────────────────────
        if (action === "link-change") {
          const change = await tx.changeRequest.findUnique({
            where: { id: input.changeId },
            select: { id: true, number: true, status: true },
          });
          if (!change) return { notFoundChange: true as const };
          if (incidentRow.changeId === change.id) {
            return {
              incident: summary(incidentRow),
              alreadyLinked: true as const,
              changeNumber: change.number,
            };
          }
          const updated = await tx.incident.update({
            where: { id: incidentRow.id },
            data: { changeId: change.id },
          });
          await tx.incidentEvent.create({
            data: {
              incidentId: incidentRow.id,
              kind: "USER",
              message: `Linked to change ${change.number} by ${actorName}.`,
              actorId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actorId,
              actorName,
              action: "INCIDENT_CHANGE_LINKED",
              resourceType: "Incident",
              resourceId: incidentRow.id,
              resourceLabel: `${incidentRow.number} — ${incidentRow.title.slice(0, 60)}`,
              result: "SUCCESS",
              correlationId,
              afterJson: JSON.stringify({
                changeId: change.id,
                changeNumber: change.number,
              }),
            },
          });
          return { incident: summary(updated), changeNumber: change.number };
        }

        if (action === "unlink-change") {
          if (!incidentRow.changeId) {
            return { conflict: "No change is linked to this incident" };
          }
          const change = await tx.changeRequest.findUnique({
            where: { id: incidentRow.changeId },
            select: { number: true },
          });
          const updated = await tx.incident.update({
            where: { id: incidentRow.id },
            data: { changeId: null },
          });
          await tx.incidentEvent.create({
            data: {
              incidentId: incidentRow.id,
              kind: "USER",
              message: `Unlinked change ${change?.number ?? incidentRow.changeId} by ${actorName}.`,
              actorId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actorId,
              actorName,
              action: "INCIDENT_CHANGE_UNLINKED",
              resourceType: "Incident",
              resourceId: incidentRow.id,
              resourceLabel: `${incidentRow.number} — ${incidentRow.title.slice(0, 60)}`,
              result: "SUCCESS",
              correlationId,
              afterJson: JSON.stringify({ changeId: incidentRow.changeId }),
            },
          });
          return { incident: summary(updated) };
        }

        // ── lifecycle transitions ───────────────────────────────────────
        const target = transition.to;

        // acknowledge: idempotent once already acknowledged.
        if (action === "acknowledge" && incidentRow.acknowledgedAt) {
          return {
            incident: summary(incidentRow),
            alreadyAcknowledged: true as const,
          };
        }
        // close: idempotent once already CLOSED.
        if (action === "close" && incidentRow.status === "CLOSED") {
          return { incident: summary(incidentRow), alreadyClosed: true as const };
        }
        // assign: nothing to do when the exact same owner/team is re-sent
        // and the incident is already ASSIGNED.
        if (
          action === "assign" &&
          incidentRow.status === "ASSIGNED" &&
          (input.ownerId ?? null) === incidentRow.ownerId &&
          (input.ownerTeam ?? null) === incidentRow.ownerTeam
        ) {
          return { incident: summary(incidentRow), alreadyAssigned: true as const };
        }

        if (!isTransitionAllowed(action, incidentRow.status)) {
          return {
            conflict: `"${action}" is not allowed from status ${incidentRow.status} (requires one of: ${transition.from.join(", ")})`,
          };
        }

        const data: Record<string, unknown> = { status: target };
        if (action === "acknowledge" && !incidentRow.acknowledgedAt) {
          data.acknowledgedAt = new Date();
        }
        if (action === "assign") {
          if (input.ownerId !== undefined) data.ownerId = input.ownerId || null;
          if (input.ownerTeam !== undefined) data.ownerTeam = input.ownerTeam || null;
        }
        if (action === "resolve") {
          data.resolvedAt = new Date();
        }
        if (action === "close") {
          data.closedAt = new Date();
        }

        if (input.ownerId) {
          const owner = await tx.user.findFirst({
            where: { id: input.ownerId, isActive: true },
            select: { id: true, name: true },
          });
          if (!owner) return { badOwner: true as const };
        }

        // Guarded update: status must still be what we validated against.
        const updated = await tx.incident.updateMany({
          where: { id: incidentRow.id, status: incidentRow.status },
          data,
        });
        if (updated.count !== 1) {
          return { conflict: "Incident changed concurrently — retry" };
        }

        // resolve: append the resolution note to the description (PIR export).
        if (action === "resolve" && note) {
          await tx.incident.update({
            where: { id: incidentRow.id },
            data: {
              description: `${incidentRow.description ?? ""}\n\nResolution: ${note}`.trim(),
            },
          });
        }

        const eventMessages: Record<string, string> = {
          acknowledge: `Acknowledged by ${actorName}.`,
          assign: `Assigned to ${input.ownerId ? "a user" : "a team"}${
            input.ownerTeam ? ` (${input.ownerTeam})` : ""
          } by ${actorName}.`,
          investigate: `Investigation started by ${actorName}.`,
          mitigate: `Mitigation started by ${actorName}.`,
          monitor: `Monitoring started by ${actorName}.`,
          resolve: `Resolved by ${actorName}.`,
          review: `Post-incident review opened by ${actorName}.`,
          close: `Closed by ${actorName}.`,
        };
        const eventMessage =
          eventMessages[action] ?? `${action} by ${actorName}.`;

        await tx.incidentEvent.create({
          data: {
            incidentId: incidentRow.id,
            kind: "USER",
            message: note ? `${eventMessage} ${note}` : eventMessage,
            actorId,
          },
        });

        await tx.auditEvent.create({
          data: {
            actorId,
            actorName,
            action: transition.audit,
            resourceType: "Incident",
            resourceId: incidentRow.id,
            resourceLabel: `${incidentRow.number} — ${incidentRow.title.slice(0, 60)}`,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: incidentRow.status }),
            afterJson: JSON.stringify({ status: target, note: note ?? null }),
          },
        });

        const merged = { ...incidentRow, ...data } as unknown as Parameters<
          typeof summary
        >[0];
        return { incident: summary(merged) };
      },
      { maxWait: 5_000, timeout: 20_000 }
    );

    if ("notFound" in result && result.notFound) {
      return fail("INCIDENT_NOT_FOUND", "Incident not found", 404);
    }
    if ("notFoundChange" in result && result.notFoundChange) {
      return fail("CHANGE_NOT_FOUND", "The referenced change does not exist", 404);
    }
    if ("badOwner" in result && result.badOwner) {
      return fail("OWNER_NOT_FOUND", "The referenced owner user does not exist", 404);
    }
    if ("conflict" in result && result.conflict) {
      return fail("INVALID_STATE", result.conflict, 409);
    }
    return ok(result);
  } catch (error) {
    console.error("[incidents/action] failed", action, error);
    return fail("ACTION_FAILED", "The incident action could not be applied", 500);
  }
}
