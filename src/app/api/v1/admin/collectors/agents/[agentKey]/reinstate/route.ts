import { fail, ok } from "../../../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/agents/[agentKey]/reinstate — operator lift
 * of a SUSPENDED collector agent back to ACTIVE (FNM-2026-106, Wave R2).
 *
 * Why this route exists: registration NO LONGER reactivates suspended
 * agents (the old SUSPENDED → ACTIVE upsert let a suspended agent — or a
 * thief with a bound token — resurrect itself through the machine plane).
 * Suspension is now strictly operator-owned: set via failover
 * (suspendAgent:true), lifted ONLY here by an authenticated admin with an
 * audit record. A reinstated agent re-registers normally with its own bound
 * identity and reclaims ownership through the ordinary lease protocol.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ agentKey: string }> }
) {
  let actor: Awaited<ReturnType<typeof requireRole>>;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const { agentKey } = await ctx.params;
  if (!agentKey || !/^[A-Za-z0-9._:-]{3,120}$/.test(agentKey)) {
    return fail("INVALID_PARAMS", "agentKey path parameter is malformed", 400);
  }

  const agent = await db.collectorAgent.findUnique({
    where: { agentKey },
    select: { id: true, agentKey: true, displayName: true, status: true },
  });
  if (!agent) {
    return fail("COLLECTOR_AGENT_UNKNOWN", `No registered agent "${agentKey}"`, 404);
  }
  if (agent.status === "ACTIVE") {
    return fail(
      "COLLECTOR_AGENT_NOT_SUSPENDED",
      `Agent "${agentKey}" is already ACTIVE — nothing to reinstate`,
      409
    );
  }

  const previousStatus = agent.status;
  const updated = await db.$transaction([
    db.collectorAgent.update({
      where: { agentKey },
      data: { status: "ACTIVE" },
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "COLLECTOR_AGENT_REINSTATED",
        resourceType: "CollectorAgent",
        resourceId: agent.agentKey,
        resourceLabel: agent.displayName,
        result: "SUCCESS",
        afterJson: JSON.stringify({ from: previousStatus, to: "ACTIVE" }),
      },
    }),
  ]);

  return ok(
    {
      agentKey: updated[0].agentKey,
      status: updated[0].status,
      previousStatus,
      note: "Agent reinstated — it re-registers with its own bound identity and reclaims leases through the ordinary protocol",
    },
    { actor: actor.name ?? actor.email, plane: "real" },
    200
  );
}
