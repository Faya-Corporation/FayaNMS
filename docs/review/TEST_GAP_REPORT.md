# Test Gap Report — FayaNMS (branch `GLM/full-audit-and-fix`)

Source material: all five module audits (`docs/review/notes/A1..A5`), FINDINGS.md (66 deduplicated findings), BASELINE.md. This report identifies where the test suite would have caught — or still needs to catch — the audited defects. No tests were modified or weakened in this audit.

## Existing test strengths (do not regress these)

- **Scale & health at base `38fbdfb`:** 1,340 passing / 18 skipped / 2 environment-dependent failures (need local `sshd`) across 1,360 tests in 117 files; `bun test tests/`; lint and `tsc --noEmit` clean; `build:gate` PASS.
- **Authorization contract test:** `tests/auth/authorization-contract.test.ts` enforces handler-level `requirePermission`/`requireRole`/scope checks on every mutating `/api/v1` route — the reason A1 could find no mutation-RBAC holes.
- **Audit-chain suite:** covers stamping/verification of the hash-chained `AuditEvent` trail (the gaps found are specific bypass edges, F-014/F-015, not missing coverage of the happy path).
- **E2E / browser journeys:** Playwright browser journeys + e2e suites are required CI checks (`gate,e2e,browser,scan`, strict) and were green at base; they cover post-auth golden paths the sandbox could not walk.
- **Worker/protocol verifications:** SNMPv3 verify/replay gates, claim CAS, FlowRecord idempotency, and fail-closed host-key pinning all have tests (A2 positive verifications), including the credential-free first-contact tests (the 2 that need `sshd`).
- **CI hardening gates:** osv-scanner + Trivy (HIGH/CRITICAL), gitleaks `--redact`, SBOM/SARIF evidence artifacts — all checksum-verified binaries.

## Prioritized test gaps

Priority reflects the severity of the finding the gap would have caught (P = P1-first). "Area" maps to the owning module audit.

