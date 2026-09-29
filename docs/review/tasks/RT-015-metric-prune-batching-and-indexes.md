# RT-015 — Batched metric prune + additive index migration (MetricRollup + Device.mgmtIp)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-017 | A3-08 | P2 | S | Medium — touches the retention prune loop + ships a migration; index creation must be additive and non-blocking at deploy |
| F-049 | A3-13 | P3 (linked) | S | (covered by the same migration) |
| F-050 | A3-14 | P3 (linked) | S | (covered by the same migration) |

Shared migration deliberately groups all three index findings (binding scope decision): one additive migration, three findings closed.

## Problem & evidence

- `src/app/api/v1/metrics/retention/prune/route.ts:91-108` — `db.metricSample.deleteMany({ where: { ts: { lt: cutoff } } })`: ONE unbounded DELETE. First prune after enabling (or after a gap) deletes millions of MetricSample rows in a single statement → long transaction, lock pressure, vacuum/bloat. Contrast: flow retention prunes in 1,000-row chunks (`src/lib/flows/retention.ts:6-7`, loop in `src/app/api/v1/flows/retention/prune/route.ts:46-64`).
- Rollup deletes (lines 94-108) filter `granularity + periodStart` with no matching index — `MetricRollup`'s only index leads with `deviceId` (`@@unique([deviceId, metric, granularity, periodStart])`, `prisma/schema.prisma:723-737`) → 3 sequential scans per run.
- F-049: `Device` (schema lines 122-195) has no `mgmtIp` index while the per-event hot path does `db.device.findFirst({ where: { mgmtIp } })` (`src/app/api/v1/ingest/protocol/route.ts:76`) and `worker/discovery/reconcile/route.ts:85` (`mgmtIp: { in: ips }`) → seq scan per ingested event.
- F-050: `fetchRollups` (`src/lib/performance/core.ts:119-134`) and the dashboard trend (`src/app/api/v1/dashboard/route.ts:117-135`) filter `granularity (+ metric) + periodStart` without `deviceId` → sequential scans on every dashboard load; compounds once RT-002 creates real rollup volume.

## Impact

Long-lock prune transactions on big tables; per-event and per-page-load sequential scans that degrade with fleet size/retention volume.

## Root cause

Prune written as a single statement; three hot predicates left without supporting indexes (the 101 existing `@@index` declarations missed these).

## Required change

1. **Migration (one, additive-only)** — `prisma/migrations/2026xxxx_rt015_hot_path_indexes/migration.sql` (+ update `prisma/schema.prisma` to match):
   - `CREATE INDEX "MetricRollup_granularity_periodStart_idx" ON "MetricRollup"("granularity", "periodStart");` — serves the prune (F-017) and fetchRollups' `granularity + periodStart` (F-050); optionally `(granularity, metric, periodStart)` to also cover F-050's `metric IN (...)` — prefer the 3-column order `(granularity, metric, periodStart)` since both readers filter granularity, and the prune filters granularity+periodStart (still index-served via the leading column + filter).
   - `CREATE INDEX "Device_mgmtIp_idx" ON "Device"("mgmtIp");` — NON-unique (duplicates are legal today per A3-13).
   - Corresponding schema edits: `@@index([granularity, metric, periodStart])` on `MetricRollup` (line ~736) and `@@index([mgmtIp])` on `Device` (line ~195).
   - Additive only (CREATE INDEX; PostgreSQL supports `CREATE INDEX CONCURRENTLY` but Prisma migrations run in a transaction — plain CREATE INDEX is acceptable at this table scale; note in the migration comment that the first staging deploy holds a brief lock). Follow the naming style of existing migrations (inspect `prisma/migrations/20260923010000_netflow_v5_records/migration.sql`).
   - `migration_lock.toml` already postgresql — no change.
