# RT-027 — Worker control plane: stop leaking internal error detail

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-043 | A2-11 | P3 | S | Low-Medium — error-message plumbing; automation/tests may match on current messages, so map codes not prose |

## Problem & evidence

Three leak paths in `mini-services/worker/`:
1. `index.ts:966-972` — the catch-all handler returns `{ ok: false, error: (e as Error)?.message ?? "internal error" }` with 500: internal detail (vault file paths, DNS codes, stack-adjacent text) reaches control-plane callers.
2. `ssh-transport.ts:415-419` — `SSH_EXEC_FAILED` embeds 200 chars of DEVICE OUTPUT: `` `Command "${command}" exited with ${exitCode}: ${(errOut || out).slice(0, 200)}` `` — device text excerpts travel in error messages that end up in job records/UI.
3. `next-client.ts:47-58` — `log()` appends unbounded lines to `worker.log` (growing file; also a disclosure sink since messages carry the above).

(No secret material observed in any message path — the vault design keeps stdout out of errors; this is hygiene, not a secret leak.)

## Impact

Internal topology/paths and device text disclosed to control-plane callers; unbounded log growth on the worker.

## Root cause

Catch-all handlers pass raw `Error.message` through; the bounded-excerpt choice predates the control-plane trust boundary being drawn.

## Required change

1. **`index.ts` catch-all (lines 966-972)** — keep typed-error passthrough, genericize the rest:
   - If the error carries a `code` (VaultError/LiveAdapterError/TargetPolicyError/SshError/WebApiError etc. are already handled INSIDE the specific routes with their own typed responses — this catch-all should only see genuinely unexpected errors): respond `{ ok: false, error: "Internal worker error", correlationId }` where `correlationId = crypto.randomUUID()` (import from `node:crypto`), and `log()` the FULL error server-side with the correlation id (detail stays in server logs, not the response).
2. **`ssh-transport.ts:415-419`** — keep the typed code, drop the device excerpt: message becomes `Command "${command}" exited with ${exitCode}`; log the 200-char excerpt via `log()` (server-side) at the rejection site, or attach it to a non-client-facing field if the runner records one. Check consumers: `rg -n "SSH_EXEC_FAILED" mini-services/ tests/` — the code (not the prose) is the contract; update any test matching on the excerpt.
3. **`next-client.ts` `log()` (lines 50-58)** — bound the file: simple size-capped rotation (e.g. when `statSync(LOG_FILE).size > 5 MiB` → rename to `worker.log.1` (overwriting) before appending). Keep "never throws" semantics (stat in try/catch). No timestamped multi-file rotation — one generation is enough at this scale; note it in the comment.

## Tests to add

File: `tests/audit/rt027-worker-error-hygiene.test.ts`.

1. `catch-all response carries no internal detail` — force an unexpected throw in a route (or unit-invoke the handler shape) → response error is exactly `"Internal worker error"` + correlationId present; the full message appears only in the log call (assert via mocked `log`).
2. `SSH_EXEC_FAILED omits device output` — unit-test the rejection path (harness SSH persona or direct function) → message contains exit code, NOT the stderr excerpt; the code is still `"SSH_EXEC_FAILED"`.
3. `log rotation triggers at the cap` — unit-test the rotation helper with a file seeded > cap → `.log.1` created, appends continue, function never throws (negative case: unwritable dir → still no throw).
4. `typed errors still pass through` — routes that already return typed errors (VaultError etc.) keep their exact responses (regression guard).
5. `runner failure records stay code-keyed` — grep/source assertion: no test or code path depends on device output inside SSH_EXEC_FAILED prose.

## Acceptance criteria

- [ ] Catch-all 500s are generic + correlation-id; detail only in server logs.
- [ ] SSH failure messages carry no device text excerpts.
- [ ] `worker.log` is size-bounded with one-generation rotation.
- [ ] All existing typed error contracts (codes) unchanged.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt027-worker-error-hygiene.test.ts   # new suite green
bun test tests/                                            # no regressions
node_modules/typescript/bin/tsc --noEmit                   # exit 0
bun run lint                                               # 0 errors
```

## Rollout & rollback notes

Worker-only; support/debug flows rely on server logs (which now get MORE detail, not less). Rollback = revert. If the NOC UI somewhere displayed the SSH excerpt usefully, note the loss in the PR (job records still carry exit codes; full output remains in the job's result path where the runner stores stdout).
