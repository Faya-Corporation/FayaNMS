import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { requireServiceOrPermission } from "@/lib/auth/service-auth";
import { authErrorToFail } from "@/lib/auth/session";
import {
  METRICS_RETENTION_KEY,
  parseStoredRetention,
  pruneMetricRollupsChunked,
  pruneMetricSamplesChunked,
  readRetentionSetting,
} from "@/lib/performance/retention";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/metrics/retention/prune (Task 6-a)
 *
 * Runs metric retention NOW according to the "metrics.retention" policy:
 *   - MetricSample   ts < now − raw.days      (when raw.enabled)
 *   - MetricRollup   granularity 5M  ts < now − rollup5M.days
 *   - MetricRollup   granularity 1H  ts < now − rollup1H.days
 *   - MetricRollup   granularity 1D  ts < now − rollup1D.days
 *
 * Returns counts { metricSamplesDeleted, rollup5MDeleted, rollup1HDeleted,
 * rollup1DDeleted, durationMs } and persists lastPrunedAt + lastPruneResult
 * into the SAME Setting row (so the UI survives restarts). Audits
 * METRIC_RETENTION_PRUNED (RET-XXXXXX correlation; actor "Admin" for manual
 * runs, "system:metrics-worker" when triggered by the worker job).
 *
 * RT-015 (F-017): every delete runs in BOUNDED CHUNKS (≤ 1,000 rows per
 * statement, ≤ 50,000 rows per run — see METRIC_RETENTION_CHUNK_SIZE /
 * METRIC_RETENTION_MAX_DELETES_PER_RUN), so a first run after enabling or
 * after a long gap cannot hold one giant DELETE transaction. If a backlog
 * larger than the per-run cap remains, the next prune (60 s-throttled manual
 * retry or the daily METRIC_RETENTION job) converges it.
 *
 * Guard: at most one prune per 60 s (ADR-01 — Redis-free; in-memory
 * timestamp + the persisted lastPrunedAt as a restart-safe fallback).
 * A throttled run answers 429 PRUNE_THROTTLED; the worker treats that as a
 * graceful no-op (job SUCCEEDED with outcome "throttled").
 */

const bodySchema = z
  .object({
    triggeredBy: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/** In-memory single-prune timestamp (module scope, per server process). */
let lastPruneStartedAtMs: number | null = null;
const THROTTLE_MS = 60_000;

export async function POST(request: Request) {
  // P19 SEC-002 — dual gate: the worker scheduler drives this with a service
  // JWT; the admin UI's "Prune now" drives it with a session holding the
  // "metrics.prune" permission (admin via "*"). Anonymous calls: 401.
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
  const triggeredBy = parsed.data.triggeredBy;

  const now = new Date();

  // ── 60 s throttle (in-memory + restart-safe persisted fallback) ──────
  const setting = await readRetentionSetting();
  const stored = parseStoredRetention(setting?.valueJson);
  const storedMs = stored.lastPrunedAt ? Date.parse(stored.lastPrunedAt) : Number.NaN;
  const lastMs =
    lastPruneStartedAtMs ?? (Number.isFinite(storedMs) ? storedMs : null);
  if (lastMs !== null && now.getTime() - lastMs < THROTTLE_MS) {
    const retryInSec = Math.ceil((THROTTLE_MS - (now.getTime() - lastMs)) / 1000);
    return fail(
      "PRUNE_THROTTLED",
      `A metric retention prune ran less than 60 s ago — retry in ${retryInSec}s`,
      429
    );
  }
  lastPruneStartedAtMs = now.getTime();

  // ── retention policy (days → cutoffs) ────────────────────────────────
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);

  const startedAt = Date.now();
  const metricSamplesDeleted = stored.raw.enabled
    ? await pruneMetricSamplesChunked(cutoff(stored.raw.days))
    : 0;
  const rollup5MDeleted = stored.rollup5M.enabled
    ? await pruneMetricRollupsChunked("5M", cutoff(stored.rollup5M.days))
    : 0;
  const rollup1HDeleted = stored.rollup1H.enabled
    ? await pruneMetricRollupsChunked("1H", cutoff(stored.rollup1H.days))
    : 0;
  const rollup1DDeleted = stored.rollup1D.enabled
    ? await pruneMetricRollupsChunked("1D", cutoff(stored.rollup1D.days))
    : 0;
  const durationMs = Date.now() - startedAt;

  const result = {
    metricSamplesDeleted,
    rollup5MDeleted,
    rollup1HDeleted,
    rollup1DDeleted,
    durationMs,
  };

  // ── persist bookkeeping into the same Setting row ────────────────────
  const prunedAt = now.toISOString();
  const updated = {
    ...stored,
    lastPrunedAt: prunedAt,
    lastPruneResult: { ...result, prunedAt, triggeredBy: triggeredBy ?? "MANUAL" },
  };

  const correlationId = newCorrelationId("RET");
  const afterJson = JSON.stringify(updated);

  await db.$transaction(
    async (tx) => {
      await tx.setting.upsert({
        where: { key: METRICS_RETENTION_KEY },
        update: { valueJson: afterJson },
        create: { key: METRICS_RETENTION_KEY, valueJson: afterJson },
      });
      await tx.auditEvent.create({
        data: {
          actorName: triggeredBy ? "system:metrics-worker" : "Admin",
          action: "METRIC_RETENTION_PRUNED",
          resourceType: "Setting",
          resourceId: METRICS_RETENTION_KEY,
          resourceLabel: "Metric retention prune",
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({ ...result, triggeredBy: triggeredBy ?? "MANUAL" }),
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(result);
}
