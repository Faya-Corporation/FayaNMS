import { ok } from "../../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { reapExpiredLeases } from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/assignments/reap — REAL collector control
 * plane (GA-4b). Liveness sweep: ACTIVE agents silent past the lease TTL
 * are failed over (heartbeat-timeout); row-level expired leases whose owner
 * still heartbeats are re-targeted (quiet renewal on same target, epoch-
 * bumped move otherwise). Scheduled execution is a deploy-side cron on this
 * endpoint (documented external, same posture as the DR backup sidecar).
 * ───────────────────────────────────────────────────────────────────────────── */

export async function POST(request: Request) {
  let actor: Awaited<ReturnType<typeof requireRole>>;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const result = await reapExpiredLeases(actor.name ?? actor.email);
  return ok(
    {
      ...result,
      swept: result.failedOver.length,
      note:
        result.failedOver.length === 0 && result.retargetedRows === 0
          ? "Everything inside the lease TTL — nothing to reap"
          : `Failed over ${result.failedOver.length} silent agent(s); re-targeted ${result.retargetedRows} stale row(s)`,
    },
    { actor: actor.name ?? actor.email, plane: "real" },
    200
  );
}
