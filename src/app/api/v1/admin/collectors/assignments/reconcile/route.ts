import { fail, ok } from "../../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { reconcileAssignments } from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/admin/collectors/assignments/reconcile — REAL collector
 * control plane (GA-4b). Operator action: diff current ownership vs the
 * deterministic target plan over the CURRENT registered fleet and apply —
 * create missing rows, move mismatched ownership (epoch bump fences the old
 * owner), release rows with no possible owner. Siteless devices are NEVER
 * assigned (counted honestly). Idempotent: a second reconcile keeps.
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

  const result = await reconcileAssignments(actor.name ?? actor.email);
  return ok(
    {
      ...result,
      note:
        result.agents === 0
          ? "No ACTIVE registered agents — ownership released; register agents and reconcile again"
          : "Ownership matches the deterministic target plan (site-resident → peer-site → fallback-regional)",
    },
    { actor: actor.name ?? actor.email, plane: "real" },
    200
  );
}
