import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { isDemoMode, simulationDisabledFail } from "@/lib/demo/simulation-guard";
import { z } from "zod";
import {
  assignDevices,
  planFingerprint,
  planRebalance,
  REBALANCE_STAGE_SLEEP_MS,
  type CollectorRebalanceMeta,
  type DeviceAssignmentRow,
} from "@/lib/collectors/distribution";
import {
  COLLECTOR_LEASE_TTL_MS,
  planRealRebalance,
  type CollectorAgentRuntime,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/rebalance-plan — guarded deterministic
 * rebalance. Body: { dryRun: boolean, planId?: string }.
 *
 * GA-4b dual-plane honesty (P0-R06/P1-O01): the plane follows the fleet.
 *   REAL plane (≥1 ACTIVE registered agent):
 *     dryRun:true            → plan over the REAL ownership rows (preview)
 *     dryRun:false + planId  → ACTUALLY MOVES ownership rows (conditional
 *                              per-row updates, leaseEpoch bumped so stale
 *                              claimants are fenced), COLLECTOR_REBALANCE
 *                              audit rows per move + complete, then a fresh
 *                              read of the fleet. NO demo-mode gate and NO
 *                              staged sleeps: this is a real control-plane
 *                              operation, and planId freshness is now a
 *                              GENUINE staleness check (a real apply changes
 *                              the state, so a replayed planId goes 409).
 *   SIMULATED plane (no registered agents — demo/CI posture, unchanged):
 *     the GA-4 guarded simulation. The APPLY leg is a DOCUMENTED SIMULATION
 *     (staged audit rows — no real collector is redeployed); demo-mode gate
 *     (403 SIMULATION_DISABLED) precedes the plan computation so a balanced
 *     or empty fleet cannot mask the refusal with 404; the 3-min
 *     audit-as-event-store cooldown stays (the simulated plan is identical
 *     after an apply, so planId freshness alone could never gate it).
 * ───────────────────────────────────────────────────────────────────────────── */

const planSchema = z.object({
  dryRun: z.boolean(),
  planId: z.string().trim().min(8).max(16).optional(),
});

const APPLY_COOLDOWN_MS = 3 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadAssignments(): Promise<DeviceAssignmentRow[]> {
  const devices = await db.device.findMany({
    select: { id: true, hostname: true, status: true, site: { select: { code: true } } },
    orderBy: { hostname: "asc" },
  });
  return devices.map((device) => ({
    id: device.id,
    hostname: device.hostname,
    siteCode: device.site?.code ?? null,
    status: device.status,
  }));
}

async function activeRealFleet(): Promise<CollectorAgentRuntime[]> {
  const agents = await db.collectorAgent.findMany({
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
  });
  return agents.map((agent) => ({ ...agent, siteCode: null }));
}

export async function POST(request: Request) {

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = planSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { dryRun, planId } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): collector rebalancing is admin
  // administration — requireRole("admin") replaces resolveActingUser
  // (which was authentication-only and fell back to a hardcoded "Admin").
  // Applies before the plan computation so even previews are admin-gated.
  let actor: Awaited<ReturnType<typeof requireRole>>;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const realAgents = await activeRealFleet();
  if (realAgents.length > 0) {
    return realPlane(request, actor, realAgents, dryRun, planId);
  }
  return simulatedPlane(actor, dryRun, planId);
}

/* ───────────────────────────── REAL plane ────────────────────────────────── */

