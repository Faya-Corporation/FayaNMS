import { db } from "@/lib/db";
import { ok } from "../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import {
  COLLECTOR_HEARTBEAT_INTERVAL_S,
  COLLECTOR_LEASE_TTL_MS,
  COLLECTOR_ROW_STALE_GRACE_MS,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /api/v1/admin/collectors/agents — REAL collector control plane (GA-4b).
 * The REGISTERED agent fleet (unlike the worker-observed `Collector`
 * registry rows): liveness (lastHeartbeatAt vs the lease TTL), lifecycle
 * status and current ownership counts. Human admin plane.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  let actor: Awaited<ReturnType<typeof requireRole>>;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const agents = await db.collectorAgent.findMany({
    orderBy: { agentKey: "asc" },
    include: {
      site: { select: { code: true, name: true, region: true } },
      _count: { select: { assignments: true } },
    },
  });

  const now = Date.now();
  return ok(
    {
      agents: agents.map((agent) => ({
        agentKey: agent.agentKey,
        displayName: agent.displayName,
        role: agent.role,
        version: agent.version,
        capacity: agent.capacity,
        status: agent.status,
        siteCode: agent.site?.code ?? null,
        siteName: agent.site?.name ?? null,
        region: agent.region,
        lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
        heartbeatAgeS:
          agent.lastHeartbeatAt !== null
            ? Math.max(0, Math.round((now - agent.lastHeartbeatAt.getTime()) / 1000))
            : null,
        // Honest liveness verdict: fresh = inside the lease TTL. A silent
        // ACTIVE agent is reaper-eligible; SUSPENDED never owns anything.
        liveness:
          agent.status !== "ACTIVE"
            ? agent.status.toLowerCase()
            : agent.lastHeartbeatAt !== null &&
                now - agent.lastHeartbeatAt.getTime() < COLLECTOR_LEASE_TTL_MS
              ? "fresh"
              : "silent",
        ownedAssignments: agent._count.assignments,
        registeredAt: agent.registeredAt.toISOString(),
        registeredBy: agent.registeredBy,
      })),
      contract: {
        heartbeatIntervalS: COLLECTOR_HEARTBEAT_INTERVAL_S,
        leaseTtlMs: COLLECTOR_LEASE_TTL_MS,
        rowStaleGraceMs: COLLECTOR_ROW_STALE_GRACE_MS,
      },
    },
    { actor: actor.name ?? actor.email, plane: "real" },
    200
  );
}
