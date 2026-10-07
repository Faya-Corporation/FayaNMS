# STATE — FayaNMS GA remediation program (2026-10-06 re-audit)

> This file is the live engagement state for the **2026-10-06 full re-audit** program.
> The completed 2026-09 audit program (67 raw findings → 43 fixed + 23 deferred) is archived
> at `docs/review/notes/STATE-2026-09-program.md`; its REMEDIATION_PLAN is archived alongside it.

## Engagement inputs

- **Audit input:** `FayaNMS — Full End-to-End Production Readiness Re-Audit — 2026-10-06.md`
  (owner-supplied; audited branch `main`, HEAD `d281873971cf66d1b7724f53df3f130f7eff8bad`).
- **Audited HEAD = engagement start HEAD:** `d281873` ("Merge pull request #73", 2026-10-05T23:31:47Z).
- **Verdict of the audit:** NOT YET enterprise-production-ready. Application core **strong**; blockers are
  tenancy/authorization completion, simulated infrastructure surfaces, and missing release/staging/DR evidence.

## Ground truth (verified at engagement start)

- Sandbox checkout: `/home/z/my-project`, branch `main` @ `d281873`, clean worktree (sandbox-infra dirs only untracked).
- Stack: Next.js 16 App Router + TS, Bun, Prisma + PostgreSQL 16 (embedded Zonky 16.4.0 dev cluster on 127.0.0.1:5433,
  trust auth — sandbox-local dev only), worker `mini-services/worker` on :3030 (EdDSA two-plane service identity).
- Local deployment verified LIVE: app `/` and `/api/health` → 200; NextAuth credentials sign-in (seeded
  `admin@faya.local`) → session with `["*"]` permissions; worker claim → execute → complete journey SUCCEEDED
  (real CONFIG_BACKUP artifacts, e.g. `HQ-WAN-SRX-01 bytes=3638 flavor=junos`).
- Seed: `bun prisma/seed.ts` applied (66,108 rows) after `bun run db:deploy` replayed the committed migration history.
- Worker trust list note (ops, sandbox-local): the worker's loopback `/simulate/*` self-calls mint
  `iss=fayanms:worker` tokens, so the worker's `FAYANMS_SERVICE_PUBLIC_KEYS` must include BOTH the control-plane
  public key AND the worker's own public key (comma rotation list). Without it every job fails 401
  "Token signature verification failed" at the self-call. The repo's `.env.example` ownership block does not
  document this self-verification need — added to the remediation backlog (docs-only item).

## Finding re-verification (every OPEN P0/P1/P2 checked against `d281873` source — none trusted stale)

