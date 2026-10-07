/**
 * FayaNMS collector REAL control plane (GA-4b — P0-R06 / P1-O01).
 *
 * Replaces the static in-code fleet for ASSIGNMENT DECISIONS: registration,
 * heartbeat liveness, assignment ownership rows with lease epochs, fencing,
 * failover/rebalance that actually move ownership rows (DB-backed).
 *
 * Relationship to the documented simulation (src/lib/collectors/distribution.ts):
 * the simulation's pure primitives (fnv1a, bandForLoad, distributionScore,
 * planFingerprint, REBALANCE_STAGE_SLEEP_MS) and its honest `via` labels are
 * REUSED here; the static COLLECTOR_AGENTS array itself survives only as
 * labeled demo/seed data and the fallback plane when zero real agents are
 * registered (the routes own that dual-plane decision).
 *
 * Fencing model (house precedents, composed):
 *   - CollectorAssignment.leaseEpoch = the fencing token — bumped on EVERY
 *     ownership transfer; a heartbeat claiming a stale epoch is FENCED
 *     (User.credentialEpoch / JobExecution.attempts pattern).
 *   - CollectorAssignment.leasedUntil = the crash valve — renewed on every
 *     accepted heartbeat; the reaper re-targets rows whose lease expired and
 *     fails over agents whose heartbeat went silent (ChangeExecutionLease
 *     expiry pattern).
 *   - Ownership mutations are CONDITIONAL single-row updates
 *     (`updateMany` where deviceId + agentId + leaseEpoch) so two concurrent
 *     control-plane actions can never double-move a device; the loser sees
 *     count 0 and reports it honestly.
 *
 * Audit discipline: registration, reconcile, failover, rebalance-apply and
 * reaping write AuditEvent rows (chain-stamped by the db extension). Healthy
 * heartbeats do NOT (a 30s cadence would drown the chain); an anomalous
 * heartbeat that fences claims writes ONE aggregated COLLECTOR_AGENT_FENCED
 * row.
 */

import { db } from "@/lib/db";
import { fnv1a, planFingerprint } from "@/lib/collectors/distribution";

export { planFingerprint };

/* ───────────────────────── Liveness / lease constants ───────────────────── */

/** Advertised heartbeat cadence (seconds) — the register/heartbeat responses
 *  carry it so agents never guess. Three missed beats ⇒ reaper-eligible. */
export const COLLECTOR_HEARTBEAT_INTERVAL_S = 30;

/** Lease TTL (ms) — how long an ownership row survives without a renewal. */
export const COLLECTOR_LEASE_TTL_MS = 90_000;

/** Reaper grace for ROW-level leases: a row is stale once
 *  leasedUntil < now - ROW_STALE_GRACE_MS even if its agent still heartbeats
 *  (the agent silently stopped claiming it). Agent-level silence uses the
 *  plain TTL on lastHeartbeatAt. */
export const COLLECTOR_ROW_STALE_GRACE_MS = 30_000;

export function collectorLeaseExpiry(now: Date): Date {
  return new Date(now.getTime() + COLLECTOR_LEASE_TTL_MS);
}

/* ───────────────────────────── Shared types ─────────────────────────────── */

export type CollectorVia = "site-resident" | "peer-site" | "fallback-regional";

export interface CollectorAgentRuntime {
  id: string;
  agentKey: string;
  displayName: string;
  siteId: string | null;
  siteCode: string | null;
  region: string | null;
  role: string;
  version: string | null;
  capacity: number;
  status: string;
  lastHeartbeatAt: Date | null;
}

/** Device row as the assignment math sees it (deterministic order). */
export interface RealDeviceRow {
  id: string;
  hostname: string;
  siteId: string | null;
  siteCode: string | null;
  siteRegion: string | null;
  status: string;
}

/** Deterministic target assignment for one device (pure output). */
export interface RealTarget {
  agentId: string;
  agentKey: string;
  via: CollectorVia;
}

/** The honest `via` label for pairing device↔agent (mirrors the simulation). */
export function viaFor(
  device: { siteId: string | null; siteRegion: string | null },
  agent: { siteId: string | null; region: string | null }
): CollectorVia {
  if (agent.siteId && device.siteId && agent.siteId === device.siteId) {
    return "site-resident";
  }
  if (agent.region && device.siteRegion && agent.region === device.siteRegion) {
    return "peer-site";
  }
  return "fallback-regional";
}

