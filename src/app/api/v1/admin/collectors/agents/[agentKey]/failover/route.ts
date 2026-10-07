import { z } from "zod";

import { fail, firstIssueMessage, ok } from "../../../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import {
  CollectorControlError,
  failoverAgent,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/agents/[agentKey]/failover — REAL collector
 * control plane (GA-4b). Operator-forced failover: EVERY assignment owned
 * by the agent moves to the deterministic peer (same region → same site →
 * any; most capacity first), each row's lease epoch bumps (the failing
 * agent's next heartbeat is fenced), optionally suspending the agent.
 * With no peer the response honestly reports toAgentKey:null and ownership
 * stays with the silent agent (never silently dropped).
 * ───────────────────────────────────────────────────────────────────────────── */

const failoverSchema = z.object({
  reason: z.enum(["manual", "heartbeat-timeout"]).default("manual"),
  suspendAgent: z.boolean().default(false),
});

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

  let body: unknown;
  try {
    body = await request.json().catch(() => ({}));
  } catch {
    body = {};
  }
  const parsed = failoverSchema.safeParse(body ?? {});
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  try {
    const result = await failoverAgent(
      actor.name ?? actor.email,
      agentKey,
      parsed.data.reason,
      { suspendAgent: parsed.data.suspendAgent }
    );
    return ok(
      {
        ...result,
        note:
          result.toAgentKey === null
            ? "No failover peer available — ownership stays with the agent (visible in the agents list as silent); register a peer and re-run"
            : `Ownership moved to ${result.toAgentKey}; the agent's stale-epoch claims are fenced`,
      },
      { actor: actor.name ?? actor.email, plane: "real" },
      200
    );
  } catch (error) {
    if (error instanceof CollectorControlError) {
      return fail(error.code, error.message, error.status);
    }
    throw error;
  }
}