| ID | Finding | Verdict at `d281873` | Primary evidence |
|---|---|---|---|
| P0-R01 | Container release certification stale vs HEAD | **CONFIRMED-OPEN** | Last container publish evidence 2026-09-22 @ `5671bc5` (publish job failed, no digests); nothing for `d281873`. Workflow `.github/workflows/container.yml` (arm64 + publish, GHCR `sha-<head>` tags, SBOM/provenance) exists and is dispatchable. |
| P0-R02 | OCI staging never produced deployment evidence | **CONFIRMED-OPEN** | `.github/workflows/deploy-staging.yml` gates on `OCI_STAGING_HOST/USER/SSH_KEY/KNOWN_HOSTS` secrets; every recorded run skipped. `deploy/oci/README.md` declares the runbook **BLOCKED — EXTERNAL**. |
| P0-R03 | Database DR unproven | **CONFIRMED-OPEN** | `docs/runbooks/disaster-recovery.md`: RPO/RTO unapproved, off-host copy/restore drill/durations outstanding; footer declares **BLOCKED — EXTERNAL**. In-repo tooling already present: `deploy/oci/backup.sh` (age-encrypted pg_dump, retention), `restore-drill.sh`, `scripts/drill-restore.ts`, `src/lib/backups/retention.ts`. Missing: WAL archiving/PITR config, scheduled backup sidecar. |
| P0-R04 | Vendor certification T3 empty | **CONFIRMED-OPEN** | `docs/certification/MATRIX.md`: "NO T3 row exists yet"; §4 rows GOV-001-A ("OWNER ACTION REQUIRED… NOT ACTIVE") and CI-001-A ("INFRASTRUCTURE BLOCKED since run #34") are **stale** — branch protection is ACTIVE and all four checks are green on current main. |
| P0-R05 | "HA" surface is a simulation | **CONFIRMED-OPEN** | `src/lib/ha/topology.ts:5-12` "DEMO DATA — DOCUMENTED SIMULATED HA/DR DESIGN"; `POST /api/v1/ha/failover-test` performs staged sleeps + audit rows only. No demo-flag gating. |
| P0-R06 | Distributed collector fleet simulated | **CONFIRMED-OPEN** | `src/lib/collectors/distribution.ts:5-12` "DEMO DATA — DOCUMENTED SIMULATED AGENT FLEET"; rebalance is staged audit rows, no real redeploy. No real registration/heartbeat/lease/fencing control plane. |
| P0-R07 | Release documentation inconsistent | **CONFIRMED-OPEN** | `docs/implementation/CURRENT-STATE.md` snapshot 2026-09-23 @ `7e44361`: claims protection NOT ACTIVE (false), CI stale, worktree dirty; `release-evidence-7e44361.json` externalBlockers stale. `docs/release/GA-READINESS.md` does NOT exist. `docs/runbooks/release-promotion.md` is current. |
| P1-A01 | Report generation bypasses human site scope | **CONFIRMED-OPEN** | `src/app/api/v1/reports/run/route.ts` POST → `generateReport(reportType, { frequency, format })` (no scope); `src/lib/reports/generate.ts` has zero site-scope references (fleet-wide `db.device.findMany` etc.); scheduled path `src/app/api/v1/reports/execute/route.ts:174` identical; `ReportSchedule` model has **no** scope column (`prisma/schema.prisma:1014-1028`). |
| P1-A02 | `/sites` catalog is global | **CONFIRMED-OPEN** | `src/app/api/v1/sites/route.ts` calls `requireSessionRead` only; site rows + aggregates returned unfiltered; no `sessionScopeFor` import/use. |
| P1-A03 | Cross-site / `*` backup-policy actuation by site-limited principals | **CONFIRMED-OPEN** | `src/app/api/v1/backup-policies/route.ts` POST (comment "audit 13-c F-10 — owner decision, deliberately NOT changed here") and `…/[id]/route.ts` PATCH both validate site codes against inventory only — never against the session's site scope; `*` allowed for anyone holding `config.backup`. |
| P1-A04 | API clients have no expiry | **CONFIRMED-OPEN** | `prisma/schema.prisma:1111-1126` `ApiClient`: tokenHash/scopesJson/isActive/lastUsedAt/createdAt only — no `expiresAt`/`rotatedAt`; `src/lib/auth/api-client-auth.ts` verifies hash + `isActive` only. |
| P1-A05 | API clients/service identities unscoped (global) | **CONFIRMED-OPEN** | No `siteScopeJson` on `ApiClient`; humans get `User.siteScopeJson` (migration `20261003024531_add_user_site_scope`) — API clients have no resource-scope equivalent. |
| P1-O01 | Collector management is presentation-grade | **CONFIRMED-OPEN** | Same surface as P0-R06. |
| P1-O02 | HA/DR dashboard simulated; no demo gating | **CONFIRMED-OPEN** | Same surface as P0-R05. |
| P1-O03 | Protocol DLQ has no operator recovery workflow | **CONFIRMED-OPEN** | `ProtocolEventQueue.status` QUEUED/IN_FLIGHT/DELIVERED/DEAD with bounded retries (`src/lib/protocol/queue.ts`); only `…/queue/retention/prune` route exists — no dead-list dashboard API, no requeue/quarantine, no alert threshold. |
| — | Report formats: PDF/XLSX are delivery tags only | **CONFIRMED-OPEN** | `src/app/api/v1/reports/run/route.ts:38-43` FORMAT HONESTY comment ("there is no binary renderer"); no PDF/XLSX library in package.json. |
| P2-S01 | No absolute human session lifetime | **CONFIRMED-OPEN** | `src/lib/auth/options.ts:86-94`: maxAge is a SLIDING window; "an ABSOLUTE cap is deliberately NOT implemented (owner decision)". No `iat`-age enforcement anywhere in `src/lib/auth/`. |
| — | Broadcast notifications share global read state | **CONFIRMED-OPEN** | `src/app/api/v1/notifications/read/route.ts:13-14` "Demo simplification: marking a broadcast row read is global"; `Notification.readAt` single column; no `NotificationReceipt` model. |
| — | Single-host compose, no infra HA | **CONFIRMED-OPEN (architecture decision)** | `deploy/oci/compose.yml` single-host profile (postgres/migrator/app/worker/caddy); no HA profile. |
| P3 | No release/tag/version; package 0.2.1 | **CONFIRMED-OPEN** | `package.json` version 0.2.1; no `docs/release/`; evidence generator `scripts/release/evidence-manifest.ts` exists (last manifest @ `7e44361`, 2026-09-23). |
| — | Monitoring failure/alert drills | **CONFIRMED-OPEN (external)** | `monitoring/` config exists (Prometheus/OTel/alert rules); drills require the staging environment (P0-R02). |

