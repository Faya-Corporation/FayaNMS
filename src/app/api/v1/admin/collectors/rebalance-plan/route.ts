import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok, requestContext } from "../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { z } from "zod";
import {
  assignDevices,
  planFingerprint,
  planRebalance,
  REBALANCE_STAGE_SLEEP_MS,
  type CollectorRebalanceMeta,
  type DeviceAssignmentRow,
} from "@/lib/collectors/distribution";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/rebalance-plan — guarded deterministic
 * rebalance (Phase 15-b). Body: { dryRun: boolean, planId?: string }.
 *
 * Two-step guarded flow (same pattern as POST /api/v1/ha/failover-test):
 *   dryRun: true            → plan preview ONLY, no audit rows written
 *   dryRun: false + planId  → verifies planId matches a FRESH recomputation
 *                             (409 COLLECTOR_PLAN_STALE on drift), then
 *                             writes ONE COLLECTOR_REBALANCE audit row per
 *                             move plus a final complete row with a shared
 *                             correlationId (COLL-XXXXXX) — audit-as-event-
 *                             store, no schema, no worker.
 *   404 COLLECTOR_NO_MOVES  — the plan is empty (fleet already balanced).
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

export async function POST(request: Request) {
  const ctx = requestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
  }

  const parsed = planSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
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

  const rows = await loadAssignments();
  const assignments = assignDevices(rows);
  const moves = planRebalance(assignments);

  if (moves.length === 0) {
    return fail(
      "COLLECTOR_NO_MOVES",
      "The fleet is already balanced — no over-capacity agents, nothing to rebalance",
      404,
      ctx
    );
  }

  // Audit-as-event-store cooldown (same pattern as HA failover tests): the
  // plan is a NON-destructive simulation, so the recomputed plan after an
  // apply is identical — without a cooldown an identical planId would pass
  // the staleness check forever. The newest apply row must be ≥ 3 min old.
  if (!dryRun) {
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
        409,
        ctx
      );
    }
  }

  const freshPlanId = planFingerprint(moves);

  if (dryRun) {
    return ok(
      {
        dryRun: true,
        planId: freshPlanId,
        moves,
        beforeAfter: {
          moved: moves.length,
          note: "Preview only — confirm with dryRun:false and this planId",
        },
      },
      { actor: "plan-preview" },
      200,
      ctx
    );
  }

  if (!planId || planId !== freshPlanId) {
    return fail(
      "COLLECTOR_PLAN_STALE",
      `Plan ${planId ?? "(missing)"} no longer matches the live assignment (current ${freshPlanId}) — re-run the preview`,
      409,
      ctx
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
      dryRun: false,
      planId: freshPlanId,
      correlationId,
      moved: moves.length,
      durationMs,
      stages: stageLog,
      note: "Simulated apply — staged audit rows only, no real collector was redeployed",
    },
    { actor: actorName },
    200,
    ctx
  );
}