async function realPlane(
  _request: Request,
  actor: Awaited<ReturnType<typeof requireRole>>,
  agents: CollectorAgentRuntime[],
  dryRun: boolean,
  planId?: string
) {
  const [ownership, devices] = await Promise.all([
    db.collectorAssignment.findMany({
      select: {
        deviceId: true,
        agentId: true,
        device: { select: { hostname: true } },
      },
    }),
    db.device.findMany({
      select: {
        id: true,
        hostname: true,
        siteId: true,
        site: { select: { code: true, region: true } },
      },
      orderBy: { hostname: "asc" },
    }),
  ]);
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const fleet = agents.map((agent) => ({
    agent,
    owned: ownership
      .filter((row) => row.agentId === agent.id)
      .map((row) => ({
        deviceId: row.deviceId,
        hostname: row.device.hostname || deviceById.get(row.deviceId)?.hostname || "",
        online: true,
      })),
  }));

  const realMoves = planRealRebalance(fleet);
  const moves = realMoves.map((move) => ({
    deviceId: move.deviceId,
    hostname: move.hostname,
    fromAgentId: move.fromAgentKey,
    fromLoad: move.fromLoad,
    toAgentId: move.toAgentKey,
    toLoad: move.toLoad,
    reason: move.reason,
  }));

  if (moves.length === 0) {
    return fail(
      "COLLECTOR_NO_MOVES",
      "The real fleet is already balanced — no over-capacity agents, nothing to rebalance",
      404
    );
  }

  const freshPlanId = planFingerprint(moves);

  if (dryRun) {
    return ok(
      {
        plane: "real" as const,
        dryRun: true,
        planId: freshPlanId,
        moves,
        beforeAfter: {
          moved: moves.length,
          note: "Preview only — confirm with dryRun:false and this planId (real apply MOVES ownership rows)",
        },
      },
      { actor: "plan-preview", plane: "real" },
      200
    );
  }

  if (!planId || planId !== freshPlanId) {
    return fail(
      "COLLECTOR_PLAN_STALE",
      `Plan ${planId ?? "(missing)"} no longer matches the live ownership (current ${freshPlanId}) — re-run the preview`,
      409
    );
  }

  const actorName = actor.name ?? actor.email;
  const correlationId = newCorrelationId("COLL");
  const startedAt = Date.now();
  const agentIdByKey = new Map(agents.map((a) => [a.agentKey, a.id] as const));
  const agentByKey = new Map(agents.map((a) => [a.agentKey, a] as const));

  let applied = 0;
  let skippedConcurrent = 0;
  for (const [index, move] of realMoves.entries()) {
    const fromId = agentIdByKey.get(move.fromAgentKey);
    const toId = agentIdByKey.get(move.toAgentKey);
    if (!fromId || !toId) {
      skippedConcurrent += 1;
      continue;
    }
    // Conditional ownership move: matches only while the row is still owned
    // by the plan's source — a concurrent failover/rebalance wins and this
    // move is skipped honestly (never double-owned: deviceId @unique).
    // `via` is computed from the REAL residency of the target agent.
    const target = agentByKey.get(move.toAgentKey);
    const device = deviceById.get(move.deviceId);
    const via =
      target && device
        ? target.siteId && device.siteId && target.siteId === device.siteId
          ? "site-resident"
          : target.region && device.site?.region && target.region === device.site.region
            ? "peer-site"
            : "fallback-regional"
        : "fallback-regional";
    const movedCount = await db.collectorAssignment.updateMany({
      where: { deviceId: move.deviceId, agentId: fromId },
      data: {
        agentId: toId,
        via,
        leaseEpoch: { increment: 1 },
        leasedUntil: new Date(Date.now() + COLLECTOR_LEASE_TTL_MS),
        assignedBy: "rebalance",
      },
    });
    if (movedCount.count !== 1) {
      skippedConcurrent += 1;
      continue;
    }
    applied += 1;

    const meta: CollectorRebalanceMeta = {
      planId: freshPlanId,
      stage: "move",
      deviceId: move.deviceId,
      hostname: move.hostname,
      fromAgentId: move.fromAgentKey,
      toAgentId: move.toAgentKey,
      fromLoad: move.fromLoad,
      toLoad: move.toLoad,
      moveIndex: index + 1,
      totalMoves: realMoves.length,
    };
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "COLLECTOR_REBALANCE",
        resourceType: "CollectorAgent",
        resourceId: move.fromAgentKey,
        resourceLabel: `${move.hostname}: ${move.fromAgentKey} → ${move.toAgentKey}`,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify(meta),
      },
    });
  }

  const durationMs = Date.now() - startedAt;
  const completeMeta: CollectorRebalanceMeta = {
    planId: freshPlanId,
    stage: "complete",
    totalMoves: realMoves.length,
    durationMs,
  };
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName,
      action: "COLLECTOR_REBALANCE",
      resourceType: "CollectorAgent",
      resourceId: "fleet",
      resourceLabel: `Rebalance plan ${freshPlanId} — ${applied}/${realMoves.length} ownership move(s)`,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({ ...completeMeta, applied, skippedConcurrent, plane: "real" }),
    },
  });

  return ok(
    {
      plane: "real" as const,
      dryRun: false,
      planId: freshPlanId,
      correlationId,
      moved: applied,
      skippedConcurrent,
      durationMs,
      note: "REAL apply — ownership rows moved with lease-epoch bumps; stale claimants are fenced",
    },
    { actor: actorName, plane: "real" },
    200
  );
}

/* ────────────────────────── SIMULATED plane (unchanged) ──────────────────── */

