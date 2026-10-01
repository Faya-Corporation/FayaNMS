# RT-009 — Timing-safe metrics token compare in /api/metrics (S part only)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-027 | A1-04 | P3 (main-agent decision: fix in Wave 1) | S | Low — single comparison swap; no behavior change when tokens match/mismatch |

**Scope note (binding):** this RT covers ONLY the timing-safe comparison (the S part of A1-04's suggested fix). The "token optional → refuse when unset in production" policy change and the Prometheus-scrape-only note are explicitly OUT of scope here (related but separate concerns; F-061/RT-031 covers the edge 404 for the TLS profile). If the main agent later wants default-closed, file it as a backlog entry — do not smuggle it into this change.

## Problem & evidence

`src/app/api/metrics/route.ts:19-26`:
```ts
const configuredToken = process.env.FAYANMS_METRICS_TOKEN?.trim() ?? "";
if (configuredToken.length > 0) {
  const supplied = request.headers.get("authorization") ?? "";
  if (supplied !== `Bearer ${configuredToken}`) {   // string compare
    return unauthorized();
  }
}
```
`supplied !== \`Bearer ${configuredToken}\`` is not constant-time (minor but standard-practice violation for a bearer secret on an unauthenticated-adjacent surface outside the `/api/v1` proxy gate).

## Impact

Theoretical timing oracle on the Prometheus scrape token. Low practical risk (network jitter dominates), but the fix is a one-liner and the repo already does timing-safe compares everywhere else (e.g. `mini-services/worker/control-auth.ts:242` `timingSafeEqualBuffer`).

## Root cause

Route written with a plain string comparison; no shared helper existed at the time.

## Required change

1. **`src/app/api/metrics/route.ts`** — replace the string comparison (line 23) with a constant-time compare over the raw bytes:
   ```ts
   import { timingSafeEqual } from "node:crypto";
   ...
   const expected = Buffer.from(`Bearer ${configuredToken}`, "utf8");
   const suppliedBuf = Buffer.from(supplied, "utf8");
   const ok = suppliedBuf.length === expected.length && timingSafeEqual(suppliedBuf, expected);
   if (!ok) return unauthorized();
   ```
   (Length-check first: `timingSafeEqual` throws on length mismatch — the length leak is unavoidable and universally accepted.)
2. No other behavior change: unset token still serves (documented optionality), 401 response byte-identical.

## Tests to add

File: `tests/audit/rt009-metrics-token-timing-safe.test.ts` (source-shape + behavior test).

1. `correct token accepted` — GET with `Authorization: Bearer <token>` and `FAYANMS_METRICS_TOKEN` set → 200 with `fayanms_process_uptime_seconds` present.
2. `wrong token rejected` — negative case: wrong/garbage/missing header with token configured → 401 `text/plain` "Unauthorized".
3. `unset token serves (documented optionality unchanged)` — env unset → 200 (guards the scoped-down behavior from regressing silently).
4. `comparison is constant-time` — source assertion: `timingSafeEqual` imported from `node:crypto` and used in `src/app/api/metrics/route.ts`; plain `!==` against the bearer template no longer present.

## Acceptance criteria

- [ ] `/api/metrics` uses `timingSafeEqual` for the bearer comparison; no behavior change for valid/invalid callers.
- [ ] The explicitly out-of-scope policy items (default-closed, edge 404) are NOT changed by this RT.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt009-metrics-token-timing-safe.test.ts   # new suite green
bun test tests/                                                 # no regressions
node_modules/typescript/bin/tsc --noEmit                        # exit 0
bun run lint                                                    # 0 errors
```

## Rollout & rollback notes

Trivial revert. No operator action (token semantics unchanged). Note for reviewers: the same pattern exists in the worker's `/api/metrics` (`mini-services/worker/index.ts:149-162`) — that is F-040/RT-025, deliberately a separate file so worker and app changes stay independently revertible.
