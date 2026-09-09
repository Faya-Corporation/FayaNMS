import { db } from "@/lib/db";
import { ok, requestContext } from "../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";
import {
  assignDevices,
  COLLECTOR_AGENTS,
  composeAgentLoads,
  planRebalance,
  planFingerprint,
  type DeviceAssignmentRow,
} from "@/lib/collectors/distribution";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /api/v1/admin/collectors/distribution — collector agent distribution
 * (Phase 15-b). Deterministic device→agent assignment over REAL device rows
 * + per-agent load/band/score + per-site coverage + rebalance preview.
 *
 * The agent fleet itself is a DOCUMENTED SIMULATION
 * (src/lib/collectors/distribution.ts — same pattern as src/lib/ha);
 * everything derived here is pure, so identical db state produces identical
 * numbers (no polling flicker).
 * ───────────────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);

    const devices = await db.device.findMany({
      select: { id: true, hostname: true, status: true, site: { select: { code: true } } },
      orderBy: { hostname: "asc" },
    });

    const rows: DeviceAssignmentRow[] = devices.map((device) => ({
      id: device.id,
      hostname: device.hostname,
      siteCode: device.site?.code ?? null,
      status: device.status,
    }));

    const assignments = assignDevices(rows);
    const loads = composeAgentLoads(assignments);

    const agents = COLLECTOR_AGENTS.map((agent) => {
      const load = loads.find((entry) => entry.agentId === agent.agentId);
      return {
        ...agent,
        assignedCount: load?.assignedCount ?? 0,
        onlineCount: load?.onlineCount ?? 0,
        load: load?.load ?? 0,
        band: load?.band ?? "normal",
        score: load?.score ?? 100,
      };
    });

    // Per-site coverage matrix over real sites present in the db.
    const siteCodes = [...new Set(rows.map((row) => row.siteCode).filter((code): code is string => Boolean(code)))].sort();
    const sites = siteCodes.map((code) => {
      const siteDevices = rows.filter((row) => row.siteCode === code);
      const siteAgents = COLLECTOR_AGENTS.filter((agent) => agent.siteCode === code);
      const siteAssignments = assignments.filter((a) => a.siteCode === code);
      const localAssigned = siteAssignments.filter((a) =>
        siteAgents.some((agent) => agent.agentId === a.agentId)
      ).length;
      return {
        siteCode: code,
        devices: siteDevices.length,
        online: siteDevices.filter((row) => row.status === "ONLINE").length,
        agents: siteAgents.map((agent) => agent.agentId),
        agentCount: siteAgents.length,
        coveredLocally: localAssigned,
        remoteAssigned: siteAssignments.length - localAssigned,
        coveragePct:
          siteAssignments.length > 0
            ? Math.round((localAssigned / siteAssignments.length) * 100)
            : 100,
      };
    });

    const moves = planRebalance(assignments);
    const totalAssigned = assignments.length;
    const avgLoad =
      totalAssigned > 0
        ? Math.round(
            (loads.reduce((sum, load) => sum + load.load, 0) / loads.length) * 100
          ) / 100
        : 0;
    const maxAgent = agents.reduce((worst, agent) =>
      agent.load > worst.load ? agent : worst
    , agents[0]);

    return ok(
      {
        fleet: agents,
        sites,
        summary: {
          agents: agents.length,
          devicesAssigned: totalAssigned,
          avgLoad,
          maxLoadAgent: { agentId: maxAgent.agentId, name: maxAgent.name, load: maxAgent.load },
          overCapacityAgents: agents.filter((a) => a.band === "over-capacity").length,
          uncoveredDevices: assignments.filter((a) => a.via !== "site-resident").length,
        },
        rebalancePreview: {
          moves,
          planId: planFingerprint(moves),
        },
      },
      {
        simulated: true,
        note: "Agent fleet is a documented simulation — assignments are deterministic over real devices",
      },
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
