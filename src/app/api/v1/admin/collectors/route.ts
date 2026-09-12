import { db } from "@/lib/db";
import { ok, requestContext } from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";
import { WORKER_BASE_URL, WORKER_HOST } from "@/lib/worker/worker-url";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/collectors (Task 7-b)
 *
 * Live collector registry. The FayaNMS "collectors" are the in-sandbox
 * workers: the bun mini-service (runbook T5 — WORKER_BASE_URL, default
 * loopback :3030) plus the logical engines that run inside it / the Next.js
 * API (alert evaluation, metric retention, backup).
 *
 * GET — server-side:
 *   1. fetch worker /health (3 s timeout; unreachable → OFFLINE row),
 *   2. upsert the worker Collector row (kind POLLER) with uptime + job
 *      counters, and one row per observed JobExecution job type mapped to
 *      a logical collector kind,
 *   3. return every Collector row (DB rows persist the last known state
 *      even when the worker is down).
 */

const WORKER_HEALTH_URL = `${WORKER_BASE_URL}/health`;

const KIND_BY_JOB_TYPE: Record<string, string> = {
  CONFIG_BACKUP: "CONFIG_COLLECTOR",
  DRIFT_CHECK: "CONFIG_COLLECTOR",
  ALERT_EVALUATION: "ALERT_ENGINE",
  METRIC_RETENTION: "RETENTION",
  CHANGE_EXECUTE: "CONFIG_COLLECTOR",
  DISCOVERY: "POLLER",
};

const LOGICAL_NAMES: Record<string, string> = {
  POLLER: "worker-1",
  CONFIG_COLLECTOR: "config-collector",
  ALERT_ENGINE: "alert-engine",
  RETENTION: "retention-engine",
};

interface WorkerHealth {
  ok?: boolean;
  uptimeSec?: number;
  jobs?: {
    claimed?: number;
    completed?: number;
    failed?: number;
    running?: number;
    completedByType?: Record<string, number>;
  };
}

function capabilitiesFor(jobTypes: string[]): string[] {
  return Array.from(new Set(jobTypes.map((t) => KIND_BY_JOB_TYPE[t] ?? t)));
}

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);

    // 1 — probe the worker (bounded; never let a dead worker 500 this route)
    let health: WorkerHealth | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(WORKER_HEALTH_URL, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeout);
      if (response.ok) health = (await response.json()) as WorkerHealth;
    } catch {
      health = null;
    }

    const now = new Date();
    const byType = health?.jobs?.completedByType ?? {};
    const jobTypes = Object.keys(byType);
    const jobsCompleted = Object.values(byType).reduce((a, b) => a + b, 0);

    // 2 — upsert the worker row + one logical row per observed engine
    const upserts: {
      name: string;
      kind: string;
      status: string;
      capabilitiesJson: string;
      host: string | null;
      lastSeenAt: Date | null;
      statsJson: string | null;
    }[] = [];

    upserts.push({
      name: "worker-1",
      kind: "POLLER",
      status: health ? "ONLINE" : "OFFLINE",
      capabilitiesJson: JSON.stringify(capabilitiesFor(jobTypes)),
      host: WORKER_HOST,
      lastSeenAt: health ? now : null,
      statsJson: JSON.stringify({
        uptimeSec: health?.uptimeSec ?? null,
        jobsCompleted,
        jobsClaimed: health?.jobs?.claimed ?? null,
        jobsFailed: health?.jobs?.failed ?? null,
        jobsRunning: health?.jobs?.running ?? null,
      }),
    });

    for (const [kind, name] of Object.entries(LOGICAL_NAMES)) {
      if (kind === "POLLER") continue; // worker-1 above
      const types = jobTypes.filter((t) => KIND_BY_JOB_TYPE[t] === kind);
      if (types.length === 0) continue;
      const count = types.reduce((a, t) => a + (byType[t] ?? 0), 0);
      upserts.push({
        name,
        kind,
        status: health ? "ONLINE" : "OFFLINE",
        capabilitiesJson: JSON.stringify(types),
        host: kind === "ALERT_ENGINE" ? "next-api (evaluate-in-Next)" : WORKER_HOST,
        lastSeenAt: health ? now : null,
        statsJson: JSON.stringify({ jobsCompleted: count }),
      });
    }

    for (const row of upserts) {
      await db.collector.upsert({
        where: { name: row.name },
        update: {
          kind: row.kind,
          status: row.status,
          capabilitiesJson: row.capabilitiesJson,
          lastSeenAt: row.lastSeenAt,
          statsJson: row.statsJson,
        },
        create: row,
      });
    }

    // 3 — full registry (DB rows are the source of truth for the view)
    const rows = await db.collector.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
    const collectors = rows.map((row) => {
      let capabilities: string[] = [];
      let stats: Record<string, unknown> = {};
      try {
        const parsedCaps: unknown = JSON.parse(row.capabilitiesJson);
        if (Array.isArray(parsedCaps)) {
          capabilities = parsedCaps.filter((c): c is string => typeof c === "string");
        }
      } catch {
        capabilities = [];
      }
      try {
        const parsedStats: unknown = JSON.parse(row.statsJson ?? "{}");
        if (parsedStats && typeof parsedStats === "object" && !Array.isArray(parsedStats)) {
          stats = parsedStats as Record<string, unknown>;
        }
      } catch {
        stats = {};
      }
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        capabilities,
        host: row.host,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        stats,
      };
    });

    return ok(
      {
        collectors,
        workerReachable: Boolean(health),
      },
      {
        online: collectors.filter((c) => c.status === "ONLINE").length,
        total: collectors.length,
      },
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
