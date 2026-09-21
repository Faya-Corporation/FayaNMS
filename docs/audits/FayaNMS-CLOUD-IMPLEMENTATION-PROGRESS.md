# FayaNMS Cloud Platform Implementation Progress

**Repository:** `fayafatehi/FayaNMS`  
**Execution branch:** `codex/fayanms-cloud-platform`  
**Initial main SHA:** `7aef0a330dc8f965fb496b735eb8a97b8d2c5149`  
**Current main readback:** `3ab5c7eb3118b9b37c6286058de99b41bb67cac0`  
**Current implementation HEAD:** `6db797c1c57d2de0c763d31d912a1b89fdae6279`  
**Execution date:** 2026-09-21  
**Authoritative inputs:** Cloud Development/CICD/OCI Implementation Plan, Executive Production Review, Full Independent Production Audit, Production Remediation Roadmap, Competitive Benchmark, Production Gap Register.

## Operating contract

This ledger records repository implementation evidence separately from external OCI, DNS, VPN, physical hardware, and GitHub-owner actions. A task is `DONE` only when its repository acceptance criteria and available automated evidence are satisfied. No credentials, private keys, device secrets, production backups, or production data may be committed.

Allowed statuses: `TODO`, `IN PROGRESS`, `BLOCKED — EXTERNAL`, `BLOCKED — TECHNICAL`, `DONE`, `DEFERRED — APPROVED`.

## Baseline evidence

| Item | Evidence |
|---|---|
| Current branch | Remote `codex/fayanms-cloud-platform` at `6db797c1c57d2de0c763d31d912a1b89fdae6279`; no local checkout was available in the execution workspace |
| `main` HEAD | `7aef0a330dc8f965fb496b735eb8a97b8d2c5149` |
| Remote protection | Live branch readback: `protected:false`, `protection.enabled:false`, required checks enforcement `off` |
| Latest CI | Run `35572398823` on exact HEAD `6db797c1`: gate, scan, e2e, and browser all PASS; protocol fixture suite included in the gate |
| Browser evidence | Run `35572398823` browser job `106247419684` PASS; prior first-attempt B5 diagnostics remain retained as an intermittent-risk record. |
| ARM64 container | Run `35572398820` on exact HEAD `6db797c1`: app/worker/migrator ARM64 builds, Prisma CLI smoke, architecture/runtime checks, and strict Trivy scans all PASS; GHCR publish skipped for pull request |
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
| CLOUD-02 | CI certification | P0 | DONE | CLOUD-00 | Codex | Run 35569897344: gate, e2e, scan PASS; browser rerun job 106242336219 PASS with diagnostics retained from the first B5 timeout | Keep current checks green on subsequent commits |
| CLOUD-03 | ARM64 container certification | P0 | DONE | CLOUD-02 | Codex | Run 35569897419 job 106239336889 passed ARM64 app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime checks, and strict HIGH/CRITICAL scans with ignore-unfixed: false | Preserve image/runtime evidence; do not claim staging or production proof |
| CLOUD-04 | GHCR immutable images | P0 | IN PROGRESS | CLOUD-03 | Codex + owner | Repository workflow is complete and its PR-side ARM64/SBOM/scan gates are green; immutable GHCR publication is gated to a successful main workflow-run and was correctly skipped for this draft PR | After authorized merge/main push, read back GHCR digests and SBOM attestations; do not merge here |
| CLOUD-05 | OCI foundation | P0 | BLOCKED — EXTERNAL | CLOUD-04 | Codex + owner | Hardened host/bootstrap/network policy and operator runbook committed; tenancy/VM/NSG actions require owner access | Owner creates isolated compartment/VCN/NSG/ARM64 VM and supplies readback |
| CLOUD-06 | OCI runtime | P0 | BLOCKED — EXTERNAL | CLOUD-05 | Codex + owner | Immutable hardened Compose, env contract, deploy/rollback/health scripts committed | Install on owner-controlled host and capture runtime evidence |
| CLOUD-07 | HTTPS/reverse proxy | P0 | BLOCKED — EXTERNAL | CLOUD-06 | Codex + owner | Caddy HTTPS, HSTS, CSP, frame and permissions headers committed | Owner supplies DNS/ACME and proves external HTTPS-only access |
| CLOUD-08 | Automated staging deploy | P0 | BLOCKED — EXTERNAL | CLOUD-07 | Codex + owner | Exact-SHA protected-environment SSH workflow committed | Owner configures staging secrets/approval and runs deployment |
| CLOUD-09 | Health/smoke gate | P0 | BLOCKED — EXTERNAL | CLOUD-08 | Codex | Fail-closed health script and release evidence runbook committed; no staging endpoint exists here | Run against OCI staging and retain smoke evidence |
| CLOUD-10 | Observability | P1 | IN PROGRESS | CLOUD-09 | Codex | App /api/metrics and worker /api/metrics contracts are implemented with token gating; Prometheus/OTel configs and internal profile committed; staging alert proof and profile image digest review remain open | Certify current worker metrics slice, resolve profile digests, then run a controlled alert test in staging |
| CLOUD-11 | Network protocol lab | P1 | IN PROGRESS | CLOUD-10 | Codex | Isolated lab bootstrap plus CI-certified packet fixtures now cover RFC3164/5424 syslog, SNMPv1/v2c traps, NetFlow v5/v9 templates, IPFIX, and sFlow with loopback UDP proof; SNMPv3 authPriv agent, real receivers, and continuous discovery remain unimplemented | Add/verify the next real protocol collector or safe agent; keep telemetry ports closed |
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


