# GA-READINESS — the ONE canonical release gate table

> **Truth discipline (2026-10-06 re-audit, P0-R07):** this file is the single
> source for the release gate posture. Every row carries its evidence and the
> EXACT way to re-verify it — re-run the check before trusting any row. A row
> may only move when the re-verification says so. Nothing here is inferred
> from an older SHA; nothing external is claimed without its owner artifact.
> Superseded snapshots: `docs/implementation/CURRENT-STATE.md` (narrative
> history) and `docs/certification/MATRIX.md` §4 (governance history).

**Scope SHA:** main @ `3bd2280` (post GA-6 merge).
**Verified:** 2026-10-06 (UTC) — GitHub API read-back + local stack probes.

## Gate table

| # | Gate | Status | Evidence (re-verify how) |
|---|------|--------|--------------------------|
| 1 | **Repository protection** — `main` guarded | 🟡 **ACTIVE, PARTIAL** | API `GET /branches/main/protection` (2026-10-06): required checks `gate`,`e2e`,`browser`,`scan` strict=true; force-push forbidden; deletion forbidden. **Residual gap (owner):** required approving review count = 0, conversation resolution off. |
| 2 | **CI green on main** | 🟢 **GREEN** | Run `37538435081` on `5140b2c` success; run `37530420835` on `3af334c` success (Actions API read-back 2026-10-06). Re-verify: `gh run list -b main -w "CI gate"`. |
| 3 | **Supply-chain scan** | 🟢 **GREEN** | `scan` job green on every merged wave PR (#74–#79); sharp override pinned 0.35.5 (GHSA-wq5f-xc86-pv6w) — `package.json` `overrides`. Re-verify: the `scan` check on latest main run. |
| 4 | **AuthN/AuthZ contract** | 🟢 **GREEN** | `tests/auth/authorization-contract.test.ts` inventory (every mutating/GET handler carries an authoritative gate marker; allowlist may only shrink); full sweep 2453 pass / 0 fail at GA-5 (`97e3ba5`). Re-verify: `bun test tests/`. |
| 5 | **Tenancy / site scope (P1-A01..A05)** | 🟢 **CLOSED** | GA-1 `fe9c39e` (/sites + backup policies), GA-2 `f817e3a` (report scope freeze + receipts), GA-3 `3af334c` (API-client expiry + site scope). Re-verify: `tests/audit/ga1-*.test.ts ga2-*.test.ts ga3-*.test.ts`. |
| 6 | **Simulation honesty (P0-R05/P1-O02)** | 🟢 **CLOSED** | GA-4 `5140b2c`: HA failover-test + rebalance APPLY fail-closed behind `FAYANMS_DEMO_MODE` (gate-before-plan ordering fixed in `9a69c20`). Re-verify: `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| 7 | **DLQ operator recovery (P1-O03)** | 🟢 **CLOSED** | GA-4 `5140b2c`: dead-letter list + guarded idempotent requeue + `PROTOCOL_DLQ_REQUEUED` audit + `fayanms_protocol_queue_dead` metric/alert rule. Re-verify: `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| 8 | **Report format honesty** | 🟢 **CLOSED** | GA-5 `24ccacf`: real dependency-free PDF 1.4 + XLSX renderers, render-at-delivery, byte-level tests (xref walk, CRC-32 zip walk). Re-verify: `tests/audit/ga5-report-renderers.test.ts`. |
| 9 | **Absolute session lifetime (P2-S01)** | 🟢 **CLOSED** | `FAYANMS_SESSION_MAX_AGE_HOURS` (default 12, 0=off, invalid→fail-safe default) enforced in the jwt refresh path before any DB work; iat anchor verified preserved across next-auth re-encodes. Re-verify: `tests/auth/session-lifetime.test.ts`. |
| 10 | **DB DR tooling (P0-R03 in-repo)** | 🟡 **TOOLING SHIPPED, DRILL EXTERNAL** | WAL archiving (`archive_mode=on` → `fayanms-wal` volume) + scheduled age-encrypted backup sidecar + PITR runbook §: `deploy/oci/compose.yml`, `deploy/oci/backup-sidecar/`, `docs/runbooks/disaster-recovery.md` (merged `3bd2280` via PR #80). **BLOCKED — EXTERNAL:** off-host copy, key custody, real-target drill, RPO/RTO approval. |
| 11 | **Container certification / GHCR (P0-R01)** | 🟡 **CERTIFICATION IN FLIGHT** | Workflow re-enabled (was `disabled_manually`); the startup-policy-stale smoke script and the devDep-heavy migrator (CVE-2026-93687 exposure, no upstream fix) were FIXED in PR #80 and certified green on the PR head (`e52d650` — ARM64 build + runtime smoke + all three trivy scans pass). Main-merge certification run **`37549406836`** on `3bd2280` (supersedes `37548166263`/`24ccacf` via the concurrency group). Digests recorded here when green. |
| 12 | **Vendor T3 certification (P0-R04)** | 🔴 **BLOCKED — EXTERNAL** | No physical/virtual vendor appliances available to the sandbox; `docs/certification/MATRIX.md` section 3 is the lab procedure; public-demo-device partial plane documented. Owner lab required. |
| 13 | **Staging deploy + burn-in (P0-R02)** | 🔴 **BLOCKED — EXTERNAL** | `deploy-staging.yml` gates on `OCI_STAGING_*` secrets (all recorded runs skipped); owner must provision host/secrets and sign off. |
| 14 | **Independent final re-audit** | 🔴 **BLOCKED — EXTERNAL** | Owner decision — scheduled after GA waves complete and staging burn-in exists. |

## Readiness verdict

**Repository-actionable remediation is closing:** every P0/P1/P2 finding from
the 2026-10-06 register is either fixed at a green CI merge (rows 3–9),
shipped as in-repo tooling with the drill explicitly external (row 10), or
BLOCKED — EXTERNAL with the exact missing owner input (rows 12–14). A GA
promotion requires rows 1 (approval gap), 11 (digests) resolved and rows
12–14 signed off by the owner — these cannot be claimed from inside the
repository.
