import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/worker/status — worker reachability + last claim time.
 *
 * F-033 (audit A1-11): this route is a UI-FACING human diagnostic —
 * service-auth.ts's own contract doc lists it as excluded from the machine
 * plane — but it shipped with NO auth check, so any valid service JWT (or
 * any anonymous caller) could read it. Now gated:
 *   - any `Authorization: Bearer …` is refused 403 HUMAN_SESSION_REQUIRED
 *     (the machine plane authenticates on /worker/* MUTATION routes; this
 *     read surface must never be drivable by a machine principal);
 *   - human callers need an active session holding the "job.read"
 *     permission (admin/operator/engineer per ROLE_MATRIX).
 * Proxies GET ${WORKER_BASE_URL}/health with a 2 s timeout (backend-to-
 * backend; runbook T5 — env-configurable, default http://localhost:3030).
 * Never throws: when the worker is down the response is
 * { workerReachable: false, workerHealth: null, lastClaimAt }.
 *
 * lastClaimAt is stored in the Setting table under key "worker.lastClaimAt"
 * (written by /api/v1/worker/claim when at least one job is claimed). If the
 * setting is absent it falls back to the startedAt of the most recent RUNNING
 * CONFIG_BACKUP job.
 */

const WORKER_HEALTH_URL = `${WORKER_BASE_URL}/health`;

export async function GET(req: Request) {
  // F-033 — explicit machine-principal refusal BEFORE the session path so a
  // valid service JWT gets a precise 403 (not a generic 401 session prompt).
  if (/^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "")) {
    return fail(
      "HUMAN_SESSION_REQUIRED",
      "Worker status is a human diagnostic — bearer tokens (service JWTs, API clients) are not accepted on this route.",
      403
    );
  }
  try {
    await requirePermission(req, "job.read");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let workerReachable = false;
  let workerHealth: unknown = null;

  try {
    const res = await fetch(WORKER_HEALTH_URL, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    if (res.ok) {
      workerHealth = await res.json();
      workerReachable = true;
    }
  } catch {
    /* worker down — reported gracefully below */
  }

  let lastClaimAt: string | null = null;
  const setting = await db.setting.findUnique({ where: { key: "worker.lastClaimAt" } });
  if (setting) {
    try {
      const parsed: unknown = JSON.parse(setting.valueJson);
      if (typeof parsed === "string") lastClaimAt = parsed;
    } catch {
      /* ignore malformed setting */
    }
  }
  if (!lastClaimAt) {
    const lastRunning = await db.jobExecution.findFirst({
      where: { status: "RUNNING", type: "CONFIG_BACKUP", startedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    lastClaimAt = lastRunning?.startedAt?.toISOString() ?? null;
  }

  return ok({ workerReachable, workerHealth, lastClaimAt });
}
