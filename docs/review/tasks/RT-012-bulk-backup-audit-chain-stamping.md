# RT-012 — devices/bulk: audit rows must join the hash chain (no createMany)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-014 | A3-05 | P2 | S | Low — swaps one `createMany` for per-row `create` inside an existing transaction; ≤ 100 rows per call |

## Problem & evidence

- `src/lib/db.ts:53-76` — the Prisma extension intercepts ONLY `auditEvent.create` to stamp `hash/prevHash` (chain stamping + P2002 tail-conflict retry).
- `src/app/api/v1/devices/bulk/route.ts:92-103` — `db.auditEvent.createMany({ data: eligible.map(...) })` writes up to 100 `CONFIG_BACKUP_QUEUED` audit rows per bulk "backup now".

`createMany` is NOT intercepted → those rows are born with `hash/prevHash = null`: excluded from the link graph, verify verdict drops to PARTIALLY_VERIFIED (or INVALID-adjacent anomaly reporting), and the rows stay mutable until somebody remembers the manual backfill admin route. Weakens the tamper-evident chain guarantee on a user-triggered path.

## Impact

Every bulk backup degrades audit-chain integrity guarantees; chain verify shows unhashed rows; the rows are not tamper-evident.

## Root cause

The stamping extension was written for the singular `create`; `createMany` (and other batch verbs) bypass it, and the bulk route predates that gap being systematic.

## Required change

1. **`src/app/api/v1/devices/bulk/route.ts`** (lines 78-104) — replace the batched pair with an interactive transaction of per-row writes (the extension then stamps each row, inheriting conflict retry):
   ```ts
   const jobs = await db.$transaction(async (tx) => {
     const created = [];
     for (const [index, device] of eligible.entries()) {
       created.push(await tx.jobExecution.create({ data: {...} }));   // per-row
       await tx.auditEvent.create({ data: {...} });                    // stamped by extension
     }
     return created;
   }, { maxWait: 5_000, timeout: 20_000 });
   ```
   - Keep the exact same payloads/correlationIds; keep `skipDuplicates`-free semantics (ids already deduped at line 52).
   - Response shape unchanged (`queued`, `jobs`, `skipped`, header `auditEvents`) — compute `auditEvents` as the loop count.
   - ≤ 100 rows → interactive transaction is well within the existing per-route budget (the route already used `$transaction`).
2. **Defense-in-depth (same PR, tiny)**: in `src/lib/db.ts`, extend the extension with an `auditEvent.createMany` handler that throws a loud, typed error (`new Error("auditEvent.createMany bypasses chain stamping — use per-row create (see RT-012/F-014)")`) so no future call site can silently reintroduce the gap. Grep first to confirm devices/bulk is the ONLY `auditEvent.createMany` call site (`rg -n "auditEvent.createMany" src/`) — if others exist, convert them in this RT too (they are equally unhashed).

## Tests to add

File: `tests/audit/rt012-bulk-audit-chain-stamping.test.ts` (DB-backed; the chain is already covered by `tests/audit/chain.test.ts` — reuse its helpers).

1. `bulk backup_now stamps every audit row` — POST `/api/v1/devices/bulk` with 3 devices (authed session with `device.write`) → all 3 `CONFIG_BACKUP_QUEUED` rows have non-null `hash` + `prevHash`, and `prevHash` links them onto the chain tail.
2. `chain verify is FULLY_VERIFIED after a bulk run` — run `verifyAuditChain(db, maxRows)` post-bulk → no `unhashed` rows contributed by the bulk path, verdict not degraded by them.
3. `createMany on auditEvent is refused` — negative case: call `db.auditEvent.createMany(...)` directly in the test → throws the typed RT-012 error (guards the defense-in-depth tripwire).
4. `concurrent bulk runs keep the chain linear` — two parallel bulk posts → both succeed (extension's P2002 retry converges the tail); no rows with duplicate `prevHash`.
5. `permission gate unchanged` — unauthenticated bulk POST → 401; session without `device.write` → 403 (negative/permission cases; the refactor must not touch the gate).

## Acceptance criteria

- [ ] `rg -n "auditEvent.createMany" src/` returns zero call sites (or only the tripwire in db.ts).
- [ ] Bulk backup_now audit rows are hash-chained at creation (no backfill dependency).
- [ ] Chain verify verdict is not degraded by bulk operations.
- [ ] Response contract of `/api/v1/devices/bulk` unchanged.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt012-bulk-audit-chain-stamping.test.ts   # new suite green
bun test tests/audit/chain.test.ts                              # chain suite green
bun test tests/                                                 # no regressions
node_modules/typescript/bin/tsc --noEmit                        # exit 0
bun run lint                                                    # 0 errors
```

## Rollout & rollback notes

Small, self-contained; revert-safe. The db.ts tripwire is the only piece that could surprise another (future) call site — by design. Note: hash-VERIFY of historical rows already written unhashed still needs the existing manual backfill route once (operational step, not code).


## Status

Fixed (a2932e0)
