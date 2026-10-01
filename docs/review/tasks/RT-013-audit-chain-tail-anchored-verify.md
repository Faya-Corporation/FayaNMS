# RT-013 — Audit chain verify must walk the TAIL (not the oldest prefix)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-015 | A3-06 | P2 | S | Low-Medium — changes the verifier's scan direction; verdict semantics must stay backward-compatible for the UI |

## Problem & evidence

`src/lib/audit/chain.ts:292-313` — `verifyAuditChain(client, maxRows = 5_000)`:
```ts
const rows = await client.auditEvent.findMany({
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  take: maxRows,
  select: CHAIN_SELECT,
});
const truncated = totalCount > rows.length;
```
The scan window is the OLDEST 5,000 rows. Once `AuditEvent` exceeds the cap, verification forever proves only the oldest prefix; the fresh tail — the realistic tamper target — is never walked, and the verdict silently becomes `PARTIALLY_VERIFIED` forever (with a "scan cap reached" issue line).

## Impact

The tamper-evidence feature degrades to theatre at exactly the scale where it matters: an attacker edits recent rows and the verifier never looks at them.

## Root cause

The walk was implemented genesis-forward with a leading `take` window; no tail anchoring was added when the cap was introduced.

## Required change

Single file: `src/lib/audit/chain.ts` (`verifyAuditChain`, lines 292+).

1. Anchor the window at the tail: `orderBy: [{ createdAt: "desc" }, { id: "desc" }]` with the same `take: maxRows`, then reverse the fetched array to chain order before building the link map (`rows.reverse()`).
2. Keep the genesis logic intact but make it tail-window-aware:
   - The genesis row (hashed, `prevHash = null`) will usually be OUTSIDE a tail window on a large table. When `truncated` is true and no genesis row is in the window, do NOT return INVALID for "missing genesis" — instead treat the oldest row in the window as the walk anchor (its `prevHash` necessarily points outside the window), verify forward from there, and keep the verdict capped at `PARTIALLY_VERIFIED` with an explicit issue line: `Tail window: rows 0..N-1 before <anchor id> not examined this run.` (Preserve the existing INVALID semantics for a truly broken link: a `prevHash` that matches NO known hash AND is not merely outside the window cannot be distinguished cheaply — resolve by checking `count({ where: { hash: thatPrevHash } })` for the boundary row only: 0 → dangling link → INVALID; ≥1 → link continues outside the window → PARTIALLY.)
   - Multiple-genesis / fork / hash-mismatch / unhashed reporting inside the window: unchanged.
3. Result contract (`ChainVerifyResult`, lines 261-276): add `anchoredAt?: string` (the window's oldest row id) and a boolean/enum `window: "FULL" | "TAIL"` so the UI can say what was proven. `valid`/`verdict` backward-compatible: unchanged meaning, `PARTIALLY_VERIFIED` for any truncated walk (as today).
4. Callers: `rg -n "verifyAuditChain" src/ scripts/` — update the admin chain view (`admin-system-view.tsx` consumes the result; optionally render the new `window`/`anchoredAt` fields — keep it minimal: surface them in the existing issues/summary area) and `scripts/gov-verify.ts` if it prints the verdict (add the window to its output line). Check `docs/runbooks/governance.md` §verify wording and adjust one line if it describes "oldest 5000".

## Tests to add

File: `tests/audit/rt013-chain-tail-verify.test.ts` (extend or mirror `tests/audit/chain.test.ts` harness).

1. `small table walks the whole chain (FULLY_VERIFIED)` — ≤ maxRows rows, all hashed → verdict FULLY_VERIFIED, `window: "FULL"` (no regression).
2. `table beyond the cap proves the tail` — insert maxRows + 100 chained rows → verdict PARTIALLY_VERIFIED with `window: "TAIL"`, `checked === maxRows`, and the WALKED rows are the NEWEST ones (assert the oldest walked id equals the expected anchor).
3. `tampered tail row is detected` — beyond-cap table, flip one byte in a recent row's `afterJson` (recompute nothing) → verdict INVALID with `brokenAt` pointing at the recent row (the core fix).
4. `boundary row whose prevHash exists outside the window caps at PARTIALLY` — anchor's prevHash matches a real (older) row outside the window → PARTIALLY_VERIFIED, not INVALID.
5. `dangling anchor prevHash is INVALID` — anchor's prevHash matches nothing → INVALID (negative case).
6. `unhashed rows inside the tail window still degrade/report as today`.

## Acceptance criteria

- [ ] With AuditEvent > cap, verification proves the NEWEST `maxRows` rows and reports the window honestly (`TAIL` + anchoredAt).
- [ ] A tampered recent row is detected (INVALID) — the realistic attack is now in scope.
- [ ] All pre-existing verdict semantics (genesis/fork/unhashed/break) preserved for tables under the cap.
- [ ] UI/gov-verify output updated for the new fields (minimal diff).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt013-chain-tail-verify.test.ts   # new suite green
bun test tests/audit/chain.test.ts                      # existing chain semantics green
bun test tests/                                         # no regressions
node_modules/typescript/bin/tsc --noEmit                # exit 0
bun run lint                                            # 0 errors
```

## Rollout & rollback notes

Single-module change, no writes (verifier only). Rollback = revert. After rollout the admin chain view will (correctly) still say PARTIALLY_VERIFIED on big tables — the difference is the proven rows are now the recent ones; mention this in the PR so nobody mistakes the new wording for a regression.


## Status

Fixed (0909ef9)
