# FayaNMS Cloud Platform Implementation Progress

**Repository:** `fayafatehi/FayaNMS`  
**Execution branch:** `codex/fayanms-cloud-platform`  
**Initial main SHA:** `7aef0a330dc8f965fb496b735eb8a97b8d2c5149`  
**Current main readback:** `3ab5c7eb3118b9b37c6286058de99b41bb67cac0`  
**Execution date:** 2026-09-21  
**Authoritative inputs:** Cloud Development/CICD/OCI Implementation Plan, Executive Production Review, Full Independent Production Audit, Production Remediation Roadmap, Competitive Benchmark, Production Gap Register.

## Operating contract

This ledger records repository implementation evidence separately from external OCI, DNS, VPN, physical hardware, and GitHub-owner actions. A task is `DONE` only when its repository acceptance criteria and available automated evidence are satisfied. No credentials, private keys, device secrets, production backups, or production data may be committed.

Allowed statuses: `TODO`, `IN PROGRESS`, `BLOCKED — EXTERNAL`, `BLOCKED — TECHNICAL`, `DONE`, `DEFERRED — APPROVED`.

## Baseline evidence

| Item | Evidence |
|---|---|
| Current branch | No local checkout was available in the execution workspace; remote implementation branch created from `main` |
| `main` HEAD | `7aef0a330dc8f965fb496b735eb8a97b8d2c5149` |
| Remote protection | Live branch readback: `protected:false`, `protection.enabled:false`, required checks enforcement `off` |
| Latest CI | Run `35546034099` on exact HEAD: `gate PASS`, `e2e PASS`, `scan PASS`, `browser FAIL` |
| Browser failure | Playwright target closed during axe injection in B3b; B4/B5 then failed because the shared browser was closed |
| Previous green CI | Run `35545341206` on `9f2b6d92cd3e29eb091c0de3cb2694090405c07f`: all four jobs passed |
| Open PRs | Draft PR #12: `codex/fayanms-cloud-platform` → `main` |
| Repository access | GitHub connector has authenticated repository read/write access; plain Git clone is unavailable in this execution container |
| Security note | Prior audit reports an exposed PAT; rotation/revocation remains an owner action and no token is copied into this repository |

## Task status