/**
 * Deterministic device→agent targeting over the REAL registered fleet
 * (pure): ACTIVE agents, ordered site-resident → same-region → any, then a
 * stable FNV-1a spread over the device id — the same composition the
 * documented simulation uses over the static fleet. Devices of unknown
 * target (zero ACTIVE agents) get null.
 */
export function targetAssignmentFor(
  device: RealDeviceRow,
  agents: readonly CollectorAgentRuntime[]
): RealTarget | null {
  if (agents.length === 0) return null;
  const siteResident = agents.filter(
    (agent) => agent.siteId && agent.siteId === device.siteId
  );
  const sameRegion = agents.filter(
    (agent) =>
      agent.region &&
      device.siteRegion &&
      agent.region === device.siteRegion &&
      !siteResident.includes(agent)
  );
  const pool =
    siteResident.length > 0
      ? siteResident
      : sameRegion.length > 0
        ? sameRegion
        : agents;
  const chosen = pool[fnv1a(device.id) % pool.length];
  return {
    agentId: chosen.id,
    agentKey: chosen.agentKey,
    via: viaFor(device, chosen),
  };
}

/* ───────────────────────────── Registration ─────────────────────────────── */

export interface RegistrationInput {
  agentKey: string;
  displayName: string;
  role: string;
  siteCode?: string | null;
  version?: string | null;
  capacity?: number | null;
}

export interface RegistrationResult {
  created: boolean;
  agent: CollectorAgentRuntime;
}

/**
 * Idempotent agent registration (upsert by agentKey). Re-registration
 * refreshes residency/version/capacity and REACTIVATES (SUSPENDED →
 * ACTIVE) — a returning agent is a liveness fact, not an operator action.
 * Registration counts as the first heartbeat.
 */
export async function registerCollectorAgent(
  input: RegistrationInput,
  actorName: string,
  now: Date = new Date()
): Promise<RegistrationResult> {
  let site: { id: string; region: string | null } | null = null;
  if (input.siteCode) {
    const found = await db.site.findUnique({
      where: { code: input.siteCode },
      select: { id: true, region: true },
    });
    if (!found) {
      throw new CollectorControlError(
        "COLLECTOR_SITE_UNKNOWN",
        `Registration referenced unknown site code "${input.siteCode}" — agents must claim a real site (or omit siteCode to be siteless)`,
        400
      );
    }
    site = found;
  }

  const existing = await db.collectorAgent.findUnique({
    where: { agentKey: input.agentKey },
    select: { id: true },
  });

  const agent = await db.collectorAgent.upsert({
    where: { agentKey: input.agentKey },
    create: {
      agentKey: input.agentKey,
      displayName: input.displayName,
      role: input.role,
      siteId: site?.id ?? null,
      region: site?.region ?? null,
      version: input.version ?? null,
      capacity: input.capacity ?? 10,
      status: "ACTIVE",
      lastHeartbeatAt: now,
      registeredBy: actorName,
    },
    update: {
      displayName: input.displayName,
      role: input.role,
      siteId: site?.id ?? null,
      region: site?.region ?? null,
      version: input.version ?? null,
      capacity: input.capacity ?? undefined,
      status: "ACTIVE",
      lastHeartbeatAt: now,
      registeredBy: actorName,
    },
  });

  await db.auditEvent.create({
    data: {
      actorName,
      action: "COLLECTOR_AGENT_REGISTERED",
      resourceType: "CollectorAgent",
      resourceId: agent.agentKey,
      resourceLabel: agent.displayName,
      result: "SUCCESS",
      afterJson: JSON.stringify({
        agentKey: agent.agentKey,
        siteCode: input.siteCode ?? null,
        role: agent.role,
        version: agent.version,
        capacity: agent.capacity,
        created: existing === null,
      }),
    },
  });

  return {
    created: existing === null,
    agent: toRuntime(agent),
  };
}

type AgentRow = {
  id: string;
  agentKey: string;
  displayName: string;
  siteId: string | null;
  region: string | null;
  role: string;
  version: string | null;
  capacity: number;
  status: string;
  lastHeartbeatAt: Date | null;
};

function toRuntime(agent: AgentRow): CollectorAgentRuntime {
  return {
    id: agent.id,
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    siteId: agent.siteId,
    siteCode: null,
    region: agent.region,
    role: agent.role,
    version: agent.version,
    capacity: agent.capacity,
    status: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt,
  };
}

