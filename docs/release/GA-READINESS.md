# GA-READINESS — the ONE canonical release gate table

> **Truth discipline (2026-10-06 re-audit, P0-R07):** this file is the single
> source for the release gate posture. Every row carries its evidence and the
> EXACT way to re-verify it — re-run the check before trusting any row. A row
> may only move when the re-verification says so. Nothing here is inferred
> from an older SHA; nothing external is claimed without its owner artifact.
> Superseded snapshots: `docs/implementation/CURRENT-STATE.md` (narrative
> history) and `docs/certification/MATRIX.md` §4 (governance history).

**Scope SHA:** main @ `1c7c397` at the Task 9 re-audit verification (PR #86). Main has since advanced to `690da94` via four reviewed merges — #88 (next 16.3.8 security bump + events-ordering determinism), #86 (Task 9 docs), #87 (OPS-1 cross-platform operations), #89 (delivery record) — each landing with gate+e2e+browser+scan+CodeQL green. Advanced again to `b7aecd1` via #91 (fix(ops): fresh-install seed fails without bootstrapped dev identity key — `ensure_data_key`/`Ensure-DataKey` fallback in both ops entries + 14th pin; live-verified end-to-end on a fully reset sandbox), gate green.
**Verified:** 2026-10-07 (UTC) — GitHub Actions API read-back + local source re-verification sweep (Task 9, 2026-10-06 re-audit review); re-read 2026-10-08 (runs `37712750128` + `37713485157` on `b7aecd1`).

## Gate table

| # | Gate | Status | Evidence (re-verify how) |
|---|------|--------|--------------------------|
| 1 | **Repository protection** — `main` guarded | 🟡 **ACTIVE, PARTIAL** | API `GET /branches/main/protection` (2026-10-06): required checks `gate`,`e2e`,`browser`,`scan` strict=true; force-push forbidden; deletion forbidden. **Residual gap (owner):** required approving review count = 0, conversation resolution off. |
| 2 | **CI green on main** | 🟢 **GREEN** | Run `#252` on `1c7c397` success (Actions API read-back 2026-10-07); main-push run `37697993027` on `690da94` success (2026-10-07, gate+e2e+browser+scan+CodeQL all green — scan clean on next 16.3.8 after PR #88); **main-push run `37712750128` on `b7aecd1` success** (Actions API read-back 2026-10-08, gate+e2e+browser+scan+CodeQL green). Re-verify: `gh run list -b main -w "CI gate"`. |
| 3 | **Supply-chain scan** | 🟢 **GREEN** | `scan` job green on every merged wave PR (#74–#79); sharp override pinned 0.35.5 (GHSA-wq5f-xc86-pv6w) — `package.json` `overrides`. Re-verify: the `scan` check on latest main run. |
| 4 | **AuthN/AuthZ contract** | 🟢 **GREEN** | `tests/auth/authorization-contract.test.ts` inventory (every mutating/GET handler carries an authoritative gate marker; allowlist may only shrink); full sweep 2453 pass / 0 fail at GA-5 (`97e3ba5`). Re-verify: `bun test tests/`. |
| 5 | **Tenancy / site scope (P1-A01..A05)** | 🟢 **CLOSED** | GA-1 `fe9c39e` (/sites + backup policies), GA-2 `f817e3a` (report scope freeze + receipts), GA-3 `3af334c` (API-client expiry + site scope). Re-verify: `tests/audit/ga1-*.test.ts ga2-*.test.ts ga3-*.test.ts`. |
| 6 | **Simulation honesty (P0-R05/P1-O02)** | 🟢 **CLOSED** | GA-4 `5140b2c`: HA failover-test + rebalance APPLY fail-closed behind `FAYANMS_DEMO_MODE` (gate-before-plan ordering fixed in `9a69c20`). Re-verify: `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| 7 | **DLQ operator recovery (P1-O03)** | 🟢 **CLOSED** | GA-4 `5140b2c`: dead-letter list + guarded idempotent requeue + `PROTOCOL_DLQ_REQUEUED` audit + `fayanms_protocol_queue_dead` metric/alert rule. Re-verify: `tests/audit/ga4-simulation-gating-dlq.test.ts`. |
| 8 | **Report format honesty** | 🟢 **CLOSED** | GA-5 `24ccacf`: real dependency-free PDF 1.4 + XLSX renderers, render-at-delivery, byte-level tests (xref walk, CRC-32 zip walk). Re-verify: `tests/audit/ga5-report-renderers.test.ts`. |
| 9 | **Absolute session lifetime (P2-S01)** | 🟢 **CLOSED** | `FAYANMS_SESSION_MAX_AGE_HOURS` (default 12, 0=off, invalid→fail-safe default) enforced in the jwt refresh path before any DB work; iat anchor verified preserved across next-auth re-encodes. Re-verify: `tests/auth/session-lifetime.test.ts`. |
| 10 | **DB DR tooling (P0-R03 in-repo)** | 🟡 **TOOLING SHIPPED, DRILL EXTERNAL** | WAL archiving (`archive_mode=on` → `fayanms-wal` volume) + scheduled age-encrypted backup sidecar + PITR runbook §: `deploy/oci/compose.yml`, `deploy/oci/backup-sidecar/`, `docs/runbooks/disaster-recovery.md` (merged `3bd2280` via PR #80). **BLOCKED — EXTERNAL:** off-host copy, key custody, real-target drill, RPO/RTO approval. |
| 11 | **Container certification / GHCR (P0-R01)** | 🟢 **CERTIFIED ON EXACT CURRENT MAIN** | Run **#72** on `1c7c397` success (2026-10-07T02:16Z); run `37699057407` on `690da94` success (2026-10-07T23:35Z). **RE-CERTIFIED: run `37713485157` on `b7aecd1` — success** (Actions API read-back 2026-10-08; one earlier same-SHA attempt cancelled by the workflow_run chain, the completing run is the recorded one). Pipeline green: ARM64 build + runtime smoke + trivy (fs/app/worker) + SBOM; images published under `sha-b7aecd1`. **Residual (owner):** immutable digests read back owner-side — GHCR remains unreadable to the repository agent even with an authenticated token (registry token exchange 401 + packages API 403 on 2026-10-08; the shared PAT carries no packages read scope); staging deploy of these digests remains row 13. |
| 12 | **Vendor T3 certification (P0-R04)** | 🔴 **BLOCKED — EXTERNAL** | No physical/virtual vendor appliances available to the sandbox; `docs/certification/MATRIX.md` section 3 is the lab procedure; public-demo-device partial plane documented. Owner lab required. |
| 13 | **Staging deploy + burn-in (P0-R02)** | 🔴 **BLOCKED — EXTERNAL** | `deploy-staging.yml` gates on `OCI_STAGING_*` secrets (all recorded runs skipped); owner must provision host/secrets and sign off. |
| 14 | **Independent final re-audit** | 🔴 **BLOCKED — EXTERNAL** | Owner decision — scheduled after GA waves complete and staging burn-in exists. |
| 15 | **Collector control plane (P0-R06/P1-O01)** | 🟢 **CLOSED** | GA-4b merged (PR #83 `839df83` + fixes #84 `bdfb14f`): real registration/heartbeat/lease-epoch/fencing/failover/rebalance over `CollectorAgent`+`CollectorAssignment` rows; machine plane (telemetry-scope JWT) + admin plane; dual-plane routes keep the labeled simulation fallback. Re-verify: `tests/audit/ga4b-collector-control-plane.test.ts` (30 pins; passes on migrations-only CI AND the seeded local fleet) + the machine-surface registration scan (the 3 collector routes are registered in `MACHINE_EXACT_ROUTES`). Real remote agent rollout remains deploy-side documented. |

## Readiness verdict

**Repository-actionable remediation is COMPLETE:** every P0/P1/P2 finding from
the 2026-10-06 register is fixed at a green CI merge (rows 3–9, 15), shipped
as in-repo tooling with the drill explicitly external (row 10), or
BLOCKED — EXTERNAL with the exact missing owner input (rows 12–14). Container
certification is green on the exact current main SHA (row 11). A GA promotion
now requires ONLY owner-side inputs: row 1 (approving-review ruleset), row 10
(real DR drill), rows 12–14 (T3 vendor lab, staging burn-in, final re-audit
sign-off), plus the row-11 digest read-back. These cannot be claimed from
inside the repository.

**Re-verification trail (Task 9, 2026-10-07):** every finding of the
2026-10-06 re-audit was re-checked against current source at `1c7c397` —
verdicts and evidence in `docs/review/STATE.md` § "Post-remediation
re-verification".
