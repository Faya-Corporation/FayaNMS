import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";
import { requireServiceOrPermission } from "@/lib/auth/service-auth";
import { authErrorToFail } from "@/lib/auth/session";
import { runRollupAggregation } from "@/lib/performance/rollup";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/metrics/rollup/aggregate (RT-002)
 *
 * Runs ONE bounded rollup aggregation pass NOW: aggregates closed
 * 5M/1H/1D buckets from raw MetricSamples into MetricRollup (see
 * src/lib/performance/rollup.ts). This is the runtime producer the
 * pipeline was missing — dashboards, performance views, the capacity
 * forecast and reports keep reading the same table, which finally gets
 * fresh rows without the demo seed.
 *
 * Returns the RollupSummary { ranAt, triggeredBy, groupsComputed,
 * groupsUpserted, remaining, bounded, byGranularity, durationMs } and
 * audits ROLLUP_AGGREGATION_COMPLETED (one row per run). The first run
 * after deploy IS the backfill: the bounded oldest-first loop converges
 * over consecutive ticks — monitor `remaining` instead of disabling.
 *
 * Guard: at most one aggregation in flight per server process (module-scope
 * in-flight flag, same style as the 60 s prune throttle). An overlapping
 * run answers 429 ROLLUP_THROTTLED; the worker treats that as a graceful
 * no-op (job SUCCEEDED with outcome "throttled").
 */

const bodySchema = z
  .object({
    jobId: z.string().trim().min(1).max(64).optional(),
    triggeredBy: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/** Module-scope single-run flag (per server process). */
let rollupRunInFlight = false;

export async function POST(request: Request) {
  // P19 SEC-002 — dual gate, identical shape to metrics/retention/prune:
  // the worker scheduler drives this with a service JWT ("metrics" scope);
  // the admin UI drives it with a session holding "metrics.prune".
  // Anonymous calls: 401.
  try {
    await requireServiceOrPermission(request, "metrics.prune", "metrics");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { jobId, triggeredBy } = parsed.data;

  if (rollupRunInFlight) {
    return fail(
      "ROLLUP_THROTTLED",
      "A rollup aggregation is already in flight — retry after it finishes",
      429
    );
  }
  rollupRunInFlight = true;
  try {
    const summary = await runRollupAggregation({
      triggeredBy: triggeredBy ?? (jobId ? "JOB" : "MANUAL"),
    });
    return ok(summary);
  } finally {
    rollupRunInFlight = false;
  }
}
