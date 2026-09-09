/**
 * FayaNMS collector agent distribution (Phase 15-b).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — DOCUMENTED SIMULATED AGENT FLEET                          │
 * │ The site-resident collector agents, versions, roles and capacities      │
 * │ below are a DOCUMENTED SIMULATION for the FayaNMS demo fleet, in the    │
 * │ same spirit as src/lib/ha/topology.ts. The device→agent ASSIGNMENT is   │
 * │ deterministic over REAL database device rows and the rebalance plan is  │
 * │ a guarded SIMULATION (staged audit rows only — nothing is deployed to  │
 * │ a real collector). This MUST NOT be used for real rollout planning.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Everything is deterministic and dependency-free:
 *   - COLLECTOR_AGENTS is a static in-code fleet over REAL seed site codes
 *     (prisma/seed.ts: HQ-SAN / DC-ADN / BR1-HOD / BR2-MUK);
 *   - assignDevices() maps real Device rows to agents with a stable FNV-1a
 *     hash — identical rows always produce an identical assignment;
 *   - distributionScore() / bandForLoad() are pure functions so
 *     GET /api/v1/admin/collectors/distribution returns identical scores
 *     for identical data (no polling flicker);
 *   - planRebalance() is a pure function producing the minimal deterministic
 *     move set for over-capacity agents (load > 0.85) to same-region peers.
 */

/* ───────────────────────── Agent fleet definition ───────────────────────── */

export type CollectorAgentRole = "snmp" | "netflow" | "syslog" | "config";

export interface CollectorAgentDefinition {
  agentId: string;
  /** English canonical name (technical string — the view localizes roles). */
  name: string;
  /** Seed-stable site code (prisma/seed.ts). */
  siteCode: string;
  /** Seed-stable region name (prisma/seed.ts Site.region). */
  region: string;
  role: CollectorAgentRole;
  /** Vendor-plausible agent version (simulated). */
  version: string;
  /** Simulated device capacity for load computation. */
  capacity: number;
  /** Primary/secondary pairing — the peer agent that can absorb its load. */
  peerAgentId: string;
}

export const COLLECTOR_AGENTS: readonly CollectorAgentDefinition[] = [
  {
    agentId: "coll-hq-snmp-01",
    name: "HQ SNMP Collector 01",
    siteCode: "HQ-SAN",
    region: "Sanaa",
    role: "snmp",
    version: "4.8.2",
    capacity: 14,
    peerAgentId: "coll-hq-config-01",
  },
  {
    agentId: "coll-hq-netflow-01",
    name: "HQ NetFlow Collector 01",
    siteCode: "HQ-SAN",
    region: "Sanaa",
    role: "netflow",
    version: "4.7.9",
    capacity: 10,
    peerAgentId: "coll-hq-snmp-01",
  },
  {
    agentId: "coll-hq-config-01",
    name: "HQ Config Collector 01",
    siteCode: "HQ-SAN",
    region: "Sanaa",
    role: "config",
    version: "4.8.2",
    capacity: 12,
    peerAgentId: "coll-hq-snmp-01",
  },
  {
    agentId: "coll-dc-snmp-01",
    name: "DC SNMP Collector 01",
    siteCode: "DC-ADN",
    region: "Aden",
    role: "snmp",
    version: "4.8.2",
    capacity: 12,
    peerAgentId: "coll-dc-syslog-01",
  },
  {
    agentId: "coll-dc-syslog-01",
    name: "DC Syslog Collector 01",
    siteCode: "DC-ADN",
    region: "Aden",
    role: "syslog",
    version: "4.6.5",
    capacity: 10,
    peerAgentId: "coll-dc-snmp-01",
  },
  {
    agentId: "coll-br1-edge-01",
    name: "BR1 Edge Collector 01",
    siteCode: "BR1-HOD",
    region: "Al Hudaydah",
    role: "snmp",
    version: "4.7.9",
    capacity: 8,
    peerAgentId: "coll-dc-snmp-01",
  },
  {
    agentId: "coll-br2-edge-01",
    name: "BR2 Edge Collector 01",
    siteCode: "BR2-MUK",
    region: "Al Mukalla",
    role: "snmp",
    version: "4.6.5",
    capacity: 8,
    peerAgentId: "coll-dc-snmp-01",
  },
];

/** Every site code referenced by the fleet (single lookup set for the API). */
export const COLLECTOR_SITE_CODES: readonly string[] = [
  ...new Set(COLLECTOR_AGENTS.map((agent) => agent.siteCode)),
];

export function findCollectorAgent(
  agentId: string
): CollectorAgentDefinition | null {
  return COLLECTOR_AGENTS.find((agent) => agent.agentId === agentId) ?? null;
}

/* ───────────────────────── Deterministic device assignment ───────────────────────── */

