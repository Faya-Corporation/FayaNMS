# RT-031 — TLS-profile proxy must 404 `/api/metrics` (parity with the OCI Caddyfile)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-061 | A5-09 | P3 | S | Low — one Caddyfile block ported; only affects the TLS profile edge |

## Problem & evidence

- `docs/deploy/Caddyfile.tls:22-33` — the TLS-profile site block has header hardening but **lacks** the internal-metrics block that `deploy/oci/Caddyfile:13-14` has:
  ```
  @internal_metrics path /api/metrics
  respond @internal_metrics 404
  ```
- `src/app/api/metrics/route.ts:20-26` — the metrics token is OPTIONAL (`if configuredToken.length > 0`).

On the root compose + TLS profile, unauthenticated process metrics (uptime, RSS, release SHA) are reachable from the public internet; the OCI-only Caddyfile blocks it — inconsistent posture between the two TLS entrypoints.

## Impact

Information disclosure on one of the two hardened entrypoints (process memory/release SHA to anonymous internet callers).

## Root cause

The block was added to the OCI Caddyfile only; the repo's canonical TLS example (`docs/deploy/Caddyfile.tls`) never received it.

## Required change

1. **`docs/deploy/Caddyfile.tls`** — inside the `{$FAYANMS_TLS_DOMAIN}` block (after the `header` block, before `reverse_proxy`, mirroring the OCI file's ordering):
   ```
   @internal_metrics path /api/metrics
   respond @internal_metrics 404
   ```
2. **Root `Caddyfile`** (sandbox gateway, `Caddyfile:17-37`): the audit lists it too ("and root Caddyfile path") — add the same two lines to the app's site block there (the sandbox gateway proxies the app on plain HTTP; metrics are equally exposed there).
3. `deploy/oci/Caddyfile` — unchanged (already correct; reference it in the PR as the source of truth).
4. Out of scope (noted): making `FAYANMS_METRICS_TOKEN` required in the hardened compose profile — policy decision, tracked in BACKLOG under A2-08/A1-04's residual.

## Tests to add

File: `tests/audit/rt031-tls-metrics-404.test.ts` (config police, style of `tests/audit/deploy-hardening.test.ts`).

1. `TLS Caddyfile 404s /api/metrics` — parse `docs/deploy/Caddyfile.tls`: `@internal_metrics path /api/metrics` + `respond @internal_metrics 404` present.
2. `all three Caddyfiles agree` — the block exists in `deploy/oci/Caddyfile`, `docs/deploy/Caddyfile.tls`, AND the root `Caddyfile` (parity contract; a future fourth entrypoint must repeat it — the test's failure message says so).
3. Negative case: `no other path is 404'd` — the matcher is exactly `/api/metrics` (not a broad path pattern that would break `/api/v1/*`).

## Acceptance criteria

- [ ] `/api/metrics` is 404 at both TLS entrypoints and the sandbox gateway.
- [ ] `/api/v1/*` and `/api/health` (RT-028) pass through untouched.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt031-tls-metrics-404.test.ts   # new suite green
bun test tests/                                       # no regressions
node_modules/typescript/bin/tsc --noEmit              # exit 0
bun run lint                                          # 0 errors
# Live check on a TLS-profile staging: curl -s -o /dev/null -w '%{http_code}' https://<domain>/api/metrics  → 404
```

## Rollout & rollback notes

Edge-config only; no app behavior change. Rollback = remove the block (returns to today's exposure — not recommended). Defense-in-depth note for reviewers: the edge 404 is the SECOND layer; the token (RT-009/RT-025 timing-safe) remains the primary control.


## Status

Fixed (428a9c2)