/* ───────────────────────────── Heartbeat / fencing ──────────────────────── */

export interface HeartbeatClaim {
  deviceId: string;
  leaseEpoch: number;
}

export type FencedReason =
  | "unknown-assignment"
  | "not-owner"
  | "stale-epoch"
  | "agent-suspended";

export interface FencedClaim {
  deviceId: string;
  leaseEpoch: number;
  reason: FencedReason;
}

export interface HeartbeatResult {
  agentKey: string;
  agentStatus: string;
  acknowledgedAt: string;
  renewed: number;
  fenced: FencedClaim[];
}

/**
 * Process one agent heartbeat: liveness refresh + lease renewals + FENCING.
 * A claim survives only when the caller names the CURRENT owner with the
 * CURRENT epoch — anything else is fenced with the precise reason so the
 * agent can drop state it no longer owns.
 */
export async function processHeartbeat(
  agentKey: string,
  claims: readonly HeartbeatClaim[],
  now: Date = new Date()
): Promise<HeartbeatResult> {
  const agent = await db.collectorAgent.findUnique({ where: { agentKey } });
  if (!agent) {
    throw new CollectorControlError(
      "COLLECTOR_AGENT_UNKNOWN",
      `Heartbeat from unregistered agent "${agentKey}" — register first`,
      404
    );
  }

  await db.collectorAgent.update({
    where: { id: agent.id },
    data: { lastHeartbeatAt: now },
  });

  const fenced: FencedClaim[] = [];
  let renewed = 0;
  const seen = new Set<string>();

  for (const claim of claims) {
    if (seen.has(claim.deviceId)) continue; // dedupe — first claim wins
    seen.add(claim.deviceId);

    if (agent.status !== "ACTIVE") {
      fenced.push({
        deviceId: claim.deviceId,
        leaseEpoch: claim.leaseEpoch,
        reason: "agent-suspended",
      });
      continue;
    }

    const assignment = await db.collectorAssignment.findUnique({
      where: { deviceId: claim.deviceId },
      select: { agentId: true, leaseEpoch: true },
    });
    if (!assignment) {
      fenced.push({
        deviceId: claim.deviceId,
        leaseEpoch: claim.leaseEpoch,
        reason: "unknown-assignment",
      });
      continue;
    }
    if (assignment.agentId !== agent.id) {
      fenced.push({
        deviceId: claim.deviceId,
        leaseEpoch: claim.leaseEpoch,
        reason: "not-owner",
      });
      continue;
    }
    if (assignment.leaseEpoch !== claim.leaseEpoch) {
      fenced.push({
        deviceId: claim.deviceId,
        leaseEpoch: claim.leaseEpoch,
        reason: "stale-epoch",
      });
      continue;
    }

    // Optimistic renewal: the epoch guard makes the renew race-safe (a
    // concurrent transfer flips agentId/epoch and this update matches 0 rows).
    const renewedBatch = await db.collectorAssignment.updateMany({
      where: {
        deviceId: claim.deviceId,
        agentId: agent.id,
        leaseEpoch: claim.leaseEpoch,
      },
      data: { leasedUntil: collectorLeaseExpiry(now) },
    });
    if (renewedBatch.count === 1) {
      renewed += 1;
    } else {
      fenced.push({
        deviceId: claim.deviceId,
        leaseEpoch: claim.leaseEpoch,
        reason: "stale-epoch",
      });
    }
  }

  // Audit ONLY anomalies — a healthy 30s cadence must not flood the chain.
  if (fenced.length > 0) {
    await db.auditEvent.create({
      data: {
        actorName: `collector:${agentKey}`,
        action: "COLLECTOR_AGENT_FENCED",
        resourceType: "CollectorAgent",
        resourceId: agentKey,
        resourceLabel: agent.displayName,
        result: "SUCCESS",
        afterJson: JSON.stringify({
          totalFenced: fenced.length,
          renewed,
          fenced: fenced.slice(0, 20),
          truncated: fenced.length > 20,
        }),
      },
    });
  }

  return {
    agentKey,
    agentStatus: agent.status,
    acknowledgedAt: now.toISOString(),
    renewed,
    fenced,
  };
}

/* ───────────────────────────── Reconcile ────────────────────────────────── */

