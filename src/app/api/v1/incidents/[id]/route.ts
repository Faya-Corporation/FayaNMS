import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import { computeSlaState } from "@/lib/incidents/lifecycle";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents/[id] — full incident detail (Task 5-b).
 *
 * Returns the header (severity/status/source/owner/ack-user), the SLA state
 * (dueIn ms + breached + outcome once resolved), devices, the chronological
 * IncidentEvent timeline (SYSTEM | USER | INTEGRATION with actor names), the
 * linked alerts, and the linked change header. Dates leave as ISO strings;
 * the UI consumes this shape directly for the detail view.
 *
 * F-031 wave-10 (audit 13-a F-2, read-plane migration): the row-level
 * predicate `sessionAllowsSite(claims, incident.site?.code ?? null)` fuses
 * into the not-found branch — an incident whose site is outside the
 * session's scope answers the SAME INCIDENT_NOT_FOUND envelope a wildcard
 * session gets for a missing row (404-not-403: a 403 would confirm
 * existence; a site-less incident is hidden too — row-level fail-closed
 * parity with the list route's site-relation filter). Wildcard sessions
 * keep the byte-identical behavior.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // F-008 phase 4a (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid incident id", 400);
  }

  // F-031 wave-10: the session's site scope for the row predicate
  // (wildcard sessions — absent claims — keep byte-identical behavior).
  const scopeClaims = await sessionScopeFor(request);

  const incident = await db.incident.findUnique({
    where: { id },
    include: {
      site: { select: { id: true, name: true, code: true } },
      owner: { select: { id: true, name: true, email: true } },
      change: {
        select: { id: true, number: true, title: true, status: true, riskLevel: true },
      },
      devices: {
        select: {
          id: true,
          deviceId: true,
          createdAt: true,
          device: {
            select: {
              id: true,
              hostname: true,
              status: true,
              mgmtIp: true,
              model: true,
              site: { select: { name: true, code: true } },
            },
          },
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          message: true,
          createdAt: true,
          actor: { select: { id: true, name: true, email: true } },
        },
      },
      alerts: {
        orderBy: { lastSeen: "desc" },
        select: {
          id: true,
          severity: true,
          message: true,
          status: true,
          count: true,
          firstSeen: true,
          lastSeen: true,
          device: { select: { id: true, hostname: true } },
        },
      },
    },
  });

  // Fused-404: out-of-scope site → the same not-found envelope as a missing
  // row (no existence oracle for sites-limited sessions).
  if (!incident || !sessionAllowsSite(scopeClaims, incident.site?.code ?? null)) {
    return fail("INCIDENT_NOT_FOUND", "Incident not found", 404);
  }

  const sla = computeSlaState({
    severity: incident.severity,
    status: incident.status,
    createdAt: incident.createdAt,
    slaDueAt: incident.slaDueAt,
    resolvedAt: incident.resolvedAt,
  });

  return ok({
    ...incident,
    sla,
  });
}
