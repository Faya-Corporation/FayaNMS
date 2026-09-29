# RT-003 — ProtocolEventQueue retention sweep (bounded, terminal rows)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-003 | A2-03 + A3-03 (same issue, merged) | P1 | M | Medium — adds a delete path for queue rows that FlowRecords FK-reference; ordering and chunking must preserve drain idempotency and audit integrity |

## Problem & evidence

- `src/app/api/v1/ingest/protocol/route.ts:108-165` — every accepted event inserts one `protocolEventQueue` row **and** one `PROTOCOL_EVENT_QUEUED` audit row, inside the ingest transaction.
- `src/app/api/v1/worker/protocol-events/drain/route.ts:170-195` — delivery marks the row `DELIVERED`, nulls `flowBatchJson`, and writes a second audit row (`PROTOCOL_EVENT_RECEIVED`); `recordFailure` (lines 199-241) writes a third on DEAD-lettering.
- grep across `src/`: **no `protocolEventQueue.deleteMany` exists anywhere** — DELIVERED and DEAD rows (and their `lastError`) are kept forever.

Sustained syslog/NetFlow rate (the drain budget alone is ~64 events/min) grows `ProtocolEventQueue` + the append-only audit chain without bound: claim scans (`@@index([status, nextAttemptAt])`), `queueDepth` counts (`drain/route.ts:281-283`) and disk all degrade monotonically.

## Impact

Slow disk exhaustion and progressive queue-scan/queue-depth degradation on any deployment that accepts real telemetry; the audit chain amplifies growth 2-3× per event.

## Root cause

No retention sweep for terminal queue rows was ever added; the queue was modeled as durable handoff but its terminal states were never garbage-collected.

## Required change

Mirror the FLOW_RETENTION pattern exactly (chunked findMany→deleteMany, Setting-backed policy, audit summary):

1. **Policy module** — new `src/lib/protocol/queue-retention.ts` (sibling of `src/lib/flows/retention.ts`):
   - `PROTOCOL_QUEUE_RETENTION_KEY = "protocolQueue.retention"`; `DEFAULT = { deliveredDays: 7, deadDays: 30, enabled: true }`; `PROTOCOL_QUEUE_CHUNK_SIZE = 1_000`; `PROTOCOL_QUEUE_MAX_DELETES_PER_RUN = 10_000`; zod schema + `parseStored...` mirroring the flows module (Setting row so the policy is operator-visible/editable like `flows.retention`).