export interface ReconcileResult {
  agents: number;
  devicesEligible: number;
  created: number;
  moved: number;
  kept: number;
  released: number;
  skippedConcurrent: number;
  unassignedSiteless: number;
  unassignedNoAgents: number;
}

/**
 * Reconcile ownership with the deterministic target plan over the CURRENT
 * real fleet: creates missing ownership, moves mismatched ownership (epoch
 * bump = the old owner is fenced), releases ownership when no agent can
 * take it, and counts siteless devices honestly (they are NEVER assigned —
 * assignment needs site residency to reason about failover).
 * One transaction for the state; the audit row follows the commit.
 */
export async function reconcileAssignments(
  actorName: string,
  now: Date = new Date()
): Promise<ReconcileResult> {
  const [agents, devices, current] = await Promise.all([
    db.collectorAgent.findMany({
      where: { status: "ACTIVE" },
      orderBy: { agentKey: "asc" },
      select: {
        id: true,
        agentKey: true,
        displayName: true,
        siteId: true,
        region: true,
        role: true,
        version: true,
        capacity: true,
        status: true,
        lastHeartbeatAt: true,
      },
    }),
    db.device.findMany({
      select: {
        id: true,
        hostname: true,
        siteId: true,
        site: { select: { code: true, region: true } },
        status: true,
      },
      orderBy: { hostname: "asc" },
    }),
    db.collectorAssignment.findMany({
      select: { deviceId: true, agentId: true, leaseEpoch: true },
    }),
  ]);

  const runtimeAgents: CollectorAgentRuntime[] = agents.map(toRuntime);
  const realDevices: RealDeviceRow[] = devices.map((device) => ({
    id: device.id,
    hostname: device.hostname,
    siteId: device.siteId,
    siteCode: device.site?.code ?? null,
    siteRegion: device.site?.region ?? null,
    status: device.status,
  }));
  const ownershipByDevice = new Map(current.map((row) => [row.deviceId, row]));

  const result: ReconcileResult = {
    agents: runtimeAgents.length,
    devicesEligible: 0,
    created: 0,
    moved: 0,
    kept: 0,
    released: 0,
    skippedConcurrent: 0,
    unassignedSiteless: 0,
    unassignedNoAgents: 0,
  };

  await db.$transaction(async (tx) => {
    for (const device of realDevices) {
      if (!device.siteId) {
        result.unassignedSiteless += 1;
        continue;
      }
      result.devicesEligible += 1;
      const target = targetAssignmentFor(device, runtimeAgents);
      const currentRow = ownershipByDevice.get(device.id);

      if (currentRow && target && currentRow.agentId === target.agentId) {
        result.kept += 1;
        continue;
      }

      if (currentRow && target) {
        const movedCount = await tx.collectorAssignment.updateMany({
          where: {
            deviceId: device.id,
            agentId: currentRow.agentId,
            leaseEpoch: currentRow.leaseEpoch,
          },
          data: {
            agentId: target.agentId,
            via: target.via,
            leaseEpoch: { increment: 1 },
            leasedUntil: collectorLeaseExpiry(now),
            assignedBy: "reconcile",
            assignedAt: now,
          },
        });
        if (movedCount.count === 1) result.moved += 1;
        else result.skippedConcurrent += 1;
        continue;
      }

      if (!currentRow && target) {
        try {
          await tx.collectorAssignment.create({
            data: {
              deviceId: device.id,
              agentId: target.agentId,
              via: target.via,
              leaseEpoch: 1,
              leasedUntil: collectorLeaseExpiry(now),
              assignedBy: "reconcile",
              assignedAt: now,
            },
          });
          result.created += 1;
        } catch (error) {
          // A concurrent reconcile/heartbeat created it first — honest skip,
          // never a double-ownership (deviceId @unique guarantees that).
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: string }).code === "P2002"
          ) {
            result.skippedConcurrent += 1;
          } else {
            throw error;
          }
        }
        continue;
      }

      if (currentRow && !target) {
        // Fleet shrank to zero (or the owner left with no replacement):
        // release the row. The device is honestly unassigned, not owned by
        // a ghost.
        const deleted = await tx.collectorAssignment.deleteMany({
          where: {
            deviceId: device.id,
            agentId: currentRow.agentId,
            leaseEpoch: currentRow.leaseEpoch,
          },
        });
        if (deleted.count === 1) result.released += 1;
        else result.skippedConcurrent += 1;
        continue;
      }

      // !currentRow && !target — eligible device, no fleet: counted via
      // unassignedNoAgents below (single flag, not per-device noise).
      result.unassignedNoAgents += 1;
    }
  });

  await db.auditEvent.create({
    data: {
      actorName,
      action: "COLLECTOR_ASSIGNMENTS_RECONCILED",
      resourceType: "CollectorAgent",
      resourceId: "fleet",
      resourceLabel: `Assignment reconcile — ${result.created} created, ${result.moved} moved, ${result.kept} kept`,
      result: "SUCCESS",
      afterJson: JSON.stringify(result),
    },
  });

  return result;
}