| ID | Wave | Severity | Status | Dependencies | Owner | Evidence / blocker | Next action |
|---|---|---:|---|---|---|---|---|
| CLOUD-00-01 | Baseline and safety | P0 | DONE | none | Codex | Remote branch/main/CI/PR/deployment inventory recorded above | Preserve baseline while implementing |
| CLOUD-00-02 | Secret exposure review | P0 | IN PROGRESS | CLOUD-00-01 | Codex + owner | Repository-side secret controls and Gitleaks confirmation pending; reported PAT rotation is external | Add dev/deploy secret boundaries; run CI secret scan |
| CLOUD-00-03 | Implementation branch | P0 | DONE | CLOUD-00-01 | Codex | `codex/fayanms-cloud-platform` created from baseline SHA | Keep all changes on branch; never force-push |
| CLOUD-01 | Codespaces | P0 | IN PROGRESS | CLOUD-00 | Codex | `.devcontainer` Dockerfile/Compose/config/bootstrap/runbook are committed; live Codespace creation remains unproven in this executor | Owner opens a Codespace and records PostgreSQL/bootstrap evidence |
| CLOUD-02 | CI certification | P0 | IN PROGRESS | CLOUD-00 | Codex | Run 35560343614 on exact head 783ac4c8 passed gate/e2e/browser/scan; current worker-metrics/action-refresh head is pending certification | Read current-head gate/e2e/browser/scan results |
| CLOUD-03 | ARM64 container certification | P0 | BLOCKED — TECHNICAL | CLOUD-02 | Codex | Run 35560343558 built all three ARM64 images and passed runtime smoke, then hard-failed Trivy on 43 HIGH/0 CRITICAL Debian 13.7 findings with affected/unfixed packages | Remediate or replace the vulnerable base/runtime package set; rerun hard-fail ARM64 scans |
| CLOUD-04 | GHCR immutable images | P0 | BLOCKED — TECHNICAL | CLOUD-03 | Codex | Publication workflow is repository-complete with app/worker/migrator SHA tags, SBOM/provenance, Trivy, and packages:write-only permissions; publication cannot proceed while ARM64 Trivy is red | Resolve CLOUD-03, then certify main push and read back GHCR digests/SBOMs |
| CLOUD-05 | OCI foundation | P0 | BLOCKED — EXTERNAL | CLOUD-04 | Codex + owner | Hardened host/bootstrap/network policy and operator runbook committed; tenancy/VM/NSG actions require owner access | Owner creates isolated compartment/VCN/NSG/ARM64 VM and supplies readback |
| CLOUD-06 | OCI runtime | P0 | BLOCKED — EXTERNAL | CLOUD-05 | Codex + owner | Immutable hardened Compose, env contract, deploy/rollback/health scripts committed | Install on owner-controlled host and capture runtime evidence |
| CLOUD-07 | HTTPS/reverse proxy | P0 | BLOCKED — EXTERNAL | CLOUD-06 | Codex + owner | Caddy HTTPS, HSTS, CSP, frame and permissions headers committed | Owner supplies DNS/ACME and proves external HTTPS-only access |
| CLOUD-08 | Automated staging deploy | P0 | BLOCKED — EXTERNAL | CLOUD-07 | Codex + owner | Exact-SHA protected-environment SSH workflow committed | Owner configures staging secrets/approval and runs deployment |
| CLOUD-09 | Health/smoke gate | P0 | BLOCKED — EXTERNAL | CLOUD-08 | Codex | Fail-closed health script and release evidence runbook committed; no staging endpoint exists here | Run against OCI staging and retain smoke evidence |
| CLOUD-10 | Observability | P1 | IN PROGRESS | CLOUD-09 | Codex | App /api/metrics and worker /api/metrics contracts are implemented with token gating; Prometheus/OTel configs and internal profile committed; staging alert proof and profile image digest review remain open | Certify current worker metrics slice, resolve profile digests, then run a controlled alert test in staging |
| CLOUD-11 | Network protocol lab | P1 | IN PROGRESS | CLOUD-10 | Codex | Internal lab network bootstrap and safety runbook committed; real protocol receivers remain unimplemented | Build collectors/harnesses before opening ports |
| CLOUD-12 | Controlled telemetry ports | P1 | BLOCKED — EXTERNAL | CLOUD-11 | Codex + owner | Least-privilege port policy committed; no listeners should be opened yet | Apply only after receiver implementation and owner NSG/firewall review |
| CLOUD-13 | VPN/physical device lab | P1 | BLOCKED — EXTERNAL | CLOUD-12 | Codex + owner | Hardware certification matrix and isolated-lab runbook committed | Owner supplies lab VPN/devices and executes matrix |
| CLOUD-14 | Database backup/DR | P1 | BLOCKED — EXTERNAL | CLOUD-13 | Codex + owner | Encrypted backup and isolated restore-drill scripts/runbook committed; no off-host target/key exists here | Configure object storage/key custody and run restore drill |
| CLOUD-15 | Security/governance | P1 | BLOCKED — EXTERNAL | CLOUD-14 | Codex + owner | CODEOWNERS, least-privilege workflows, secret boundary gate, and governance runbook committed | Owner enables branch protection/ruleset and staging environment; read back live state |
| CLOUD-16 | Release promotion | P1 | BLOCKED — EXTERNAL | CLOUD-15 | Codex + owner | Exact-SHA promotion workflow/runbook committed; no OCI target or production approval exists here | Execute staging promotion, burn-in, and independent release gate |

## Round log

### Round 0 — baseline and branch

