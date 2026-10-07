import { db } from "@/lib/db";
import { ok } from "../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";
import {
  assignDevices,
  COLLECTOR_AGENTS,
  composeAgentLoads,
  planFingerprint,
  planRebalance,
  bandForLoad,
  distributionScore,
  type DeviceAssignmentRow,
} from "@/lib/collectors/distribution";
import {
  planRealRebalance,
  type CollectorAgentRuntime,
  type RealFleetAgent,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /api/v1/admin/collectors/distribution — collector agent distribution.
 *
 * GA-4b dual-plane honesty (P0-R06/P1-O01):
 *   - REAL plane (≥1 ACTIVE registered agent): fleet = registered agents,
 *     loads = actual ownership rows (CollectorAssignment), rebalance plan =
 *     real moves over ownership. meta.plane = "real", simulated = false.
 *   - SIMULATED plane (no registered agents): the static in-code fleet over
 *     real devices — a DOCUMENTED SIMULATION
 *     (src/lib/collectors/distribution.ts — same pattern as src/lib/ha);
 *     meta.plane = "simulated", simulated = true. This stays the demo/seed
 *     posture and the CI (migrations-only) shape.
 *
 * Everything derived is pure/deterministic, so identical db state produces
 * identical numbers (no polling flicker) on BOTH planes.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);

    const devices = await db.device.findMany({
      select: {
        id: true,
        hostname: true,
        status: true,
        siteId: true,
        site: { select: { code: true, region: true } },
      },
      orderBy: { hostname: "asc" },
    });

    const realAgents = await db.collectorAgent.findMany({
      where: { status: "ACTIVE" },
      orderBy: { agentKey: "asc" },
      select: {
        id: true,
        agentKey: true,
        displayName: true,
        siteId: true,
        site: { select: { code: true } },
        region: true,
        role: true,
        version: true,
        capacity: true,
        status: true,
        lastHeartbeatAt: true,
      },
    });

    if (realAgents.length > 0) {
      return ok(await realPlanePayload(devices, realAgents), realMeta(), 200);
    }
    return ok(await simulatedPlanePayload(devices), simulatedMeta(), 200);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

/* ───────────────────────────── REAL plane ────────────────────────────────── */

type RealAgentRow = {
  id: string;
  agentKey: string;
  displayName: string;
  siteId: string | null;
  site: { code: string } | null;
  region: string | null;
  role: string;
  version: string | null;
  capacity: number;
  status: string;
  lastHeartbeatAt: Date | null;
};

type DeviceRow = {
  id: string;
  hostname: string;
  status: string;
  siteId: string | null;
  site: { code: string; region: string | null } | null;
};