/* ───────────────────────────── Failover ─────────────────────────────────── */

export type FailoverReason = "manual" | "heartbeat-timeout";

export interface FailoverResult {
  fromAgentKey: string;
  toAgentKey: string | null;
  moved: number;
  skippedConcurrent: number;
  suspended: boolean;
}

/**
 * Deterministic failover peer: ACTIVE agents other than the failing one,
 * preferring same region → same site → any; within a tier, most capacity
 * then agentKey asc. Returns null when no peer exists (the caller keeps
 * ownership with the silent agent and the operators see it — ownership is
 * never silently dropped).
 */
export async function selectFailoverPeer(
  agent: { id: string; siteId: string | null; region: string | null },
  now: Date = new Date()
): Promise<CollectorAgentRuntime | null> {
  const peers = await db.collectorAgent.findMany({
    where: { status: "ACTIVE", id: { not: agent.id } },
    orderBy: [{ capacity: "desc" }, { agentKey: "asc" }],
    select: {
      id: true,
      agentKey: true,
      displayName: true,
      siteId: true,
      region: true,
      role: true,
      version: true,
      capacity: true,
      status: true,
      lastHeartbeatAt: true,
    },
  });
  if (peers.length === 0) return null;
  const sameRegion = peers.filter((p) => p.region && p.region === agent.region);
  if (sameRegion.length > 0) return toRuntime(sameRegion[0]);
  const sameSite = peers.filter((p) => p.siteId && p.siteId === agent.siteId);
  if (sameSite.length > 0) return toRuntime(sameSite[0]);
  return toRuntime(peers[0]);
}

/**
 * Move EVERY assignment owned by `agentKey` to the failover peer, bumping
 * each row's lease epoch (the failing agent's next heartbeat is fenced),
 * optionally suspending the agent (it is excluded from reconcile targets
 * and every claim it sends is fenced with agent-suspended).
 * A single summary audit row records the action — unlike the SIMULATION's
 * per-move staging there is real state here: the ownership table itself is
 * the move log.
 */
export async function failoverAgent(
  actorName: string,
  agentKey: string,
  reason: FailoverReason,
  opts: { suspendAgent?: boolean } = {},
  now: Date = new Date()
): Promise<FailoverResult> {
  const agent = await db.collectorAgent.findUnique({ where: { agentKey } });
  if (!agent) {
    throw new CollectorControlError(
      "COLLECTOR_AGENT_UNKNOWN",
      `Cannot fail over unknown agent "${agentKey}"`,
      404
    );
  }

  const peer = await selectFailoverPeer(agent, now);
  const owned = await db.collectorAssignment.findMany({
    where: { agentId: agent.id },
    select: {
      deviceId: true,
      leaseEpoch: true,
      device: { select: { siteId: true, site: { select: { region: true } } } },
    },
  });

  const result: FailoverResult = {
    fromAgentKey: agent.agentKey,
    toAgentKey: peer?.agentKey ?? null,
    moved: 0,
    skippedConcurrent: 0,
    suspended: false,
  };

  if (peer) {
    for (const row of owned) {
      const via = viaFor(
        { siteId: row.device.siteId, siteRegion: row.device.site?.region ?? null },
        peer
      );
      const movedCount = await db.collectorAssignment.updateMany({
        where: {
          deviceId: row.deviceId,
          agentId: agent.id,
          leaseEpoch: row.leaseEpoch,
        },
        data: {
          agentId: peer.id,
          via,
          leaseEpoch: { increment: 1 },
          leasedUntil: collectorLeaseExpiry(now),
          assignedBy: "failover",
          assignedAt: now,
        },
      });
      if (movedCount.count === 1) result.moved += 1;
      else result.skippedConcurrent += 1;
    }
  }

  if (opts.suspendAgent) {
    await db.collectorAgent.update({
      where: { id: agent.id },
      data: { status: "SUSPENDED" },
    });
    result.suspended = true;
  }

  await db.auditEvent.create({
    data: {
      actorName,
      action: "COLLECTOR_AGENT_FAILOVER",
      resourceType: "CollectorAgent",
      resourceId: agent.agentKey,
      resourceLabel: `Failover ${reason} — ${result.moved} assignment(s) → ${result.toAgentKey ?? "(no peer)"}`,
      result: "SUCCESS",
      afterJson: JSON.stringify({ reason, ...result }),
    },
  });

  return result;
}