- Completed: remote baseline reconciliation; branch created from exact `main` SHA.
- Files changed: this ledger.
- Tests: no local test runner available before repository materialization.
- Validation: GitHub source, branch, CI run/job state, and open PR state read through authenticated connector.
- Commit SHA: pending connector commit response.
- CI: baseline run `35546034099` is red in browser only.
- Newly discovered finding: shared Playwright browser process is not resilient when Chromium/page closes during the dashboard axe journey.
- Blockers: owner must rotate the previously exposed PAT; local Git clone is technically unavailable in this container.
- Remaining risk: the baseline SHA is not release-certifiable until browser is green and governance is enforced.
- Next task: CLOUD-01 devcontainer and CLOUD-02 browser lifecycle repair.

### Round 1 — cloud foundation and CI remediation

- Completed: Codespaces definition, isolated PostgreSQL service, safe bootstrap, CI browser isolation/crash diagnostics, browser artifact retention, refreshed action pins, ARM64 app/worker/migrator build workflow, immutable GHCR publication contract, hardened OCI Compose/Caddy/deploy/rollback/health scripts, monitoring foundation, isolated lab boundary, encrypted backup/restore drill, governance/release runbooks, and cloud-layout validation gate.
- Files changed: .devcontainer/*; deploy/oci/*; deploy/lab/*; monitoring/*; scripts/ci/arm64-runtime-smoke.sh; scripts/verification/validate-cloud-layout.sh; .github/workflows/ci.yml; .github/workflows/container.yml; .github/workflows/deploy-staging.yml; .github/CODEOWNERS; docs/runbooks/*; hardware certification matrix; Dockerfile.migrator; this ledger.
- Tests: repository-side shell/YAML validation is wired into CI; latest CI and ARM64 runs were still in progress at ledger update time. No local test execution was possible because plain Git clone is unavailable in this executor.
- Validation results: baseline browser failure reproduced in remote logs; browser fixture now isolates each Chromium process and records page crashes; image publication is conditioned on successful main CI workflow-run and uses packages:write only.
- Commit SHAs: browser repair `8c8da91`; Codespaces `db10f08`; CI repair `e6d568b`; container/multi-image workflow `bb303e9`; OCI/DR/lab foundations continue through current branch head.
- CI status: exact-head CI run `35558323553` and container run `35558323535` were IN PROGRESS at this update.
- Newly discovered findings: main advanced from the initial branch point to `3ab5c7e`; monitoring profile image digests are not yet resolved, so the profile is not production-enabled; app/worker metrics endpoints and real protocol receivers are still absent.
- Blockers: PAT revocation, branch protection/ruleset, Codespaces proof, OCI resources/credentials/DNS, staging approval, VPN, off-host backup target/key, and physical hardware are external.
- Remaining risks: exact CI/ARM64 results pending; migration image publication and worker image publication need green main CI; monitoring tag-to-digest replacement is required before production use; current product remains blocked by real monitoring/hardware/restore/IAM gaps from the authoritative audits.
- Ruling: the branch was created from `7aef0a3` before `main` advanced to `3ab5c7e`; no force-rebase or history rewrite is performed, preserving unrelated main work and leaving reconciliation to the PR merge base. Cost if wrong: temporary branch divergence or conflict resolution at merge.
- Ruling: monitoring images remain tag-pinned in the optional profile because registry digest resolution was unavailable in this executor; the profile is explicitly blocked from production enablement until reviewed digests are committed. Cost if wrong: supply-chain immutability is incomplete for that optional profile.
- Next task: read the latest CI and ARM64 job evidence; fix any failure, then continue repository-actionable observability/protocol/DR hardening.


### Round 2 — CI security repair, ARM64 evidence, and metrics slice

- Completed: replaced the permission-dependent Gitleaks PR annotation action with a checksum-verified local Gitleaks 8.24.3 history + working-tree scan under workflow-level contents: read; removed the fixed ARM64 smoke credential from current code; added exact historical fingerprint isolation without rewriting published history; refreshed Docker QEMU/Buildx actions to Node 24 releases; added the worker Prometheus metrics endpoint and contract test.
- Files changed: .github/workflows/ci.yml; .github/workflows/container.yml; .gitleaksignore; .gitleaks.toml; scripts/ci/arm64-runtime-smoke.sh; mini-services/worker/index.ts; tests/audit/cloud-metrics.test.ts; this ledger.
- Tests: TDD red run 35562394423 failed only at the new worker metrics contract (1198 pass, 18 skip, 1 fail, expected 200/received 404); implementation commits 33d3a423 and d31aecb5 follow that red evidence. Earlier metrics route red run 35558626111 recorded 1196 pass, 18 skip, 2 fail before the app route implementation.
- Validation results: CI run 35560343614 on exact head 783ac4c8 passed gate, e2e, browser, and scan; Gitleaks, Semgrep, OSV, CycloneDX SBOM, Trivy filesystem/image scans, production build, migrations, unit/security suite, SSH harness, axe, keyboard, RTL, and browser diagnostics artifact all passed. ARM64 run 35560343558 built app/worker/migrator images, verified ARM64 architecture, and passed runtime smoke; its hard-fail Trivy scan found 43 HIGH and 0 CRITICAL Debian 13.7 findings, with affected/unfixed util-linux, libacl, systemd, ncurses, and perl packages.
- Commit SHAs: Gitleaks wrapper repair c2912f2; ephemeral smoke credentials 3cd34718; path-only Gitleaks restoration 36cf0e43; historical fingerprint file 783ac4c8; Node 24 Docker actions 80d7c364; worker metrics implementation d31aecb5.
- CI status: current branch head is d31aecb5; the current-head CI/container runs are pending after the latest worker metrics commits. The preceding exact-head CI is green; the preceding exact-head ARM64 container certification is red only at the vulnerability scan after build/smoke success.
- Newly discovered findings: the original Gitleaks action failed before scanning because PR annotation required pull_requests:read and returned HTTP 403; local scanning then exposed one historical CI-only fixture in scripts/ci/arm64-runtime-smoke.sh. The current code now generates DB/app smoke credentials with openssl rand; the exact historical finding is isolated in .gitleaksignore. The ARM64 base image currently carries no-fix/affected high-severity Debian findings.
- Blockers: CLOUD-03/04 are technically blocked by the hard-fail ARM64 vulnerability result; reported PAT revocation, branch protection, Codespaces proof, OCI tenancy/VM/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain external.
- Remaining risks: no GHCR publication is claimed until ARM64 vulnerabilities are remediated and a successful main CI workflow-run produces immutable registry evidence; optional monitoring images remain tag-pinned and production-blocked; app/worker metrics are implemented but not staging-tested; real SNMP/syslog/flow/discovery receivers remain absent.
- Ruling: the historical CI fixture is suppressed by one exact .gitleaksignore fingerprint rather than a path-wide allowlist or history rewrite. Cost if wrong: one known non-authoritative historical fixture is not re-reported, while the current tree and all other history remain under the full Gitleaks ruleset.
- Ruling: ARM64 Trivy remains ignore-unfixed: false and hard-fail. Cost if wrong: CLOUD-03/04 stay blocked until upstream/base packages are remediated, but no high-severity base finding is hidden.
- Next task: remediate the ARM64 base vulnerability set or select a demonstrably clean, digest-pinned runtime base; then certify current-head CI/ARM64 again before enabling GHCR publication work.

## Evidence-state vocabulary

For each capability, record separately where applicable: implemented; unit tested; integration tested; protocol-harness tested; Docker tested; CI certified; staging tested; physical-hardware tested; production proven.

## External boundary

Never fabricate OCI, DNS, VPN, physical-device, GitHub-owner, or secret-manager access. Repository automation and operator instructions may be implemented here; only the external execution step is `BLOCKED — EXTERNAL`.

