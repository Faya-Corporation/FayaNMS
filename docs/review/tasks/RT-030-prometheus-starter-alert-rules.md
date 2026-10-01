# RT-030 — Ship starter Prometheus alert rules + mount the rules dir

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-060 | A5-08 | P3 | S | Low — monitoring profile only; rules are advisory (Prometheus evaluates, alertmanager routing is a later concern) |

## Problem & evidence

- `monitoring/prometheus.yml:8-9` — `rule_files: /etc/prometheus/rules/*.yml`.
- `deploy/oci/compose.monitoring.yml:12-14` — mounts ONLY `./monitoring/prometheus.yml`; **no rules file exists anywhere in the repo** (verified by audit A5-08).

The glob implies rules that don't exist: monitoring is scrape-only, while `docs/runbooks/observability.md:35-37` lists service-down, PG-down, queue growth and cert expiry as the checks required "before calling the stack operational".

## Impact

The stack can be silently unmonitored: nothing fires when the app/worker/PG dies; the runbook's own operational bar is unmet.

## Root cause

Rules dir wired in config but never authored.

## Required change

1. **New `monitoring/rules/fayanms-starter.yml`** — starter rules exactly matching the runbook's list (keep them SIMPLE and alertmanager-agnostic; usePrometheus-style `alert:`/`expr:`/`for:`/`labels:`/`annotations:`):
   - `FayanmsAppDown` — `up{job="fayanms-app"} == 0` for 2m.
   - `FayanmsWorkerDown` — `up{job="fayanms-worker"} == 0` for 2m (depends on RT-018's scrape-path fix to be meaningful — order in plan).
   - `FayanmsWorkerSchedulerDown` — `fayanms_worker_scheduler_up == 0` for 5m.
   - `FayanmsPostgresDown` — `pg_up == 0` **only if a postgres_exporter target exists**; otherwise express as absent-app-writes or leave a commented block with a TODO naming the exporter decision (do NOT invent a metric that no exporter serves — flagged as a scope concern; the honest starter covers the three `up`-based alerts + queue growth).
   - `FayanmsQueueGrowth` — `fayanms_worker_protocol_packets_total{state="queue_dropped"} > 0` or a rate-based `increase(...[15m]) > 0` (metric exists: worker `/api/metrics` line 188 in `mini-services/worker/index.ts`).
   - Cert expiry is NOT expressible without an exporter (blackbox/ssl exporter absent) — leave a commented block + one runbook line (honest scope).
2. **`deploy/oci/compose.monitoring.yml`** (prometheus volumes, lines 12-14): add `- ./monitoring/rules/:/etc/prometheus/rules/:ro`.
3. Check the ROOT monitoring story (`rg -n "rules" monitoring/ deploy/compose.monitoring.yml compose.monitoring.yml 2>/dev/null` — if a root-level monitoring compose exists with the same glob, mirror the mount there).
4. Runbook: one line in `docs/runbooks/observability.md` pointing at the starter file + "cert/PG rules require an exporter decision" note.

## Tests to add

File: `tests/audit/rt030-prometheus-starter-rules.test.ts` (config police, style of `tests/audit/monitoring-compose.test.ts`).

1. `rules file exists and parses` — YAML-parse `monitoring/rules/fayanms-starter.yml`; assert ≥ 3 alert rules, each with alert/expr/for/labels/annotations.
2. `rule expressions reference real metrics` — whitelist assertion: every `expr` references only metric names that exist in the app/worker emitters (`fayanms_process_*`, `fayanms_worker_*`) or `up` — this is the anti-invented-metric guard (PG/cert rules must be absent-or-commented).
3. `compose mounts the rules dir` — `deploy/oci/compose.monitoring.yml` prometheus service mounts `./monitoring/rules/:/etc/prometheus/rules/:ro`.
4. `glob matches the mount` — `rule_files` glob in prometheus.yml matches the mounted path (wiring sanity).

## Acceptance criteria

- [ ] Prometheus (monitoring profile) loads ≥ 3 working alert rules referencing only real metrics.
- [ ] No invented metrics (PG/cert rules are commented placeholders pending an exporter decision).
- [ ] Rules dir mounted read-only; runbook notes updated.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt030-prometheus-starter-rules.test.ts   # new suite green
bun test tests/audit/monitoring-compose.test.ts                # monitoring peers green
bun test tests/                                                # no regressions
node_modules/typescript/bin/tsc --noEmit                       # exit 0
bun run lint                                                   # 0 errors
# Optional: promtool check rules monitoring/rules/fayanms-starter.yml  (if promtool available)
```

## Rollout & rollback notes

Monitoring-profile-only; rules that misfire cost nothing until an alertmanager routes them (none configured — noted in the runbook line). Rollback = unmount the dir. Scope concern flagged during planning: PG-down/cert-expiry cannot be honestly implemented without choosing an exporter — the RT deliberately ships them as commented placeholders instead of fake coverage.


## Status

Fixed (776b760)