/** Minimal Device row shape the pure helpers need. */
export interface DeviceAssignmentRow {
  id: string;
  hostname: string;
  siteCode: string | null;
  status: string;
}

/** One device→agent assignment with the reason it was chosen. */
export interface DeviceAssignment {
  deviceId: string;
  hostname: string;
  siteCode: string | null;
  online: boolean;
  agentId: string;
  /** How the assignment was chosen (deterministic rule name). */
  via: "site-resident" | "peer-site" | "fallback-regional";
}

/**
 * FNV-1a 32-bit hash — stable across processes (plain string hashing,
 * no Math.random, no Date.now).
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Assign real device rows to collector agents (pure + deterministic):
 *   1. site-resident agents of the device's own site (hash-spread),
 *   2. else the fleet's cross-site edge agents of a DIFFERENT site
 *      (hash-spread — models spoke devices polled over the WAN),
 *   3. else the fallback agent (HQ SNMP).
 * Identical rows always produce an identical assignment.
 */
export function assignDevices(
  devices: readonly DeviceAssignmentRow[]
): DeviceAssignment[] {
  const siteAgents = new Map<string, CollectorAgentDefinition[]>();
  for (const agent of COLLECTOR_AGENTS) {
    const list = siteAgents.get(agent.siteCode) ?? [];
    list.push(agent);
    siteAgents.set(agent.siteCode, list);
  }

  const fallback = COLLECTOR_AGENTS[0];

  return devices.map((device) => {
    const sitePool = device.siteCode
      ? siteAgents.get(device.siteCode)
      : undefined;
    if (sitePool && sitePool.length > 0) {
      const agent = sitePool[fnv1a(device.id) % sitePool.length];
      return {
        deviceId: device.id,
        hostname: device.hostname,
        siteCode: device.siteCode,
        online: device.status === "ONLINE",
        agentId: agent.agentId,
        via: "site-resident",
      };
    }

    const crossSitePool = COLLECTOR_AGENTS.filter(
      (agent) => agent.siteCode !== device.siteCode
    );
    if (crossSitePool.length > 0) {
      const agent = crossSitePool[fnv1a(device.id) % crossSitePool.length];
      return {
        deviceId: device.id,
        hostname: device.hostname,
        siteCode: device.siteCode,
        online: device.status === "ONLINE",
        agentId: agent.agentId,
        via: "peer-site",
      };
    }

    return {
      deviceId: device.id,
      hostname: device.hostname,
      siteCode: device.siteCode,
      online: device.status === "ONLINE",
      agentId: fallback.agentId,
      via: "fallback-regional",
    };
  });
}

/* ───────────────── Load / score / band (deterministic) ───────────────── */

export type CollectorLoadBand = "normal" | "elevated" | "over-capacity";

export interface AgentLoad {
  agentId: string;
  assignedCount: number;
  onlineCount: number;
  /** assignedCount / capacity, rounded to 2dp. */
  load: number;
  band: CollectorLoadBand;
  /** 0–100 distribution score, rounded to 1dp (documented composition):
   *  score = 100 × (1 − loadPenalty) × (0.7 + 0.3 × onlineRatio)
   *    loadPenalty = max(0, load − 0.6)  (headroom above 60% utilisation)
   *  Identical inputs always produce an identical score. */
  score: number;
}

/** Band ladder: load ≤ 0.70 normal, ≤ 0.85 elevated, else over-capacity. */
export function bandForLoad(load: number): CollectorLoadBand {
  if (load <= 0.7) return "normal";
  if (load <= 0.85) return "elevated";
  return "over-capacity";
}

/** Documented deterministic distribution score — see AgentLoad.score. */
export function distributionScore(load: number, onlineRatio: number): number {
  const safeLoad = Number.isFinite(load) ? Math.max(0, load) : 0;
  const safeOnline = Number.isFinite(onlineRatio)
    ? Math.min(1, Math.max(0, onlineRatio))
    : 0;
  const loadPenalty = Math.max(0, safeLoad - 0.6);
  const raw = 100 * (1 - loadPenalty) * (0.7 + 0.3 * safeOnline);
  return Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
}

/** Compose per-agent load from the assignment list (pure). */
export function composeAgentLoads(
  assignments: readonly DeviceAssignment[]
): AgentLoad[] {
  const byAgent = new Map<string, DeviceAssignment[]>();
  for (const assignment of assignments) {
    const list = byAgent.get(assignment.agentId) ?? [];
    list.push(assignment);
    byAgent.set(assignment.agentId, list);
  }

  return COLLECTOR_AGENTS.map((agent) => {
    const assigned = byAgent.get(agent.agentId) ?? [];
    const onlineCount = assigned.filter((a) => a.online).length;
    const load = Math.round((assigned.length / agent.capacity) * 100) / 100;
    return {
      agentId: agent.agentId,
      assignedCount: assigned.length,
      onlineCount,
      load,
      band: bandForLoad(load),
      score: distributionScore(
        load,
        assigned.length > 0 ? onlineCount / assigned.length : 1
      ),
    };
  });
}

