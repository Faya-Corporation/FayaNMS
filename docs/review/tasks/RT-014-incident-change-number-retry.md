# RT-014 — Incident/change number allocation: retry on P2002 (mirror the cmdb pattern)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-016 | A3-07 | P2 | S | Low — adds a bounded retry; failure mode today is a 500/rollback, so the change strictly improves outcomes |

## Problem & evidence

- `src/lib/incidents/create.ts:38-47` — `nextIncidentNumber()` reads `max(number)+1` via the GLOBAL `db` (outside the caller's tx snapshot) and is consumed at line 144 INSIDE `db.$transaction` in `createIncidentForAlert`.
- `src/app/api/v1/changes/route.ts:262` — `const number = await nextChangeNumber()` computed BEFORE the tx (helper: `src/app/api/v1/_lib/change.ts:114-126`, same max+1 pattern).
- Neither path retries on the `@@unique` P2002. Two concurrent creations read the same max → both compute `INC-2026-00042`/`CHG-2026-00042` → the loser dies with an unhandled P2002 → 500 + full tx rollback (incident creation also rolls back the alert linkage; the change tx rolls back devices/steps/approvals).
- The repo already solves this in `src/app/api/v1/cmdb/items/route.ts` — `for (let attempt = 0; attempt < 2; attempt += 1)` (line 278) with `error.code === "P2002"` → `if (attempt === 0) continue;` (lines 343-356). Inconsistent application.

Also noted (documented in the RT, not necessarily fixed here): the `YYYY` format never resets the sequence per year (max+1 is global). Keep current behavior unless trivial; flag in the PR description.

## Impact

Concurrent incident/change creation (alert storm auto-creation + a manual escalate; two engineers submitting changes) → unhandled 500s, lost tx work, noisy Job Center failures.

## Root cause

Sequence allocation via non-atomic max+1 without the repo's own retry-on-unique-violation pattern.

## Required change

1. **Incident path** — `src/lib/incidents/create.ts`:
   - Move allocation INSIDE the transaction and read via the TX client: change `nextIncidentNumber(now)` to accept a client param `nextIncidentNumber(client: Prisma.TransactionClient, now)` using `client.incident.findFirst(...)` (callers: line 144 here, plus `rg -n "nextIncidentNumber" src/` for the manual escalation route `src/app/api/v1/alerts/[id]/create-incident/route.ts` — update all).
   - Wrap the `$transaction` in a 2-attempt loop copied from cmdb (lines 278, 343-356): catch `Prisma.PrismaClientKnownRequestError` with `code === "P2002"` and `meta.target` containing `number` → `invalidate` nothing, `attempt === 0 → continue`; second failure → rethrow as a typed 409/`INCIDENT_NUMBER_CONFLICT` (the evaluate engine's caller treats a thrown error as a failed creation for THAT alert only — pass-1 loop already isolates per-alert work; verify no partial side effects: the tx rolls back atomically).
2. **Change path** — `src/app/api/v1/changes/route.ts`:
   - Move `const number = await nextChangeNumber()` (line 262) inside the `$transaction`, threading the tx client into `nextChangeNumber(client)` (`src/app/api/v1/_lib/change.ts:114` — add the same optional-client param; other callers via grep).
   - Same 2-attempt P2002 retry loop around the create tx; on second failure return `fail("CHANGE_NUMBER_CONFLICT", ..., 409)` so the wizard shows a retryable error instead of a 500.
3. Do NOT introduce a Postgres sequence or counter row (the audit lists it as the alternative) — keep the change minimal and consistent with cmdb; note the sequence option in the PR for a future hardening cycle.

## Tests to add

File: `tests/audit/rt014-number-allocation-retry.test.ts` (DB-backed).

1. `concurrent incident creations both succeed` — fire N=5 parallel `createIncidentForAlert` for distinct alerts on the same device → 5 distinct incident numbers, no 500/P2002 surfacing (the loser of a race retried).
2. `concurrent change creations both succeed` — two parallel POSTs to `/api/v1/changes` (authed `change.create`) → both 200/201 with distinct `CHG-` numbers.
3. `second consecutive conflict surfaces a typed error` — force the retry to lose twice (mock or unique-saturation) → incident path throws/returns `INCIDENT_NUMBER_CONFLICT`; change path answers 409 `CHANGE_NUMBER_CONFLICT` (negative case; no raw P2002 leaks).
4. `number allocation reads inside the tx snapshot` — source assertion or interleaving test proving the helper now receives the tx client (guards the race class, not just the symptom).
5. `existing single-threaded numbering unchanged` — sequential creations keep the `+1 padded 5` format (no regression).

## Acceptance criteria

- [ ] Both paths retry once on P2002 using the cmdb pattern; no unhandled P2002 reaches clients.
- [ ] Allocation happens with the tx client inside the transaction.
- [ ] Second-conflict failures are typed (`INCIDENT_NUMBER_CONFLICT` / `CHANGE_NUMBER_CONFLICT`, 409 on the HTTP path).
- [ ] Alert-linkage tx atomicity preserved (failed creation leaves no partial rows).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt014-number-allocation-retry.test.ts   # new suite green
bun test tests/audit/change-engine-invariants.test.ts         # change engine green
bun test tests/                                               # no regressions
node_modules/typescript/bin/tsc --noEmit                      # exit 0
bun run lint                                                  # 0 errors
```

## Rollout & rollback notes

Behavior strictly improves on today's failure mode; revert-safe per-file. Related-but-separate: `src/lib/config/create-snapshot.ts:95-100` has the same max+1 race (A3-15/F-051) — deliberately NOT in this RT (deferred); mention in the PR so reviewers don't ask.


## Status

Fixed (bbb5475)