**Zero findings were stale.** Every OPEN item re-verified against current source.

## Disposition buckets

- **Repository-actionable:** P1-A01..A05, P1-O03, report formats, P2-S01, notification receipts, P0-R05/R06/R07
  (code/docs), doc-drift repair, P3 release prep, DR in-repo tooling (WAL/PITR templates, backup sidecar, drill docs).
- **Repo-actionable attempt, may hit owner-only boundaries:** P0-R01 (dispatch `container.yml` on the post-remediation
  SHA; GHCR publish runs on GitHub infra with repo-scoped `GITHUB_TOKEN`).
- **BLOCKED — EXTERNAL (owner/infra required, never fabricated):** P0-R02 (OCI staging secrets/host), P0-R03 final
  closure (off-host storage, key custody, real restore target, approved RPO/RTO), P0-R04 (T3 vendor appliances),
  monitoring drill execution (needs staging), production HA profile decision, release tag/GA approval.

## Wave plan

See `REMEDIATION_PLAN.md` (GA-01..GA-08 + Wave OPS-1 cross-platform fresh-install operations). Live progress: `PROGRESS.md`.

## Post-remediation re-verification (Task 9, 2026-10-07 — current main `1c7c397`)

Every finding of the 2026-10-06 re-audit re-checked against CURRENT source
after waves GA-1..GA-6 + GA-4b merged (PRs #74–#85). No verdict inherited
from a commit message — each row below was re-verified by reading the live
source at `1c7c397` and/or the GitHub Actions API read-back of 2026-10-07.

| Finding (audit §) | Verdict at `1c7c397` | Re-verification evidence |
|---|---|---|
| P0-R01 container-release certification | **CERTIFIED on exact current main** | Container workflow run **#72 success** on `1c7c397` (Actions API read-back 2026-10-07T02:16Z; runs #69–#71 cancelled via concurrency group). GHCR publish under `sha-1c7c397` tags; immutable digests owner-read-back pending (registry not anonymously readable). |
| P0-R02 OCI staging evidence | **OPEN — BLOCKED — EXTERNAL** | Runs #66–#72 of `Deploy exact certified SHA to OCI staging` all `skipped` on 2026-10-07 read-back (missing `OCI_STAGING_*` owner secrets). |
| P0-R03 database DR | **In-repo tooling SHIPPED; drill/ratification OPEN — EXTERNAL** | `deploy/oci/compose.yml`: `archive_mode=on` + `fayanms-wal` volume; `deploy/oci/backup-sidecar/` (Dockerfile + non-root entrypoint); PITR runbook §. Off-host copy, key custody, real restore drill, RPO/RTO approval remain owner items. |
| P0-R04 vendor T3 certification | **OPEN — BLOCKED — EXTERNAL** | `docs/certification/MATRIX.md` T3 rows still empty (owner lab); stale §4 GOV/CI rows corrected at GA-6. |
| P0-R05 "HA" simulation exposure | **FIXED (fail-closed)** | `src/lib/demo/simulation-guard.ts`; `POST /api/v1/ha/failover-test` imports `isDemoMode`/`simulationDisabledFail` → 403 `SIMULATION_DISABLED` unless `FAYANMS_DEMO_MODE=true`. Pinned by `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| P0-R06 / P1-O01 collector fleet simulated | **FIXED (real control plane)** | `prisma/schema.prisma` `CollectorAgent` + `CollectorAssignment` (lease epochs/fencing); `src/lib/collectors/control-plane.ts` (register/heartbeat/fencing/reconcile/failover/reap); machine routes `collectors/{register,heartbeat,assignments}` + admin routes `admin/collectors/*` (agents, failover, reconcile, reap, distribution, rebalance-plan); dual-plane honesty in `distribution.ts`. Pinned by 30-pin `tests/audit/ga4b-collector-control-plane.test.ts`. |
| P0-R07 release-doc inconsistency | **FIXED** | `docs/release/GA-READINESS.md` is the canonical gate table (rows re-verified 2026-10-07); `CURRENT-STATE.md` carries the GA-6 truth banner (snapshot body test-pinned, `tests/audit/current-state-ledger.test.ts`); `MATRIX.md` §4 retotaled. |
| P1-A01 report contents fleet-wide | **FIXED (scope frozen)** | `ReportSchedule.scopeJson`; `generate.ts` freeze/parse helpers + scope-intersected queries per report type; run route freezes acting scope (`run/route.ts:92`); worker `execute/route.ts:177` uses the SCHEDULE's frozen scope. `tests/audit/ga2-report-scope-notifications.test.ts`. |
| P1-A02 `/sites` global | **FIXED** | `sites/route.ts:42` `sessionScopeFor` → site rows `code IN scope.codes` + aggregates via `scopedDeviceWhere`; wildcard byte-identical. `tests/audit/ga1-tenancy-sites-backup.test.ts`. |
| P1-A03 cross-site backup policies | **FIXED** | POST + PATCH return 403 `SITE_SCOPE_FORBIDDEN` (`backup-policies/route.ts:181`, `[id]/route.ts:191`) for non-wildcard sessions; `*` refused. Same suite. |
| P1-A04 API clients no expiry | **FIXED** | `ApiClient.expiresAt/rotatedAt/lastRotatedFromId` (schema); `resolveActiveClient()` refuses expired centrally → 401 `API_CLIENT_EXPIRED` (`api-client-auth.ts:197`). `tests/audit/ga3-api-client-lifecycle.test.ts`. |
| P1-A05 API clients unscoped | **FIXED** | `ApiClient.siteScopeJson` (null=wildcard legacy, `[]`=deny-all) enforced via the human scope primitives (`api-client-auth.ts:222+`). Same suite. |
| P1-O02 HA/DR dashboard simulated, ungated | **FIXED (demo-gated)** | Same surface as P0-R05. |
| P1-O03 DLQ operator recovery absent | **FIXED** | `api/v1/protocol/queue/dead/` list + guarded idempotent `dead/requeue` + `PROTOCOL_DLQ_REQUEUED` audit + `fayanms_protocol_queue_dead` metric/alert rule. `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| Report formats PDF/XLSX fake | **FIXED** | Real dependency-free renderers `src/lib/reports/render-pdf.ts` (PDF 1.4) + `render-xlsx.ts` (OOXML), render-at-delivery; byte-level tests `tests/audit/ga5-report-renderers.test.ts`. |
| Sophos production transport | **FIXED (in-repo transport; T3 external)** | CERT-006: real WebAPI/TLS transport `mini-services/worker/webapi-transport.ts` (read-only two-action allowlist, CA enrollment, TLS-before-credential), harness `mini-services/worker/harness/sfos-webapi.ts`, CI certification section; pinned by `tests/audit/sfos-webapi.test.ts`. Physical T3 remains P0-R04. |
| P2-S01 no absolute session lifetime | **FIXED** | `FAYANMS_SESSION_MAX_AGE_HOURS` (default 12, 0=legacy off) enforced on `iat` age first in the jwt refresh path (`src/lib/auth/options.ts:271`); `tests/auth/session-lifetime.test.ts` (10 tests). |
| P2 broadcast notifications global read | **FIXED** | `NotificationReceipt` model + per-user receipts; broadcast `readAt` stays null (`notifications/read/route.ts:15+`). `tests/audit/ga2-report-scope-notifications.test.ts`. |
| P2 single-host compose no HA | **OPEN — architecture/owner decision** (unchanged posture, documented) | `deploy/oci/compose.yml` standard single-host profile; HA profile is the owner's deployment decision (audit §11). |
| P2 monitoring drills | **OPEN — EXTERNAL** (needs staging) | `monitoring/` config shipped; drill execution requires P0-R02 staging. |
| P3 no release tag/version 0.2.1 | **OPEN — owner decision** | `package.json` 0.2.1; no git tags; `docs/release/CHANGELOG-GA-draft.md` drafted; tag + GA approval owner-gated. |

**Net:** 14 of 21 register rows FIXED at green CI merges; 4 rows are
owner/external (staging, T3, DR drill+risk sign-off, final re-audit); 3 rows
are explicit owner decisions (single-host HA posture, monitoring drill
scheduling, release tag/GA approval). Nothing actionable in-repo remains
open. Push/PR credential note (Task 9): this sandbox re-clone is anonymous —
the docs commit for this pass is prepared locally and requires the owner's
PAT to push/PR (recorded in worklog Task 9).
