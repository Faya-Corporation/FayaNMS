# RT-011 — Snapshot prune must not cascade-delete OPEN DriftRecords (code-level guard)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-013 | A3-04 | P2 | M | Medium — changes the retention pruner's candidate selection; must not stop legitimate pruning or break baseline references |

## Problem & evidence

- `prisma/schema.prisma:336-365` — `ConfigBaseline.snapshotId … onDelete: Cascade`; `DriftRecord.baselineSnapshotId` AND `DriftRecord.currentSnapshotId` both `onDelete: Cascade` (`DriftBaseline`/`DriftCurrent` relations, lines 351-365).
- Pruner: `src/app/api/v1/worker/tick/route.ts:178-291` (`pruneRetention`) — `deleteMany({ where: { id: { in: deleteIds }, status: "HISTORICAL" } })` (line 268-270).
- Drift engine: `src/app/api/v1/worker/drift-evaluate/route.ts:231-254` — an OPEN `DriftRecord` points `currentSnapshotId` at the latest snapshot; the next backup demotes that snapshot to HISTORICAL, so the next retention pass cascade-deletes the OPEN drift record.

Result: an open drift finding silently vanishes and the device reads compliant again with no resolve/accept action; superseded `ConfigBaseline` rows and their drift history are destroyed on a timer (historical evidence loss).

## Impact

Silent destruction of open drift findings — the drift/compliance feature's core guarantee breaks exactly when retention kicks in.

## Root cause

Schema chose `Cascade` for snapshot FKs while the pruner treats HISTORICAL rows as freely deletable; nothing reconciles the two lifecycles.

## Required change

Code-level guard first (binding scope decision — no schema migration in this RT; the schema-level SetNull alternative goes to BACKLOG as follow-up hardening):

1. **`src/app/api/v1/worker/tick/route.ts` — `pruneRetention`**: before the delete transaction (after `deleteIds` is complete, ~line 261):
   - Exclusion A (OPEN drift): `const openDriftSnapshots = await db.driftRecord.findMany({ where: { status: "OPEN", OR: [{ currentSnapshotId: { in: deleteIds } }, { baselineSnapshotId: { in: deleteIds } }] }, select: { currentSnapshotId: true, baselineSnapshotId: true } });` → build a `Set` of protected ids and remove them from `deleteIds`.
   - Exclusion B (latest ConfigBaseline per device): `const baselines = await db.configBaseline.findMany({ where: { snapshotId: { in: deleteIds } }, select: { snapshotId: true } });` → protect those snapshot ids too (a HISTORICAL snapshot can still be referenced by an approved baseline; cascading it destroys the baseline).
   - If exclusions empty `deleteIds`, return `{ pruned: 0, prunedDevices: 0 }` early.
   - Include both protected counts in the `CONFIG_RETENTION_PRUNED` audit `afterJson` (`protectedByOpenDrift`, `protectedByBaseline`) so operators can see why rows are retained.
2. **Guard against permanent retention deadlock**: a snapshot protected by an OPEN drift record stays until the record is RESOLVED/ACCEPTED — that is the intended semantics (document it in the route header). To keep the prune bounded, keep `PRUNE_MAX_DELETES_PER_TICK` semantics unchanged (excluded ids simply aren't deleted this tick).
3. **Doc header** of `pruneRetention` + the route header: document the two protection rules and the interaction with `drift-evaluate` (OPEN record holds the latest snapshot; pruning waits for resolution).

## Tests to add

File: `tests/audit/rt011-prune-drift-cascade-guard.test.ts` (DB-backed, mirrors `tests/flow-retention.test.ts` harness style).

1. `open drift record protects its current snapshot from pruning` — device with HISTORICAL snapshot past cutoff referenced by an OPEN DriftRecord → prune run deletes nothing; record + snapshot intact; audit shows `protectedByOpenDrift: 1`.
2. `resolved drift record releases its snapshots` — same setup with status RESOLVED (or ACCEPTED) → snapshot pruned normally (negative case for over-protection).
3. `approved baseline's snapshot is protected` — HISTORICAL snapshot referenced by ConfigBaseline → not deleted; audit shows `protectedByBaseline: 1`.
4. `unreferenced aged snapshots still prune` — plain HISTORICAL snapshots past cutoff with no drift/baseline refs → deleted (no regression of the core loop).
5. `protected snapshot does not consume the tick budget forever` — device whose only candidates are protected → other devices' candidates still prune within `PRUNE_MAX_DELETES_PER_TICK` (deletion budget not wasted on protected ids).

## Acceptance criteria

- [ ] No prune run can delete a snapshot referenced by an OPEN DriftRecord or by any ConfigBaseline row (verified by tests 1 and 3).
- [ ] Prune throughput for genuinely prunable rows is unchanged.
- [ ] Audit summary exposes protection counts.
- [ ] Route header documents the retention semantics for drift/baseline-referenced snapshots.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt011-prune-drift-cascade-guard.test.ts   # new suite green
bun test tests/flow-retention.test.ts tests/protocol-flow-retention.test.ts   # retention peers green
bun test tests/                                                 # no regressions
node_modules/typescript/bin/tsc --noEmit                        # exit 0
bun run lint                                                    # 0 errors
```

## Rollout & rollback notes

Contained in the tick route's prune helper; revert-safe. Follow-up (BACKLOG, not this RT): schema-level `SetNull` + scalar sha/version columns on DriftRecord to remove the FK-cascade hazard permanently — that is a migration with data backfill and deserves its own cycle.