/* ───────────────────────────── Reaper ───────────────────────────────────── */

export interface ReaperSweep {
  agentKey: string;
  moved: number;
  toAgentKey: string | null;
}

export interface ReaperResult {
  cutoff: string;
  failedOver: ReaperSweep[];
  retargetedRows: number;
}

/**
 * Liveness sweep:
 *   1. AGENT-level — ACTIVE agents whose lastHeartbeatAt went silent past
 *      COLLECTOR_LEASE_TTL_MS are failed over (reason heartbeat-timeout).
 *   2. ROW-level — leases expired past the row-stale grace whose owner is
 *      STILL heartbeating are re-targeted to their deterministic target
 *      (same target ⇒ quiet renewal; different target ⇒ epoch-bumped move
 *      the stopped agent is fenced from).
 */
export async function reapExpiredLeases(
  actorName: string,
  now: Date = new Date()
): Promise<ReaperResult> {
  const cutoff = new Date(now.getTime() - COLLECTOR_LEASE_TTL_MS);
  const result: ReaperResult = {
    cutoff: cutoff.toISOString(),
    failedOver: [],
    retargetedRows: 0,
  };

  const silent = await db.collectorAgent.findMany({
    where: { status: "ACTIVE", lastHeartbeatAt: { lt: cutoff } },
    orderBy: { agentKey: "asc" },
    select: { agentKey: true },
  });
  for (const agent of silent) {
    const outcome = await failoverAgent(actorName, agent.agentKey, "heartbeat-timeout", {}, now);
    result.failedOver.push({
      agentKey: agent.agentKey,
      moved: outcome.moved,
      toAgentKey: outcome.toAgentKey,
    });
  }

  // Row-level stale leases (owner alive but stopped claiming the device).
  const rowCutoff = new Date(now.getTime() - COLLECTOR_ROW_STALE_GRACE_MS);
  const staleRows = await db.collectorAssignment.findMany({
    where: { leasedUntil: { lt: rowCutoff } },
    select: {
      id: true,
      deviceId: true,
      agentId: true,
      leaseEpoch: true,
      device: {
        select: {
          siteId: true,
          site: { select: { code: true, region: true } },
        },
      },
      agent: { select: { status: true, lastHeartbeatAt: true } },
    },
    take: 500,
    orderBy: { leasedUntil: "asc" },
  });

  const liveAgents = await db.collectorAgent.findMany({
    where: { status: "ACTIVE", lastHeartbeatAt: { gte: cutoff } },
    orderBy: { agentKey: "asc" },
    select: {
      id: true,
      agentKey: true,
      displayName: true,
      siteId: true,
      region: true,
      role: true,
      version: true,
      capacity: true,
      status: true,
      lastHeartbeatAt: true,
    },
  });
  const liveRuntime = liveAgents.map(toRuntime);

  for (const row of staleRows) {
    if (row.agent.status !== "ACTIVE") continue; // handled by the agent sweep
    const target = targetAssignmentFor(
      {
        id: row.deviceId,
        hostname: "",
        siteId: row.device.siteId,
        siteCode: row.device.site?.code ?? null,
        siteRegion: row.device.site?.region ?? null,
        status: "",
      },
      liveRuntime
    );
    if (!target) continue;
    if (target.agentId === row.agentId) {
      // Same owner — quiet renewal, no epoch bump (nothing transferred).
      await db.collectorAssignment.updateMany({
        where: { id: row.id, leaseEpoch: row.leaseEpoch },
        data: { leasedUntil: collectorLeaseExpiry(now) },
      });
      result.retargetedRows += 1;
      continue;
    }
    const movedCount = await db.collectorAssignment.updateMany({
      where: { id: row.id, agentId: row.agentId, leaseEpoch: row.leaseEpoch },
      data: {
        agentId: target.agentId,
        via: target.via,
        leaseEpoch: { increment: 1 },
        leasedUntil: collectorLeaseExpiry(now),
        assignedBy: "failover",
      },
    });
    if (movedCount.count === 1) result.retargetedRows += 1;
  }

  if (result.failedOver.length > 0 || result.retargetedRows > 0) {
    await db.auditEvent.create({
      data: {
        actorName,
        action: "COLLECTOR_LEASES_REAPED",
        resourceType: "CollectorAgent",
        resourceId: "fleet",
        resourceLabel: `Lease reaper — ${result.failedOver.length} silent agent(s), ${result.retargetedRows} stale row(s)`,
        result: "SUCCESS",
        afterJson: JSON.stringify(result),
      },
    });
  }

  return result;
}