2. **Prune route** — new `POST /api/v1/protocol/queue/retention/prune` (evaluate-in-Next), gate identical to `src/app/api/v1/metrics/retention/prune/route.ts:45-55` (`requireServiceOrPermission(request, "settings.write", ...)` or reuse `"metrics.prune"`-style existing permission — prefer the flows-retention route's gate; copy `src/app/api/v1/flows/retention/prune/route.ts`).
   - Transaction (bounded, `timeout: 30_000`): loop `batches = MAX_DELETES_PER_RUN / CHUNK_SIZE` times: `findMany` terminal rows — `status: "DELIVERED", deliveredAt/updatedAt < now − deliveredDays` **OR** `status: "DEAD", updatedAt < now − deadDays` — `orderBy [{createdAt:"asc"},{id:"asc"}]`, `take CHUNK_SIZE`; `deleteMany({ where: { id: { in: ids }, status: { in: ["DELIVERED","DEAD"] } } })` (status-guarded delete, same CAS spirit as the drain's lease updates).
   - **FK safety**: `FlowRecord.queueId` is `onDelete: Cascade` (prisma/schema.prisma:942+). Deleting a DELIVERED row whose FlowRecords are still inside the retention window would cascade-delete live flow analytics. Guard: exclude queue ids that still have FlowRecords — `findMany({ where: { queueId: { in: ids } }, select: { queueId: true }, distinct: ["queueId"] })` and delete only the ids not in that set this run (or restrict the candidate `where` with `flowRecords: { none: {} }` if the relation filter performs acceptably). Document that FlowRecord retention (FLOW_RETENTION) reclaims the FlowRecords first, and the queue rows follow on later sweeps.
   - Chunked (never one unbounded `deleteMany`), one `PROTOCOL_QUEUE_PRUNED` audit summary row per run into the SAME transaction (copy the flows route's audit block), persist `lastPrunedAt/lastPruneResult` in the Setting row, 60 s throttle (copy the metrics-prune module-scope throttle).
3. **Scheduler + worker** — `src/app/api/v1/worker/tick/route.ts`: `enqueueProtocolQueueRetention` modeled on `enqueueFlowRetention` (lines 668-699, 24 h dedupe constant `PROTOCOL_QUEUE_RETENTION_DEDUPE_HOURS = 24`); add to the response + doc header. `mini-services/worker/runner.ts`: `PROTOCOL_QUEUE_RETENTION` branch in `executeJob` (~line 1108), claim `types` array (~line 1180), and `runProtocolQueueRetentionJob` copying `runFlowRetentionJob` (throttled → graceful success).
4. **Proxy** — add the route to the session-exempt exact list in `src/proxy.ts:154-168` and (it is machine-driven) to `MACHINE_EXACT_ROUTES` (`src/proxy.ts:106-110`), mirroring `metrics/retention/prune`.
5. **Docs** — document the policy + defaults next to `flows.retention` wherever the runbook lists retention settings (one line in `docs/runbooks/observability.md` if it enumerates retention keys; keep the change docs-only otherwise).

## Tests to add

File: `tests/audit/protocol-queue-retention.test.ts` (DB-backed; `tests/_setup.ts` provides the postgres URL; reuse fixtures from `tests/protocol-queue.test.ts` / `tests/audit/protocol-flow-retention.test.ts`).

1. `prunes terminal DELIVERED rows past the window` — seed DELIVERED rows aged beyond `deliveredDays` → pruned; fresh DELIVERED rows survive.
2. `prunes DEAD rows only past the dead window` — DEAD row younger than `deadDays` survives; older is pruned (negative case for the shorter window).
3. `never prunes QUEUED or IN_FLIGHT rows` — status-guarded delete: mixed-seed run leaves every non-terminal row untouched.
4. `skips queue rows that still own FlowRecords` — DELIVERED row with a FlowRecord inside the flow window survives; after the FlowRecord is deleted by flow retention, the next sweep reclaims the row.
5. `chunking caps deletes per run` — seed > CHUNK_SIZE candidates → first run deletes ≤ MAX_DELETES_PER_RUN and reports the count; repeated runs converge.
6. `route is dual-gated` — anonymous → 401; session without permission → 403; service JWT (jobs scope) → 200 (negative/permission cases).
7. `second immediate call is throttled` — 429 `..._THROTTLED` within 60 s; worker treats it as success (mirror the metrics-prune contract test if one exists).

## Acceptance criteria

- [ ] `grep -rn "protocolEventQueue.deleteMany" src/` finds the retention sweep (and only there).
- [ ] No QUEUED/IN_FLIGHT row can ever be deleted by the sweep (status-guarded).
- [ ] No FlowRecord is cascade-deleted by a queue prune (guarded by the FlowRecord-existence check).
- [ ] Deletes are chunked (≤ 1,000/statement, ≤ 10,000/run) inside a bounded transaction.
- [ ] Policy is a Setting row (`protocolQueue.retention`) with audit + lastPruned bookkeeping; defaults documented.
- [ ] Anonymous/unauthorized access rejected; throttled runs answer 429 with a typed code.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/protocol-queue-retention.test.ts   # all new cases green
bun test tests/protocol-queue.test.ts                    # drain/claim behavior unchanged
bun test tests/                                          # no regressions
node_modules/typescript/bin/tsc --noEmit                 # exit 0
bun run lint                                             # 0 errors
```

## Rollout & rollback notes

Inert until the first tick enqueues the job; the first run deletes at most 10k oldest terminal rows, so worst-case disk reclaim is gradual by design. Rollback = revert; the Setting row is ignored by older code. Do NOT ship this together with a lowered `deliveredDays` in the same change — keep defaults conservative (7d/30d) and let operators tune the Setting.
