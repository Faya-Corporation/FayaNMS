import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import { computeSlaState } from "@/lib/incidents/lifecycle";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents/[id] — full incident detail (Task 5-b).
 *
 * Returns the header (severity/status/source/owner/ack-user), the SLA state
 * (dueIn ms + breached + outcome once resolved), devices, the chronological
 * IncidentEvent timeline (SYSTEM | USER | INTEGRATION with actor names), the
 * linked alerts, and the linked change header. Dates leave as ISO strings;
 * the UI consumes this shape directly for the detail view.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid incident id", 400);
  }

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

  if (!incident) {
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