2. **Batched prune** — `src/app/api/v1/metrics/retention/prune/route.ts`:
   - Import/define `METRIC_RETENTION_CHUNK_SIZE = 1_000`, `METRIC_RETENTION_MAX_DELETES_PER_RUN = 50_000` (module scope or `src/lib/performance/retention.ts` next to `METRICS_RETENTION_KEY`).
   - Replace the single `metricSample.deleteMany` (line 91-93) with the flow-retention loop pattern: `for (let batch = 0; batch < MAX/CHUNK; batch++) { const ids = await db.metricSample.findMany({ where: { ts: { lt: cutoff } }, orderBy: [{ ts: "asc" }, { id: "asc" }], take: CHUNK, select: { id: true } }); if (!ids.length) break; deleted += (await db.metricSample.deleteMany({ where: { id: { in: ids.map(i => i.id) }, ts: { lt: cutoff } } })).count; }` — status-guard not needed (ts-guarded delete keeps the CAS spirit; a row that gained a NEWER sample is a different row).
   - Apply the same chunk loop to the three rollup deletes (each granularity separately, using the new index). Keep the response fields (`metricSamplesDeleted`, `rollup5MDeleted`, `rollup1HDeleted`, `rollup1DDeleted`, `durationMs`) and the Setting/audit bookkeeping exactly as-is; add `bounded: true`-style info only if free.
   - Keep the 60 s throttle unchanged — a bounded 50k-row run fits comfortably; if a huge backlog remains, the NEXT daily METRIC_RETENTION job continues (document this convergence in the route header).
3. **No reader changes** — `fetchRollups`/dashboard queries stay verbatim (the index serves them).

## Tests to add

File: `tests/audit/rt015-metric-prune-batching.test.ts` (DB-backed; index assertions via Prisma raw query or source checks).

1. `prune deletes in chunks and respects the per-run cap` — seed > MAX_DELETES_PER_RUN aged samples → first run deletes exactly MAX and reports it; second run continues (converges to 0 remaining).
2. `fresh samples survive the cutoff` — samples at/after cutoff untouched (negative case).
3. `rollup prunes per granularity with correct counts` — seed 5M/1H/1D rows across the windows → counts match the policy sections.
4. `migration is additive` — read the new migration SQL: only `CREATE INDEX` statements (no DROP/ALTER/NOT NULL); assert `schema.prisma` carries the two `@@index` entries (source assertions, style of `tests/audit/config-hygiene.test.ts`).
5. `indexes exist in the database` — `SELECT` from `pg_indexes` (or `db.$queryRaw`) for the two new index names after `db:deploy` (test skips cleanly if run without DB, mirroring the env-fail convention).

## Acceptance criteria

- [ ] Metric prune is chunked (≤ 1,000 rows/statement, ≤ 50,000/run) for samples AND rollups.
- [ ] One additive migration adds `MetricRollup(granularity, metric, periodStart)` and `Device(mgmtIp)` indexes; no destructive SQL.
- [ ] Prune response contract and Setting/audit bookkeeping unchanged.
- [ ] `prisma migrate deploy` applies cleanly on a populated staging DB (verify in staging runbook pass).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt015-metric-prune-batching.test.ts   # new suite green
bun test tests/audit/metric-rollup-producer.test.ts         # RT-002 peers green (if landed)
bun test tests/                                             # no regressions
node_modules/typescript/bin/tsc --noEmit                    # exit 0
bun run lint                                                # 0 errors
# Migration dry-check against the local DB:
DATABASE_URL=postgresql://fayanms:fayanms@localhost:5433/fayanms node_modules/prisma/build/index.js migrate deploy
```

## Rollout & rollback notes

Deploy order: migration first (`db:deploy` is the only migration path), then code — the code works with or without the indexes (batching is independent). Rollback of code = revert; do NOT drop the indexes (harmless, useful). DEPENDENCY: land this RT BEFORE the perf-sensitive RTs that benefit from it (RT-002 rollup volume, RT-018 monitoring validation) per REMEDIATION_PLAN.md ordering.