### Round 3 — distroless remediation and real SSH harness repair

- Completed: updated the stale R75/R76/R78 and supply-chain audit contracts for the digest-pinned Bun distroless runtime; made the main CI image scans strict (ignore-unfixed: false); replaced the Bun/ssh2-incompatible in-process Ed25519 conversion with an ephemeral runner-generated OpenSSH key that is deleted after harness startup.
- Files changed: Dockerfile; Dockerfile.worker; Dockerfile.migrator; compose migration command; tests/audit/r75-journey-accuracy-and-portable-user.test.ts; tests/audit/r76-image-build-type-resolution.test.ts; tests/audit/supply-chain.test.ts; tests/audit/r78-image-scan-triage.test.ts; .github/workflows/ci.yml; mini-services/worker/harness/persona-sshd.ts.
- Tests: CI run 35563788099 on head 73d7409 passed lint, TypeScript, migrations, and 1199 consolidated tests before the live-SSH harness failed on a malformed generated key. CI run 35564113841 on head 7a58720 reached the live-SSH tests; two R61 protocol cases failed because the direct PKCS#8 normalization was not an OpenSSH key. That intermediate approach was replaced by the current ephemeral ssh-keygen implementation.
- Validation results: the previous contract failures are resolved in the test source; no image or scan result is claimed from the current head until the fresh workflow completes. No private key is stored in the repository; the harness key exists only in a temporary runner directory and is removed in a finally block.
- Commit SHAs: audit-contract/scan repair 73d7409; direct key normalization 7a58720; current ephemeral OpenSSH harness repair 8dfddce.
- CI status: current head 8dfddce awaits a fresh gate and ARM64 certification run; prior CI runs are not green evidence for this head.
- Newly discovered findings: the repository's real SSH harness depended on a Bun-incompatible key conversion path; the failure was caught by protocol-harness tests rather than hidden. The distroless runtime also required explicit Bun entrypoints in smoke and migration commands.
- Blockers: CLOUD-03/04 remain BLOCKED — TECHNICAL until the strict ARM64 vulnerability scan is green and a current-head CI certification completes. PAT rotation, branch protection/ruleset, Codespaces proof, OCI tenancy/VM/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain BLOCKED — EXTERNAL.
- Remaining risks: current-head ARM64 build/runtime/Trivy evidence is pending; GHCR publication cannot be claimed from a draft PR; optional monitoring profile image digests remain unresolved; real SNMP/syslog/flow/discovery receivers and staging alert proof remain outstanding.
- Next task: certify head 8dfddce; fix any new repository-actionable failure; update this ledger with exact gate/ARM64 evidence before proceeding to GHCR/OCI waves.


### Round 4 — current-head CI and ARM64 runtime certification