| Priority | Area | Gap (what is untested today) | Finding(s) | Suggested test names |
|---|---|---|---|---|
| P0-gap | Alerts | Re-suppression/reactivation after root resolves; recovered-condition resolution for SUPPRESSED-by-root rows | F-001 (A3-01) | `alerts.root-resolve.reactivates-suppressed-children` · `alerts.root-resolve.resolves-recovered-suppressed-children` · `alerts.still-breaching.reactivated-not-resolved` |
| P0-gap | Time-series | Runtime rollup production (MetricSample → MetricRollup) + downstream views/reports on unseeded data | F-002 (A3-02) | `rollup.job.produces-5m-1h-1d-windows-idempotent` · `rollup.backfill.first-run` · `dashboard.trend.falls-back-when-rollups-empty` |
| P0-gap | Ingest retention | ProtocolEventQueue retention sweep; DELIVERED/DEAD pruning; audit amplification bound | F-003 (A2-03+A3-03) | `protocol-queue.retention.prunes-terminal-rows-in-chunks` · `protocol-queue.growth.bounded-under-sustained-rate` |
| P0-gap | Frontend resilience | View/shell crash isolation (error boundaries) | F-004 (A4-01) | `app.error-boundary.crashing-view-degrades-to-errorstate` · `app.global-error.renders-localized-retry` |
| P1-gap | Auth defense-in-depth | Read-plane handler authn (proxy-bypass simulation); server-side CSRF/origin rejection; metrics default-open posture | F-008, F-010, F-027/F-040/F-061 (A1-01, A1-03, A1-04/A2-08/A5-09) | `authz.read-plane.gets.require-session-handler` · `csrf.session-mutation.rejects-cross-site-origin` · `metrics.refuses-when-token-unset-production` · `worker.metrics.timing-safe-compare` |
| P1-gap | Secrets/deploy | Compose env scoping (no KEK/session/DB secrets in caddy/postgres/worker containers) | F-007 (A5-01) | `deploy.oci.compose.env-files.scoped-per-service` (parse compose.yml + assert env var zone split per SEC-ENV-001) |
| P1-gap | Audit chain | `createMany` stamping; tail-anchored verification beyond 5k rows | F-014, F-015 (A3-05/06) | `audit.createMany.stamps-hash-chain` · `audit.verify.walks-tail-beyond-cap` |
| P1-gap | Worker lifecycle | Timed-out job cancellation + terminal-report exclusivity | F-012 (A2-02) | `runner.timeout.aborts-job-body` · `worker.complete.ignored-after-terminal-state` |
| P1-gap | Data integrity | Snapshot prune must not cascade-delete OPEN DriftRecords / referenced baselines | F-013 (A3-04) | `snapshot.prune.preserves-open-drift-records` · `snapshot.prune.excludes-latest-baseline` |
| P1-gap | CI supply chain | Scan-before-push ordering (vulnerable image must not publish) | F-024 (A5-03) | `container.pipeline.scan-gates-publish` (workflow-lint/static assert or dry-run) |
| P2-gap | Spoofing/validation | UDP hostname-vs-source-IP device attribution; discovery egress class checks | F-036, F-038 (A2-04/06) | `syslog.attributions.reject-conflicting-hostname` · `discovery.policy.refuses-governed-cidrs` |
| P2-gap | Concurrency | Number-allocation and snapshot-version races (retry-on-P2002); duplicate tick enqueue | F-016, F-051, F-052 (A3-07/15/16) | `incidents.create.retry-on-p2002` · `snapshot.concurrent-completions.distinct-versions` · `tick.enqueue.claims-recurring-jobs` |
| P2-gap | Permission negatives | `/admin/users` list gating; `/worker/status` rejects service tokens; pre-auth `/meta` inventory | F-029, F-033, F-028 (A1-05/06/10) | `admin.users.list.denies-viewer-emails` · `worker.status.rejects-service-jwt` · `meta.hides-credential-profiles.pre-auth` |
| P2-gap | Bounds | WebAPI response cap; SSH scan desync on >64 KiB output; per-stream budget | F-011, F-041, F-042 (A2-01/09/10) | `webapi.transport.aborts-past-output-cap` · `ssh.session.scan.survives-64k-trim` |
| P2-gap | i18n/regression | Toast/hook copy localization; error-boundary + ErrorState localized copy; RTL class sweep | F-005, F-006, F-019..F-022, F-053 (A4) | `i18n.hooks.toasts.use-dictionaries` · `i18n.alerts.surfaces.full-parity` · `rtl.no-physical-classes-in-views` (grep-style regression test) |
| P2-gap | Idempotency | Ingest retry dedupe (client key / collectorId+flowSequence window) | F-048 (A3-12) | `ingest.retry.no-duplicate-queue-or-flow-rows` |
| P3-gap | Monitoring config | Scrape-path ↔ route agreement; alert rules exist; health endpoint readiness | F-023, F-059, F-060, F-066 (A5) | `prometheus.targets.match-implemented-routes` · `monitoring.rules-file-present` · `app.health.readiness-checks-db` |
| P3-gap | Ops scripts | Backup plaintext window (umask/pipe); restore URL not in argv | F-062, F-063 (A5-10/11) | `backup.dump.uses-0600-or-pipe` · `restore.drill.no-credentials-in-argv` |
| P3-gap | Data growth | Events search cost/case-sensitivity contract; ops-table retention | F-047, F-017/F-018 (A3) | `events.q.case-sensitivity.matches-doc` · `jobs.notifications.retention.sweeps-terminal-rows` |
| P3-gap | Governance docs | gov-verify ↔ applied protection consistency; CI header freshness | F-025, F-064 (A5-04/12) | `gov.verify.passes-against-applied-protection` (or documented allowlist) · `ci.header.matches-branch-protection-state` |

## Notes on the two baseline test failures

The 2 failing tests (`R61 P0-1` credential-free SSH first-contact capture) require a local `sshd`, which the sandbox lacks; they fail identically on `main` and are environment-dependent, not product defects (BASELINE.md). They are the existing coverage *for* the credential-free first-contact strength — keep them required once a `sshd`-equipped runner is available.

## Recommendation

Fold the P0-gap rows into the remediation wave as acceptance criteria: F-001, F-002, F-003, F-004, and F-007 fixes should not be called done without their paired tests above. The authorization-contract test is the right pattern to extend for the read-plane (F-008) and permission-negative rows.
