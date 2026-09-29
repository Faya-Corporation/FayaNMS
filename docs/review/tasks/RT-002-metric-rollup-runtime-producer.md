# RT-002 — MetricRollup runtime producer: aggregate MetricSample → MetricRollup on a schedule

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-002 | A3-02 | P1 | M | Medium — adds a new recurring job type + a new evaluate-in-Next route; must be idempotent and bounded; readers (dashboard/performance/reports) must keep working unchanged |

## Problem & evidence

- `prisma/schema.prisma:723` — `model MetricRollup` (`@@unique([deviceId, metric, granularity, periodStart])`).
- Sole writer found: `prisma/seed.ts:1837` (`db.metricRollup.createMany`) — grep shows **zero** `metricRollup.create/upsert` anywhere in `src/` or `scripts/`; the worker runner has no ROLLUP job type (dispatch block `mini-services/worker/runner.ts:1108-1141`).
- Readers that consume the (demo-seeded, never refreshed) table: `src/lib/performance/core.ts:119-134` (`fetchRollups`), `src/app/api/v1/dashboard/route.ts:117-135` (`fetchTrend`), `devices/[id]/metrics`, `predictive`, `src/lib/reports/generate.ts:138/448`.

ADR-07 ("raw samples + rollups emulate Timescale") is half-built: in any unseeded deployment every 24H/7D/30D performance view, the capacity forecast, availability/CAPACITY reports and the dashboard utilization trend read an empty/stale table, and retention then prunes the seed rows away.

## Impact

Headline product surfaces (performance views, capacity forecast, availability/CAPACITY reports, dashboard trend) silently show demo-only or empty data in real deployments. ADR-07's retention story prunes the only rows that ever existed.

## Root cause

The aggregation pipeline was never implemented: there is no runtime job that upserts 5M/1H/1D windows from `MetricSample`, and no worker job type to drive it.

## Required change

Follow the existing evaluate-in-Next pattern end to end (mirror ALERT_EVALUATION + METRIC_RETENTION):

1. **Aggregation engine** — new `src/lib/performance/rollup.ts` exporting `runRollupAggregation(opts: { now: Date }): Promise<RollupSummary>`:
   - For each granularity (5M=300s, 1H=3600s, 1D=86400s buckets, UTC-aligned `periodStart`), aggregate closed buckets from `MetricSample` (`ts` within `[periodStart, periodStart + window)`), computing `avg/max/min/p95` per `(deviceId, metric, bucket)`; p95 = nearest-rank over the bucket's values.
   - Persist with `db.metricRollup.upsert` on the natural key `@@unique([deviceId, metric, granularity, periodStart])` — idempotent re-runs overwrite with the same numbers (use `create` inside `upsert`, `update` recompute; never blind `create`).
   - **Bounded work per run**: process at most N closed buckets per run (e.g. cap ~5,000 bucket-groups or a time budget of ~20 s, whichever first), oldest-first, and report `remaining` in the summary so the next scheduled run continues (backfill converges over ticks). Skip buckets whose window has not closed (`periodStart + window > now`).
   - One summary audit row per run (`ROLLUP_AGGREGATION_COMPLETED`, actor `system:metrics-worker`, `RET`-style correlation) — never one row per bucket.
   - Guard against overlap with a module-scope in-flight flag (same style as the 60 s throttle in `src/app/api/v1/metrics/retention/prune/route.ts:42-43`).