async function simulatedPlane(
  actor: Awaited<ReturnType<typeof requireRole>>,
  dryRun: boolean,
  planId?: string
) {
  // P0-R05/P1-O02 (GA re-audit 2026-10-06): the APPLY leg is a
  // DOCUMENTED SIMULATION (staged audit rows — no real collector is
  // redeployed). Demo-mode-gated BEFORE the plan computation: a balanced
  // or empty fleet must not mask the simulation refusal with 404
  // COLLECTOR_NO_MOVES (that is a plan outcome, not an authz one). The
  // dryRun preview stays available in a production posture.
  if (!dryRun && !isDemoMode()) {
    const disabled = simulationDisabledFail();
    return fail(disabled.code, disabled.message, disabled.status);
  }

  const rows = await loadAssignments();
  const assignments = assignDevices(rows);
  const moves = planRebalance(assignments);

  if (moves.length === 0) {
    return fail(
      "COLLECTOR_NO_MOVES",
      "The fleet is already balanced — no over-capacity agents, nothing to rebalance",
      404
    );
  }

  // Audit-as-event-store cooldown (same pattern as HA failover tests): the
  // plan is a NON-destructive simulation, so the recomputed plan after an
  // apply is identical — without a cooldown an identical planId would pass
  // the staleness check forever. The newest apply row must be ≥ 3 min old.
  if (!dryRun) {
    // The simulation gate already fired above (before the plan
    // computation); what remains here is the audit-as-event-store cooldown.
    const latestApply = await db.auditEvent.findFirst({
      where: { action: "COLLECTOR_REBALANCE" },
      select: { correlationId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    if (
      latestApply &&
      Date.now() - latestApply.createdAt.getTime() < APPLY_COOLDOWN_MS
    ) {
      const waitSec = Math.max(
        1,
        Math.ceil(
          (APPLY_COOLDOWN_MS - (Date.now() - latestApply.createdAt.getTime())) /
            1000
        )
      );
      return fail(
        "COLLECTOR_REBALANCE_COOLDOWN",
        `A rebalance ran less than 3 minutes ago (${latestApply.correlationId ?? "no correlation"}) — wait ${waitSec}s before re-applying`,
        409
      );
    }
  }

  const freshPlanId = planFingerprint(moves);

  if (dryRun) {
    return ok(
      {
        plane: "simulated" as const,
        dryRun: true,
        planId: freshPlanId,
        moves,
        beforeAfter: {
          moved: moves.length,
          note: "Preview only — confirm with dryRun:false and this planId",
        },
      },
      { actor: "plan-preview", plane: "simulated" },
      200
    );
  }

  if (!planId || planId !== freshPlanId) {
    return fail(
      "COLLECTOR_PLAN_STALE",
      `Plan ${planId ?? "(missing)"} no longer matches the live assignment (current ${freshPlanId}) — re-run the preview`,
      409
    );
  }

  const actorName = actor.name ?? actor.email;
  const correlationId = newCorrelationId("COLL");
  const startedAt = Date.now();
  const stageLog: { stage: string; hostname: string | null; at: string }[] = [];

  for (const [index, move] of moves.entries()) {
    await sleep(REBALANCE_STAGE_SLEEP_MS);
    const meta: CollectorRebalanceMeta = {
      planId: freshPlanId,
      stage: "move",
      deviceId: move.deviceId,
      hostname: move.hostname,
      fromAgentId: move.fromAgentId,
      toAgentId: move.toAgentId,
      fromLoad: move.fromLoad,
      toLoad: move.toLoad,
      moveIndex: index + 1,
      totalMoves: moves.length,
    };
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "COLLECTOR_REBALANCE",
        resourceType: "CollectorAgent",
        resourceId: move.fromAgentId,
        resourceLabel: `${move.hostname}: ${move.fromAgentId} → ${move.toAgentId}`,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify(meta),
      },
    });
    stageLog.push({ stage: `move ${index + 1}/${moves.length}`, hostname: move.hostname, at: new Date().toISOString() });
  }

  const durationMs = Date.now() - startedAt;
  const completeMeta: CollectorRebalanceMeta = {
    planId: freshPlanId,
    stage: "complete",
    totalMoves: moves.length,
    durationMs,
  };
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName,
      action: "COLLECTOR_REBALANCE",
      resourceType: "CollectorAgent",
      resourceId: "fleet",
      resourceLabel: `Rebalance plan ${freshPlanId} — ${moves.length} move(s)`,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify(completeMeta),
    },
  });

  return ok(
    {
      plane: "simulated" as const,
      dryRun: false,
      planId: freshPlanId,
      correlationId,
      moved: moves.length,
      durationMs,
      stages: stageLog,
      note: "Simulated apply — staged audit rows only, no real collector was redeployed",
    },
    { actor: actorName, plane: "simulated" },
    200
  );
}