/* ───────────────── Rebalance plan (deterministic, guarded) ───────────────── */

export interface RebalanceMove {
  deviceId: string;
  hostname: string;
  fromAgentId: string;
  fromLoad: number;
  toAgentId: string;
  toLoad: number;
  reason: "over-capacity";
}

/**
 * Deterministic minimal rebalance plan (pure): while any agent is over
 * capacity (load > 0.85), move its lexicographically-stable assigned device
 * to the same-region peer with the lowest projected load, skipping peers
 * that would themselves exceed 0.85. Moves carry before/after loads so the
 * UI can render the plan and the API can verify planId freshness (the plan
 * fingerprint is recomputed on apply).
 */
export function planRebalance(
  assignments: readonly DeviceAssignment[]
): RebalanceMove[] {
  const working: DeviceAssignment[] = [...assignments];
  const loads = new Map<string, AgentLoad>(
    composeAgentLoads(working).map((load) => [load.agentId, load])
  );
  const moves: RebalanceMove[] = [];

  // Bounded loop — capacity is finite so this always terminates.
  for (let guard = 0; guard < COLLECTOR_AGENTS.length * 4; guard += 1) {
    const over = [...loads.values()]
      .filter((load) => load.band === "over-capacity")
      .sort(
        (a, b) => b.load - a.load || a.agentId.localeCompare(b.agentId)
      )[0];
    if (!over) break;

    const source = COLLECTOR_AGENTS.find((a) => a.agentId === over.agentId);
    if (!source) break;

    const assigned = working
      .filter((a) => a.agentId === over.agentId)
      .sort(
        (a, b) =>
          b.hostname.localeCompare(a.hostname) ||
          a.deviceId.localeCompare(b.deviceId)
      );
    if (assigned.length === 0) break;
    const victim = assigned[assigned.length - 1];

    const peer = COLLECTOR_AGENTS.find((a) => a.agentId === source.peerAgentId);
    const candidates = (peer ? [peer] : []).concat(
      COLLECTOR_AGENTS.filter(
        (a) =>
          a.region === source.region &&
          a.agentId !== source.agentId &&
          a.agentId !== source.peerAgentId
      )
    );

    const target = candidates
      .map((candidate) => {
        const current = loads.get(candidate.agentId);
        const projected =
          ((current?.assignedCount ?? 0) + 1) / candidate.capacity;
        return { candidate, projected };
      })
      .filter((entry) => entry.projected <= 0.85)
      .sort((a, b) => a.projected - b.projected)[0];

    if (!target) break; // Nowhere to move — plan stops (documented).

    const fromLoad = loads.get(over.agentId)?.load ?? 0;
    const toLoadCurrent = loads.get(target.candidate.agentId)?.load ?? 0;

    working.splice(working.indexOf(victim), 1);
    working.push({ ...victim, agentId: target.candidate.agentId });

    const nextLoads = composeAgentLoads(working);
    for (const load of nextLoads) loads.set(load.agentId, load);

    moves.push({
      deviceId: victim.deviceId,
      hostname: victim.hostname,
      fromAgentId: over.agentId,
      fromLoad,
      toAgentId: target.candidate.agentId,
      toLoad: Math.round(toLoadCurrent * 100) / 100,
      reason: "over-capacity",
    });
  }

  return moves;
}

/**
 * Stable plan fingerprint over the move list — the apply endpoint
 * recomputes it and rejects the apply (409 COLLECTOR_PLAN_STALE) when the
 * live assignment drifts between preview and confirm.
 */
export function planFingerprint(moves: readonly RebalanceMove[]): string {
  const payload = moves
    .map((m) => `${m.deviceId}>${m.toAgentId}`)
    .sort()
    .join("|");
  return fnv1a(payload).toString(16).padStart(8, "0");
}

/* ───────────────── Staged rebalance (shared contract) ───────────────── */

/**
 * Simulated per-stage duration (ms) — SHARED by the apply route (actual
 * sleeps) and the view's staged progress ticker so both sides walk the
 * same deterministic cadence (~700ms per move).
 */
export const REBALANCE_STAGE_SLEEP_MS = 700;

/** Audit metadata written into afterJson for COLLECTOR_REBALANCE rows. */
export interface CollectorRebalanceMeta {
  planId: string;
  stage: "move" | "complete";
  deviceId?: string;
  hostname?: string;
  fromAgentId?: string;
  toAgentId?: string;
  fromLoad?: number;
  toLoad?: number;
  moveIndex?: number;
  totalMoves?: number;
  durationMs?: number;
}