/* ───────────────────────────── Real rebalance ───────────────────────────── */

export interface RealRebalanceMove {
  deviceId: string;
  hostname: string;
  fromAgentId: string;
  fromAgentKey: string;
  fromLoad: number;
  toAgentId: string;
  toAgentKey: string;
  toLoad: number;
  reason: "over-capacity";
}

export interface RealFleetAgent {
  agent: CollectorAgentRuntime;
  owned: { deviceId: string; hostname: string; online: boolean }[];
}

/**
 * Deterministic rebalance plan over the REAL fleet (pure): while an agent
 * is over capacity (load > 0.85), move its lexicographically-stable owned
 * device to the same-region peer with the lowest projected load, skipping
 * peers that would themselves exceed 0.85. Same composition/semantics as
 * the documented simulation's planRebalance — but over ownership rows.
 */
export function planRealRebalance(fleet: readonly RealFleetAgent[]): RealRebalanceMove[] {
  const state = fleet.map((entry) => ({
    agent: entry.agent,
    owned: [...entry.owned].sort((a, b) =>
      a.hostname === b.hostname
        ? a.deviceId.localeCompare(b.deviceId)
        : a.hostname.localeCompare(b.hostname)
    ),
    load: entry.agent.capacity > 0 ? entry.owned.length / entry.agent.capacity : 1,
  }));

  const moves: RealRebalanceMove[] = [];
  const regionOf = (agent: CollectorAgentRuntime) => agent.region;

  // Deterministic sweep order: agentKey asc.
  state.sort((a, b) => a.agent.agentKey.localeCompare(b.agent.agentKey));

  for (const source of state) {
    let guard = 0;
    while (source.load > 0.85 && source.owned.length > 0 && guard < 10_000) {
      guard += 1;
      const victim = source.owned[0]; // lexicographically-stable overflow device
      const candidates = state
        .filter(
          (candidate) =>
            candidate.agent.id !== source.agent.id &&
            candidate.agent.status === "ACTIVE" &&
            regionOf(candidate.agent) !== null &&
            regionOf(candidate.agent) === regionOf(source.agent)
        )
        .sort((a, b) => a.load - b.load || a.agent.agentKey.localeCompare(b.agent.agentKey));
      const chosen = candidates.find(
        (candidate) => (candidate.owned.length + 1) / candidate.agent.capacity <= 0.85
      );
      if (!chosen) break; // nowhere legal to move — plan stops honestly

      const fromLoad = source.load;
      source.owned = source.owned.filter((d) => d.deviceId !== victim.deviceId);
      chosen.owned.push(victim);
      source.load = source.agent.capacity > 0 ? source.owned.length / source.agent.capacity : 1;
      chosen.load = chosen.agent.capacity > 0 ? chosen.owned.length / chosen.agent.capacity : 1;

      moves.push({
        deviceId: victim.deviceId,
        hostname: victim.hostname,
        fromAgentId: source.agent.id,
        fromAgentKey: source.agent.agentKey,
        fromLoad: round2(fromLoad),
        toAgentId: chosen.agent.id,
        toAgentKey: chosen.agent.agentKey,
        toLoad: round2(chosen.load),
        reason: "over-capacity",
      });
    }
  }

  return moves;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* RealRebalanceMove is structurally a RebalanceMove (plus agentKey context),
 * so planFingerprint (re-exported above) fingerprints real plans directly. */

/* ───────────────────────────── Error type ───────────────────────────────── */

export class CollectorControlError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CollectorControlError";
    this.code = code;
    this.status = status;
  }
}