- Completed: staged a bounded Prisma native runtime closure for the app and migrator distroless images; build stages install OpenSSL/libgcc only for preparation, the checked-in helper copies the required OpenSSL/libgcc libraries, and final stages remain digest-pinned, package-manager-free, and non-root. Added R78 audit coverage for the closure and migrator runtime contract.
- Files changed: Dockerfile; Dockerfile.migrator; scripts/ci/prepare-prisma-runtime.sh; tests/audit/r78-image-scan-triage.test.ts; this ledger.
- Tests: CI run 35569897344 on exact head 02962ee6 passed gate, E2E, and scan; the first browser job 106239905164 timed out in B5 RTL setup after the app process exited 143 and uploaded diagnostics; rerun job 106242336219 passed all browser journeys, axe, keyboard, and RTL checks. Container run 35569897419 job 106239336889 passed ARM64 app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime verification, and strict app/worker/migrator Trivy scans.
- Validation results: the earlier migrator smoke exposed missing libgcc/OpenSSL runtime support in distroless; the corrected bounded closure passed the same direct CLI smoke without changing scan strictness. No skipped test, focused-only test, continue-on-error, credential, private key, device secret, or production configuration was added.
- Commit SHA: 02962ee67d90371e537b16c0e7e18bc9add694e2.
- CI status: current-head repository certification is green after the browser rerun; the container certification job is green; GHCR publication is skipped because the event is a draft pull request, not an authorized main push.
- Newly discovered findings: the browser B5 timeout remains intermittently reproducible on first attempt even when its rerun passes; retain the uploaded diagnostics and continue monitoring subsequent runs. The distroless Prisma native closure is now repository-certified, but it has not been staging-, physical-hardware-, or production-tested.
- Blockers: GHCR registry publication requires an authorized merge/main push and owner-controlled release action; Codespaces proof, PAT revocation, branch protection/ruleset, OCI tenancy/VM/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain BLOCKED — EXTERNAL.
- Remaining risks: optional monitoring profile image digests and staging alert proof remain open; real SNMP/syslog/flow/discovery receivers remain absent; no OCI staging or physical device evidence exists.
- Next task: continue repository-actionable CLOUD-05 through CLOUD-16 hardening and runbook completion while preserving CLOUD-04 exact-SHA GHCR publication gate; record only owner-controlled OCI/GHCR execution as BLOCKED — EXTERNAL.


### Round 5 — packet-level protocol fixture certification

- Completed: added dependency-free packet-level lab fixtures for RFC3164/RFC5424 syslog, SNMPv1/v2c traps, NetFlow v5, NetFlow v9 templates, IPFIX templates, and sFlow counter samples; added loopback UDP transmission coverage, loopback-by-default target safety, and lab/runbook guidance.
- Files changed: scripts/protocol-lab/codec.ts; scripts/protocol-lab/generate.ts; tests/protocol-lab.test.ts; deploy/lab/README.md; docs/runbooks/network-lab.md; this ledger.
- Tests: CI run 35572398823 on exact head 6db797c1 passed gate job 106246612841, scan job 106247419620, E2E job 106247419672, and browser job 106247419684. The gate executed 1,204 passing tests and 18 pre-existing controlled skips. ARM64 container run 35572398820 job 106246726323 passed app/worker/migrator builds, Prisma CLI smoke, architecture/runtime verification, and strict image scans.
- Validation results: the first protocol test caught an incorrect 16-bit assertion against sFlow's 32-bit header fields; test commit 6db797c corrected the parser assertion. No test was skipped or weakened to obtain the result; no credential, private key, community, device secret, or production listener was added.
- Commit SHAs: fixture implementation df7cf83c5fcf0b01f95ae7a2a3bac2303bad0818; wire-width test correction 6db797c1c57d2de0c763d31d912a1b89fdae6279.
- CI status: current-head CI and ARM64 certification are green. GHCR publication remains skipped because the event is a draft pull request rather than an authorized main push.
- Newly discovered findings: packet fixtures provide real wire-format harness evidence but do not close the product monitoring gap; SNMPv3 authPriv polling/agent, real SNMP/trap/syslog/flow receivers, and continuous discovery still require implementation and staging/hardware evidence.
- Blockers: telemetry ports remain intentionally closed until authenticated/restricted receivers exist; OCI staging, VPN, physical hardware, and owner-controlled GHCR publication remain BLOCKED — EXTERNAL.
- Remaining risks: the protocol fixture suite does not establish staging or physical-hardware proof, and the optional monitoring profile still has unresolved immutable image digests and no staging alert proof.
- Next task: continue CLOUD-11 repository implementation with an authenticated SNMPv3 test-agent/collector path or a precise technical blocker, then update the runbook and evidence ledger before moving to controlled telemetry ports.

## Evidence-state vocabulary

For each capability, record separately where applicable: implemented; unit tested; integration tested; protocol-harness tested; Docker tested; CI certified; staging tested; physical-hardware tested; production proven.

## External boundary

Never fabricate OCI, DNS, VPN, physical-device, GitHub-owner, or secret-manager access. Repository automation and operator instructions may be implemented here; only the external execution step is `BLOCKED — EXTERNAL`.

