# RT-025 — Worker /api/metrics: timing-safe token compare + status-code hygiene

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-040 | A2-08 | P3 | S | Low — worker-only, three small mechanical fixes; metrics response unchanged |

## Problem & evidence

`mini-services/worker/control-auth.ts` + `mini-services/worker/index.ts` (A2-08 evidence):
1. `index.ts:149-162` — `/api/metrics` compares tokens with `!==` (`if (supplied !== \`Bearer ${configuredToken}\`)`) and is fully OPEN when `FAYANMS_METRICS_TOKEN` is unset (discloses counters/adapter manifest if the gateway exposes :3030).
2. `control-auth.ts:274-280` — `WORKER_SCOPE_INSUFFICIENT` returns `ok:false` with the code, but `controlRejectResponse` (lines 284-290) maps EVERY rejection to HTTP **401** — scope failures should be 403 semantics.
3. HS256 acceptance while `FAYANMS_SERVICE_SECRET` is set (lines 175-194, 231-243) is the documented Phase-2 pending item — NOT in scope here (finishing HS256 retirement is a policy/migration decision; it stays in BACKLOG under the A2-08 umbrella).

## Impact

Inconsistent status codes (clients can't distinguish "who are you" from "not allowed"); theoretical timing oracle on the metrics token; open metrics endpoint when unset.

## Root cause

Polish items on the worker control plane that predate the auth-hardening passes.

## Required change

`mini-services/worker/` only:

1. **Timing-safe metrics compare** (`index.ts`, lines 150-161): mirror RT-009 — `timingSafeEqual` over the `Bearer ${token}` bytes with a length pre-check (import `timingSafeEqual` from `node:crypto`; the file already uses `Buffer` idioms elsewhere). Keep the unset-token open behavior UNCHANGED in this RT (fail-closed is a deployment-policy decision tracked in BACKLOG under A2-08; do not silently change reachability).
2. **403 for scope failures** (`control-auth.ts:284-290`): `controlRejectResponse(result)` → `status: result.code === "WORKER_SCOPE_INSUFFICIENT" ? 403 : 401`. Verify no caller branched on the 401-for-scope behavior: `rg -n "WORKER_SCOPE_INSUFFICIENT|controlRejectResponse" mini-services/worker/ tests/` — update tests that assert 401 for scope-insufficient (they are asserting the bug).
3. No `jti` replay tracking, no HS256 retirement, no `WORKER_ALG_REJECTED` changes in this RT (BACKLOG).

## Tests to add

File: `tests/audit/rt025-worker-metrics-and-403.test.ts` (worker `handle()`-level tests, style of `tests/auth/service-identity-modes.test.ts`).

1. `metrics correct token accepted` — GET `/api/metrics` with the configured bearer → 200, body contains `fayanms_worker_scheduler_up`.
2. `metrics wrong token rejected` — negative: wrong/garbage/missing header → 401 text.
3. `metrics compare is constant-time` — source assertion: `timingSafeEqual` used in `index.ts` for the metrics path.
4. `scope-insufficient answers 403` — valid EdDSA token WITHOUT the required scope hitting a scoped endpoint → 403 with `code: "WORKER_SCOPE_INSUFFICIENT"` (the fixed semantic).
5. `unauthenticated still answers 401` — no/invalid token → 401 (guard against over-broadening).
6. `unset metrics token still serves` — documented behavior unchanged in this RT (assert 200 with token unset) — keeps the scope fence honest.

## Acceptance criteria

- [ ] `/api/metrics` uses a constant-time compare; unset-token behavior unchanged.
- [ ] `WORKER_SCOPE_INSUFFICIENT` → 403 everywhere `controlRejectResponse` is used.
- [ ] No other control-auth semantics changed (HS256 retirement explicitly untouched).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt025-worker-metrics-and-403.test.ts   # new suite green
bun test tests/auth/service-identity-modes.test.ts tests/auth/service-identity.test.ts   # worker auth peers green
bun test tests/                                             # no regressions
node_modules/typescript/bin/tsc --noEmit                    # exit 0
bun run lint                                                # 0 errors
```

## Rollout & rollback notes

Worker-module-only; rebuild worker image on deploy. Rollback = revert. Remaining A2-08 items (fail-closed metrics when unset, jti replay, HS256 retirement) stay in BACKLOG — do not expand this PR.


## Status

Fixed (ac16a12)
