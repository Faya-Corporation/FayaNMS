# RT-016 — Backup snapshot prune: gate by due-ness (stop running every 30 s tick)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-018 | A3-09 | P2 | S/M | Low — adds a cadence guard + one set-based query; prune behavior itself unchanged when it does run |

## Problem & evidence

`src/app/api/v1/worker/tick/route.ts:607` — `const prune = await pruneRetention(policies, now);` runs on EVERY tick (30 s cadence), and `pruneRetention` (lines 178-291):
- line 189-201: per-policy `db.device.findMany` (scope resolution),
- lines 206-213: `configSnapshot.groupBy` (this one is already set-based),
- lines 218-259: per-device `configSnapshot.findMany` + `configSnapshot.count` — ≈2N+ queries per tick even when nothing is prunable.

Wasted DB load scaling O(devices × policies) every 30 s; snapshots are only ever prunable after daily retention windows move.

## Impact

Pure overhead: DB load 2,880×/day for work that can matter at most once/day per policy.

## Root cause

The prune call predates the cadence infrastructure the same file already uses for every other recurring job (METRIC_RETENTION/FLOW_RETENTION dedupe windows, lines 635-699).

## Required change

1. **Cadence gate** — `src/app/api/v1/worker/tick/route.ts`:
   - Add `const SNAPSHOT_PRUNE_DEDUPE_HOURS = 24;` next to the other constants (lines 92-100).
   - Gate the `pruneRetention(policies, now)` call (line 607) with the same check-then-skip pattern the enqueue helpers use: a Setting-based lastRun guard is preferred for restart safety — reuse the Setting shape style of `readRetentionSetting`/`METRICS_RETENTION_KEY` (`src/lib/performance/retention.ts`): key `"snapshots.retention"` storing `{ lastPrunedAt }`; skip when `now - lastPrunedAt < 24 h`. Write `lastPrunedAt` at the END of a run that actually executed (even when 0 rows were prunable — the gate is about CADENCE, not work done). Fall back to a module-scope in-memory timestamp like the metrics-prune route does (lines 42-43) — implement BOTH (in-memory primary, Setting fallback), matching the repo's established pattern.
   - Alternative accepted implementation: a `SNAPSHOT_RETENTION` JobExecution like FLOW_RETENTION — but that adds a job type + worker driver for a pruner that already runs evaluate-in-Next; the Setting guard is the minimal change. Choose the Setting guard (document the choice in the PR).
2. **Set-based candidate resolution** (the S/M half — keep it bounded):
   - Replace the per-device loop (lines 218-259)'s N×(findMany+count) with ONE query per prune run: fetch candidates for ALL cutoff devices in a single `configSnapshot.findMany({ where: { status: "HISTORICAL", OR: [...per-device (deviceId, createdAt < cutoff) branches...], id: { notIn: alreadyCollected } }, orderBy: [{ deviceId: "asc" }, { createdAt: "desc" }] })` — OR, simpler and equally correct: one `findMany` grouped fetch per tick budget using `groupBy` results already computed (lines 206-213) and per-device `take` applied in memory from one ordered query per device ONLY when the grouped totals say the device is over its keep-minimum. The binding requirement is: no per-device query UNLESS the device's grouped total shows deletable rows (`total - PRUNE_MIN_SNAPSHOTS_PER_DEVICE > 0` AND a candidate can exist past cutoff); devices that cannot prune are skipped with ZERO queries (today they still pay findMany+count via the `candidates.length === 0` path — line 239).
   - Keep `PRUNE_MAX_DELETES_PER_TICK`, the newest-HISTORICAL protection (lines 241-252), and the RT-011 cascade guard (once landed) fully intact — this RT must compose with RT-011, not rewrite it.
3. Response: keep `pruned`/`prunedDevices`; add `pruneSkipped: boolean` (cadence gate) to the tick response and note it in the route header doc block (lines 83-85 list the response fields).

## Tests to add

File: `tests/audit/rt016-prune-due-ness-gating.test.ts` (DB-backed, mirroring `tests/flow-retention.test.ts` style; invoke the tick route handler with a service JWT like existing tick tests do if present, else extract the gate into an exported helper and unit-pin it).

1. `second tick within the cadence window skips the prune` — run tick twice → second response `pruneSkipped: true`, `pruned: 0`, and NO per-device snapshot queries issued (assert via query-event count or by asserting the Setting lastRun write).
2. `prune runs again after the window elapses` — advance the Setting `lastPrunedAt` > 24 h → prune executes (negative case for over-gating).
3. `non-prunable devices issue zero candidate queries` — device with total ≤ keep-minimum → no findMany/count for it (the set-based guard); device with prunable rows still prunes correctly.
4. `prune semantics unchanged when due` — aged HISTORICAL snapshots beyond cutoff + keep-minimum are deleted; newest-HISTORICAL protection intact (regression guard vs. current behavior, and must stay green after RT-011 composes).
5. `restart-safety` — new process (fresh module state) still skips within the window thanks to the Setting fallback.

## Acceptance criteria

- [ ] `pruneRetention` executes at most once per 24 h (Setting-backed, restart-safe), not every tick.
- [ ] Devices with nothing prunable cost zero per-device queries.
- [ ] Retention outcomes (what gets deleted, caps, newest-protection) are unchanged; composes with RT-011.
- [ ] Tick response documents/reports the skip.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt016-prune-due-ness-gating.test.ts   # new suite green
bun test tests/audit/rt011-prune-drift-cascade-guard.test.ts   # composes with RT-011 (if landed)
bun test tests/                                             # no regressions
node_modules/typescript/bin/tsc --noEmit                    # exit 0
bun run lint                                                # 0 errors
```

## Rollout & rollback notes

Tick-route-only change; worst case a prune is delayed by the 24 h window (acceptable — windows move daily). Rollback = revert. Land AFTER RT-011 (the guard references the same code region; review both together).


## Status

Fixed (f0c16b1)
