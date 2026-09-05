import { db } from "@/lib/db";
import { ok } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/worker/status — worker reachability + last claim time.
 *
 * Proxies GET http://localhost:3030/health with a 2 s timeout (backend-to-
 * backend, same host). Never throws: when the worker is down the response is
 * { workerReachable: false, workerHealth: null, lastClaimAt }.
 *
 * lastClaimAt is stored in the Setting table under key "worker.lastClaimAt"
 * (written by /api/v1/worker/claim when at least one job is claimed). If the
 * setting is absent it falls back to the startedAt of the most recent RUNNING
 * CONFIG_BACKUP job.
 */

const WORKER_HEALTH_URL = "http://localhost:3030/health";

export async function GET() {
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