2. **Route** — new `POST /api/v1/metrics/rollup/aggregate` (`src/app/api/v1/metrics/rollup/aggregate/route.ts`), an exact copy of the gate shape of `src/app/api/v1/metrics/retention/prune/route.ts:45-55`: `requireServiceOrPermission(request, "metrics.prune", "metrics")` (reuse the same permission; do not invent a new one), body `{ jobId?, triggeredBy? }`, 429 `ROLLUP_THROTTLED` when a run is in flight. Returns the summary.
3. **Proxy + machine surface** — add `/api/v1/metrics/rollup/aggregate` to `MACHINE_EXACT_ROUTES` and to the session-exempt passthrough list in `src/proxy.ts:106-110` and `:154-168` (both lists — same as `metrics/retention/prune`).
4. **Scheduler** — in `src/app/api/v1/worker/tick/route.ts`: add `ROLLUP_AGGREGATION` enqueue helper (`enqueueRollupAggregation`) modeled on `enqueueMetricRetention` (lines 635-666) with its own cadence constant (recommended: every 5 min — `ROLLUP_DEDUPE_MIN = 5`, so fresh 5M buckets appear promptly; the in-flight/finished-window dedupe keeps it single). Call it next to `enqueueMetricRetention(now)` (line ~507); add `rollupEnqueued` to the tick response and to the route's doc header.
5. **Worker driver** — `mini-services/worker/runner.ts`: add a `ROLLUP_AGGREGATION` branch to `executeJob` (line ~1108) and to the claim `types` array (line ~1180), plus a `runRollupAggregationJob` that POSTs to `/api/v1/metrics/rollup/aggregate` with the claimed `jobId` and `triggeredBy: "JOB"` (copy `runMetricRetentionJob`, lines ~680-750, including its throttled-is-success handling and `completedByType` counters).
6. **First-run backfill** — the bounded oldest-first loop in step 1 IS the backfill (document it); no separate migration. Confirm `prisma/seed.ts:1837` stays as-is (demo data remains valid; runtime upserts simply overwrite overlapping buckets).

## Tests to add

File: `tests/audit/metric-rollup-producer.test.ts` (DB-backed like `tests/flow-retention-api.test.ts`; requires the local PostgreSQL on :5433 per `tests/_setup.ts`).

1. `aggregates closed 5M/1H/1D buckets from raw samples` — seed one device + CPU samples across 3 hours → run aggregation → assert one rollup row per (device, metric, granularity, closed bucket) with exact avg/max/min and correct p95.
2. `is idempotent on re-run` — run twice → row count unchanged, values identical (upsert path).
3. `never aggregates a bucket whose window has not closed` — sample inside the current open bucket → no rollup row for that bucket.
4. `bounded run reports remaining and converges` — seed more buckets than the per-run cap → first run reports `remaining > 0`; repeated runs drive it to 0.
5. `route rejects anonymous callers` — POST without a service JWT → 401 envelope (negative/permission case); wrong scope → 403.
6. `tick enqueues at most one ROLLUP_AGGREGATION per dedupe window` — two consecutive tick calls → `rollupEnqueued` 1 then 0.
7. `worker runner maps ROLLUP_AGGREGATION to the aggregate route` — assert the claim `types` list and the dispatch branch (source-level assertion like `tests/audit/*.test.ts` style).

## Acceptance criteria

- [ ] `grep -rn "metricRollup.upsert\|metricRollup.create" src/` finds the runtime producer (engine, not seed).
- [ ] Dashboard/performance/reports keep working with zero query changes (they read the same table).
- [ ] Re-runs are idempotent (natural-key upsert); no duplicate rollup rows possible (unique constraint unchanged).
- [ ] Per-run work is bounded (cap + remaining); long backfills cannot pin the DB.
- [ ] The route is service-JWT gated AND session-permission gated; anonymous access returns 401.
- [ ] Tick cadence + worker claim/dispatch wired; job visible in Job Center with a summary result.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/metric-rollup-producer.test.ts   # all new cases green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
```

## Rollout & rollback notes

Deploy-order safe: the route/worker additions are inert until the first tick enqueues a job; readers are untouched. Rollback = revert; leftover rollup rows are harmless (retention prunes them per policy). If the first production run backfills a large history, the bounded loop spreads it over several 5-min ticks by design — monitor the `remaining` field in the job result rather than disabling the job.


## Status

Fixed (fdb3dcf)