async function realPlanePayload(devices: DeviceRow[], agents: RealAgentRow[]) {
  const ownership = await db.collectorAssignment.findMany({
    select: {
      deviceId: true,
      agentId: true,
      via: true,
      device: { select: { id: true, hostname: true, status: true, siteId: true } },
    },
  });

  const runtime: CollectorAgentRuntime[] = agents.map((agent) => ({
    id: agent.id,
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    siteId: agent.siteId,
    siteCode: agent.site?.code ?? null,
    region: agent.region,
    role: agent.role,
    version: agent.version,
    capacity: agent.capacity,
    status: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt,
  }));

  const ownedByAgent = new Map<string, { deviceId: string; hostname: string; online: boolean }[]>();
  for (const row of ownership) {
    const bucket = ownedByAgent.get(row.agentId) ?? [];
    bucket.push({
      deviceId: row.deviceId,
      hostname: row.device.hostname,
      online: row.device.status === "ONLINE",
    });
    ownedByAgent.set(row.agentId, bucket);
  }

  const fleetInput: RealFleetAgent[] = runtime.map((agent) => ({
    agent,
    owned: ownedByAgent.get(agent.id) ?? [],
  }));

  // Deterministic failover peer per agent (same region → same site → any;
  // most capacity, then agentKey asc) — computed once, no N+1 queries.
  const peers = new Map<string, string | null>();
  for (const agent of runtime) {
    const candidates = runtime
      .filter((other) => other.id !== agent.id)
      .sort((a, b) => b.capacity - a.capacity || a.agentKey.localeCompare(b.agentKey));
    const sameRegion = candidates.find((c) => c.region && c.region === agent.region);
    const sameSite = candidates.find((c) => c.siteId && c.siteId === agent.siteId);
    peers.set(agent.agentKey, (sameRegion ?? sameSite ?? candidates[0])?.agentKey ?? null);
  }

  const fleet = runtime.map((agent) => {
    const owned = ownedByAgent.get(agent.id) ?? [];
    const load = agent.capacity > 0 ? Math.round((owned.length / agent.capacity) * 100) / 100 : 1;
    const onlineRatio = owned.length > 0 ? owned.filter((d) => d.online).length / owned.length : 0;
    return {
      agentId: agent.agentKey,
      name: agent.displayName,
      siteCode: agent.siteCode,
      region: agent.region,
      role: agent.role,
      version: agent.version,
      capacity: agent.capacity,
      peerAgentId: peers.get(agent.agentKey) ?? null,
      assignedCount: owned.length,
      onlineCount: owned.filter((d) => d.online).length,
      load,
      band: bandForLoad(load),
      score: distributionScore(load, onlineRatio),
      status: agent.status,
      lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
    };
  });

  // Per-site coverage over the REAL ownership rows.
  const siteCodes = [
    ...new Set(devices.map((d) => d.site?.code).filter((code): code is string => Boolean(code))),
  ].sort();
  const agentBySite = new Map<string, string[]>();
  for (const agent of runtime) {
    if (!agent.siteCode) continue;
    agentBySite.set(agent.siteCode, [...(agentBySite.get(agent.siteCode) ?? []), agent.agentKey]);
  }
  const deviceIdToAgent = new Map(ownership.map((row) => [row.deviceId, row]));
  const sites = siteCodes.map((code) => {
    const siteDevices = devices.filter((d) => d.site?.code === code);
    const localAgentKeys = agentBySite.get(code) ?? [];
    const ownedHere = siteDevices
      .map((d) => deviceIdToAgent.get(d.id))
      .filter((row): row is (typeof ownership)[number] => Boolean(row));
    const localAssigned = ownedHere.filter((row) =>
      localAgentKeys.some((key) => runtime.find((a) => a.agentKey === key)?.id === row.agentId)
    ).length;
    return {
      siteCode: code,
      devices: siteDevices.length,
      online: siteDevices.filter((d) => d.status === "ONLINE").length,
      agents: localAgentKeys,
      agentCount: localAgentKeys.length,
      coveredLocally: localAssigned,
      remoteAssigned: ownedHere.length - localAssigned,
      coveragePct:
        ownedHere.length > 0
          ? Math.round((localAssigned / ownedHere.length) * 100)
          : 100,
    };
  });

  const moves = planRealRebalance(fleetInput).map((move) => ({
    deviceId: move.deviceId,
    hostname: move.hostname,
    fromAgentId: move.fromAgentKey,
    fromLoad: move.fromLoad,
    toAgentId: move.toAgentKey,
    toLoad: move.toLoad,
    reason: move.reason,
  }));

  const totalAssigned = ownership.length;
  const avgLoad =
    fleet.length > 0
      ? Math.round((fleet.reduce((sum, a) => sum + a.load, 0) / fleet.length) * 100) / 100
      : 0;
  const maxAgent = fleet.reduce(
    (worst, agent) => (agent.load > worst.load ? agent : worst),
    fleet[0]
  );

  return {
    plane: "real" as const,
    fleet,
    sites,
    summary: {
      agents: fleet.length,
      devicesAssigned: totalAssigned,
      avgLoad,
      maxLoadAgent: { agentId: maxAgent.agentId, name: maxAgent.name, load: maxAgent.load },
      overCapacityAgents: fleet.filter((a) => a.band === "over-capacity").length,
      uncoveredDevices: ownership.filter((row) => row.via !== "site-resident").length,
      unassignedSitelessDevices: devices.filter((d) => !d.siteId).length,
      registeredAgentsTotal: await db.collectorAgent.count(),
    },
    rebalancePreview: {
      moves,
      planId: planFingerprint(moves),
    },
  };
}

function realMeta() {
  return {
    simulated: false,
    plane: "real",
    note: "REAL collector control plane — fleet from registered agents, ownership from lease rows",
  };
}

function simulatedMeta() {
  return {
    simulated: true,
    plane: "simulated",
    note: "Agent fleet is a documented simulation — assignments are deterministic over real devices",
  };
}

/* ────────────────────────── SIMULATED plane (unchanged) ──────────────────── */

async function simulatedPlanePayload(devices: DeviceRow[]) {
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

  return {
    plane: "simulated" as const,
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
  };
}
