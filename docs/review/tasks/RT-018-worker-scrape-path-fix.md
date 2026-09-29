# RT-018 — Monitoring: fix the worker scrape path (target 404s forever)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-023 | A5-02 | P2 | S | Low — one line in prometheus.yml; optional alias alternative documented but not required |

## Problem & evidence

- `monitoring/prometheus.yml:20-22` — the `fayanms-worker` job scrapes `metrics_path: /metrics` from `worker:3030`.
- `mini-services/worker/index.ts:149` — the worker serves ONLY `GET /api/metrics` (plus `/health`, line 137); there is no `/metrics` route.

The `fayanms-worker` Prometheus target 404s forever — violating the runbook's own rule ("A Prometheus target returning no metrics is a finding", `docs/runbooks/observability.md:17`); worker job/scheduler/protocol metrics are never scraped. (The app job, lines 12-17, correctly uses `/api/metrics`.)

## Impact

Zero worker observability in every deployment that enables the monitoring profile: job counters, `scheduler_up`, claim backoff and protocol-collector metrics are all dark.

## Root cause

Config assumed a conventional `/metrics` path; the worker historically exposes `/api/metrics` (mirroring the app route).

## Required change

1. **`monitoring/prometheus.yml`** line 20: `metrics_path: /metrics` → `metrics_path: /api/metrics`.
2. Do NOT add an alias route in the worker (the audit's alternative) — one owner, one path; the app job already proves the `/api/metrics` convention. If a future worker rewrite wants `/metrics`, that is a separate contract change.
3. If `FAYANMS_METRICS_TOKEN` is set (see `deploy/oci/env.example:29`), Prometheus needs `authorization.credentials_file`/`credentials` on this job — check `monitoring/prometheus.yml` for the app job's handling and mirror it for the worker job so the fix actually yields 200s in the hardened profile (if the app job already carries an authorization block, copy it; if neither does, note it in the PR but keep the RT scoped to the path fix).

## Tests to add

File: `tests/audit/rt018-worker-scrape-path.test.ts` (config police, style of `tests/audit/monitoring-compose.test.ts`).

1. `worker scrape path matches the worker route` — parse `monitoring/prometheus.yml`; assert the `fayanms-worker` job's `metrics_path === "/api/metrics"` and its target is `worker:3030`.
2. `path exists on the worker` — source assertion: `mini-services/worker/index.ts` contains `url.pathname === "/api/metrics"` (guards against the config drifting from the route again).
3. `both scrape jobs use the same contract` — app and worker jobs both use `/api/metrics` (consistency assertion).
4. Negative case preserved: `prometheus self-job has no metrics_path override` — untouched default.

## Acceptance criteria

- [ ] `fayanms-worker` target returns 200 with `fayanms_worker_scheduler_up` etc. when the monitoring profile is up (operator checklist).
- [ ] Only `monitoring/prometheus.yml` changed (plus optional token-parity note if the app job needed mirroring).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt018-worker-scrape-path.test.ts   # new suite green
bun test tests/audit/monitoring-compose.test.ts          # monitoring peers green
bun test tests/                                          # no regressions
node_modules/typescript/bin/tsc --noEmit                 # exit 0
bun run lint                                             # 0 errors
```

## Rollout & rollback notes

One-line config fix; monitoring profile is operator-enabled only (compose.monitoring.yml profiles). Rollback = revert the line. Depends on nothing; can land any time (plan ordering only prefers it before the first post-fix monitoring validation pass).
