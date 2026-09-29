# RT-036 — Remove `--web.enable-lifecycle` from the Prometheus container

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-066 | A5-14 | P3 | S | Low — one flag removal; config reloads fall back to container restart/SIGHUP |

## Problem & evidence

`deploy/oci/compose.monitoring.yml:23` — the prometheus service runs with `--web.enable-lifecycle` on the internal network with NO basic auth:
```
command:
  - --config.file=/etc/prometheus/prometheus.yml
  - --storage.tsdb.path=/prometheus
  - --web.enable-lifecycle
```
This exposes unauthenticated `/-/reload` and `/-/quit` control endpoints to anything on the backend/monitoring networks — a compromised app/worker container could shut Prometheus down (`/-/quit`) at will.

## Impact

Unauthenticated control-plane endpoints on a monitoring service reachable from the backend network.

## Root cause

Convenience flag left from bring-up; no auth gate compensates.

## Required change

1. **`deploy/oci/compose.monitoring.yml`** line 23: delete `- --web.enable-lifecycle`.
2. Compensating ops note (comment in the compose file, 1-2 lines): "config reloads = container restart (`docker compose restart prometheus`) — TSDB persists in the named volume; at this scale SIGHUP/restart is sufficient."
3. Check for consumers of the lifecycle API: `rg -rn "web.enable-lifecycle|/-/reload|/-/quit" . --glob '!node_modules'` — docs (`observability.md`, `deployment.md`) referencing a reload step must switch to the restart wording (update those one-liners in the same PR).
4. The alternative (keep the flag + `--web.config.file` basic auth) is NOT chosen — no credential infrastructure exists on that network; removal is the honest fix at this scale.

## Tests to add

File: `tests/audit/rt036-no-lifecycle-flag.test.ts` (config police, style of `tests/audit/monitoring-compose.test.ts`).

1. `lifecycle flag absent` — parse `deploy/oci/compose.monitoring.yml`: prometheus command contains exactly `--config.file` and `--storage.tsdb.path` (no `--web.enable-lifecycle`).
2. `no doc references remain` — grep-based: `/-/reload` and `/-/quit` appear nowhere in `docs/`, `deploy/`, `monitoring/` (update stragglers in this RT).
3. `TSDB volume preserved` — negative/regression: the `prometheus-data:/prometheus` mount and the storage flag survive (restart-based reload relies on it).

## Acceptance criteria

- [ ] Prometheus no longer exposes `/-/reload` / `/-/quit`.
- [ ] Docs use restart-based reload wording.
- [ ] Monitoring profile otherwise unchanged (images, mounts, networks).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt036-no-lifecycle-flag.test.ts   # new suite green
bun test tests/audit/monitoring-compose.test.ts         # monitoring peers green
bun test tests/                                         # no regressions
node_modules/typescript/bin/tsc --noEmit                # exit 0
bun run lint                                            # 0 errors
# Staging: docker compose -f deploy/oci/compose.yml --profile monitoring up -d prometheus
# curl -s -o /dev/null -w '%{http_code}' http://<monitoring-net>:9090/-/reload   → 404 (endpoint gone)
```

## Rollout & rollback notes

One flag; rollback = re-add the line (not recommended without also adding basic auth). If an operator automation script relied on `/-/reload`, it must switch to `docker compose restart prometheus` — that is exactly what the docs update covers.
