# FayaNMS Cloud Platform Implementation Progress

**Repository:** `fayafatehi/FayaNMS`  
**Execution branch:** `codex/fayanms-cloud-platform`  
**Initial main SHA:** `7aef0a330dc8f965fb496b735eb8a97b8d2c5149`  
**Current main readback:** `3ab5c7eb3118b9b37c6286058de99b41bb67cac0`  
**Current implementation HEAD:** `2ad921e3bc40ce85d902eea07f0fb413eaf8e531`
**Execution date:** 2026-09-21  
**Authoritative inputs:** Cloud Development/CICD/OCI Implementation Plan, Executive Production Review, Full Independent Production Audit, Production Remediation Roadmap, Competitive Benchmark, Production Gap Register.

## Operating contract

This ledger records repository implementation evidence separately from external OCI, DNS, VPN, physical hardware, and GitHub-owner actions. A task is `DONE` only when its repository acceptance criteria and available automated evidence are satisfied. No credentials, private keys, device secrets, production backups, or production data may be committed.

Allowed statuses: `TODO`, `IN PROGRESS`, `BLOCKED — EXTERNAL`, `BLOCKED — TECHNICAL`, `DONE`, `DEFERRED — APPROVED`.

## Baseline evidence

| Item | Evidence |
|---|---|
| Current branch | Remote `codex/fayanms-cloud-platform` at `2ad921e3bc40ce85d902eea07f0fb413eaf8e531`; no local checkout was available in the execution workspace |
| `main` HEAD | `3ab5c7eb3118b9b37c6286058de99b41bb67cac0` |
| Remote protection | Live branch readback: `protected:false`, `protection.enabled:false`, required checks enforcement `off` |
| Latest CI | Run `35597305855` on exact HEAD `2ad921e3`: gate `106324987882`, scan `106326050876`, e2e `106326051433`, and browser `106326050820` all PASS; bounded discovery probe tests included |
| Browser evidence | Run `35575582829` browser job `106257462989` PASS; prior first-attempt B5 diagnostics remain retained as an intermittent-risk record. |
| ARM64 container | Run `35597305920` job `106325176910` on exact HEAD `2ad921e3`: app/worker/migrator ARM64 builds, direct Prisma CLI smoke, architecture/runtime checks, and strict HIGH/CRITICAL Trivy scans with `ignore-unfixed: false`; GHCR publication skipped for draft PR |
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
| CLOUD-10 | Observability | P1 | IN PROGRESS | CLOUD-09 | App /api/metrics and worker /api/metrics contracts are implemented with token gating; Prometheus/OTel configs now use reviewed SHA-256 image references and a regression test; staging architecture/scan/alert proof remains open | Owner validates the selected monitoring digests on the OCI host architecture and runs a controlled staging alert test |
| CLOUD-11 | Network protocol lab | P1 | IN PROGRESS | CLOUD-10 | CI-certified SNMPv3 authPriv harness, worker-side vault-resolved verification, durable engine-ID enrollment, boots/time replay policy, bounded verified metadata relay, and bounded TCP/reverse-DNS discovery are implemented | Add authenticated SNMPv3 polling/IF-MIB evidence; certify receiver traffic in isolated staging/lab; durable queue/HA, continuous discovery, and physical-vendor evidence remain open |
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


### Round 6 — SNMPv3 authPriv loopback certification

- Completed: added a disposable loopback-only SNMPv3 authPriv agent and client fixture with RFC-style USM key localization, HMAC-SHA1-96 authentication, AES-128-CFB privacy, BER GET/response parsing, fail-closed malformed/auth failure handling, and a random-per-run test secret. Updated lab/runbook documentation.
- Files changed: scripts/protocol-lab/snmpv3.ts; tests/snmpv3-lab.test.ts; deploy/lab/README.md; docs/runbooks/network-lab.md; this ledger.
- Tests: initial commit 1894bfa1 timed out because of two BER traversal defects; fix commits a47575d and 3b5fe90 exposed diagnostics and corrected varbind/header sequence levels. Final CI run 35575582829 on exact head 53dcf959 passed gate job 106256592147, E2E job 106257462958, browser job 106257462989, and scan job 106257463015. Final ARM64 container run 35575582812 job 106256718384 passed all image builds, direct Prisma CLI smoke, architecture/runtime verification, and strict app/worker/migrator scans.
- Validation results: the final test performs a real encrypted/authenticated SNMPv3 GET over loopback UDP and verifies the returned sysName OID/value. Safe rejection diagnostics contain only an error class/message; no packet bytes, passphrase, community, or private key is logged.
- Commit SHA: final parser correction 53dcf95989f785cfbb567f919d0eff1362137; prior red/fix commits are preserved in published history.
- CI status: current-head CI and ARM64 certification are green. GHCR publication remains skipped because this is a draft pull request rather than an authorized main push.
- Newly discovered findings: the real protocol harness caught BER-level parser defects that unit-only packet construction would not detect; production SNMP/trap/syslog/flow collectors, device association, alerting, and continuous discovery remain separate implementation work.
- Blockers: telemetry ports remain intentionally closed until authenticated/restricted product receivers exist; OCI staging, VPN, physical hardware, and owner-controlled GHCR publication remain BLOCKED — EXTERNAL.
- Remaining risks: the disposable agent is loopback-only and does not establish staging, vendor, or physical-device support; optional monitoring profile digests and staging alert proof remain open.
- Next task: continue CLOUD-11 with repository-side real collector/device-association work where executable; keep CLOUD-12 listener exposure blocked until those receivers are implemented and reviewed.

### Round 10 — SNMPv3 engine enrollment and anti-replay policy

- Completed: added durable device-bound SNMPv3 engine identity state; added enrollment/reset through the device API; added fail-closed engine-ID mismatch, unenrolled, invalid boots/time, and replay checks; advanced state with a conditional update to prevent concurrent stale observations from being accepted; updated profile lookup and worker relay to enforce the policy.
- Files changed: prisma/schema.prisma; prisma/migrations/20260921110000_snmpv3_engine_state/migration.sql; src/app/api/v1/devices/[id]/route.ts; src/lib/protocol/snmpv3-policy.ts; src/app/api/v1/ingest/protocol/snmpv3-profile/route.ts; src/app/api/v1/ingest/protocol/snmpv3-profile/accept/route.ts; mini-services/worker/protocol-collector.ts; scripts/protocol-lab/snmpv3.ts; tests/snmpv3-policy.test.ts; tests/protocol-collector.test.ts; tests/protocol-ingest.test.ts; docs/runbooks/network-lab.md; this ledger.
- Tests: the first engine-state run 35593695192 failed at typecheck with missing boots/time return typing and one incorrect relative import; fix commit 0439509c corrected both. Fresh exact-head run 35594017887 passed gate 106314598341, E2E 106315526127, browser/axe/keyboard/RTL 106315526176, and scan 106315526255.
- Validation results: ARM64 run 35594017889, job 106314741108, passed app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime verification, and strict HIGH/CRITICAL Trivy scans with ignore-unfixed false. Migration/schema drift, typecheck, full unit/security/worker/protocol suites, production build, and Docker gates passed. GHCR publication was skipped because PR #12 remains draft.
- Commit SHAs: engine-state implementation 2492ddce; type/import correction 0439509c.
- CI status: exact current head is green in both repository and ARM64 certification; no credentials, secrets, private keys, packet bytes, or raw SNMP state were committed.
- Newly discovered findings: engine-ID pinning and boots/time policy provide repository-side replay controls but do not establish staging, hardware, vendor interoperability, durable queue/HA, continuous discovery, or production proof. Devices require an explicit operator enrollment action before SNMPv3 telemetry is accepted.
- Blockers: prior PAT rotation, branch protection/ruleset, live Codespaces proof, OCI tenancy/VM/NSG/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain owner-controlled actions.
- Remaining risks: telemetry ports remain intentionally closed; monitoring digest/platform validation, alert proof, durable collector queue/HA, discovery, physical-vendor matrix, staging and production evidence remain open.
- Exact next task: replace the worker's randomized discovery simulation with a bounded real TCP/reverse-DNS probe path; keep authenticated SNMP identity and vendor claims separate until credentials and isolated lab evidence exist.
### Round 11 — bounded real discovery probes

- Completed: replaced the randomized worker discovery simulation with an outbound-only, bounded TCP/reverse-DNS probe path; API input now accepts only /24-/32 ranges and at most four subnets, the worker enforces 256 targets per subnet and 1,024 targets per job, probes only TCP 22/80/443/830, resolves reverse DNS only for reachable targets, and emits generic unauthenticated reachability candidates. Empty results are valid and are never fabricated.
- Files changed: mini-services/worker/discovery.ts; mini-services/worker/runner.ts; src/app/api/v1/discovery/route.ts; src/app/api/v1/worker/complete/route.ts; tests/discovery.test.ts; docs/runbooks/network-discovery.md; this ledger.
- Tests: initial discovery commit 3c99965 exposed a malformed route rewrite; repair commits 94d0903 and a8b1966 restored the file and template interpolation. Exact-head run 35597021064 on a8b1966 failed only at typecheck for the scanner result type and a vitest import; 2ad921e corrected both using the repository Bun test convention. Fresh run 35597305855 passed gate 106324987882, E2E 106326051433, browser/axe/keyboard/RTL 106326050820, and scan 106326050876.
- Validation results: ARM64 run 35597305920, job 106325176910, passed app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime verification, and strict HIGH/CRITICAL Trivy scans with ignore-unfixed false. The probe test uses a real loopback TCP listener; no credentials, raw packet capture, vendor claim, telemetry listener, or simulated candidate was added.
- Commit SHAs: discovery implementation 3c99965c; route repair 94d0903; template fix a8b1966; type/test correction 2ad921e.
- CI status: exact current head is green in repository and ARM64 certification; GHCR publication remains skipped because PR #12 remains draft.
- Newly discovered findings: unauthenticated reachability is only a discovery signal; it does not establish SNMP identity, vendor/model, IF-MIB, LLDP/CDP, ARP/FDB, ICMP quality, staging, physical-hardware, or production proof. The next repository slice is authenticated SNMPv3 polling with server-side credential references.
- Blockers: prior PAT rotation, branch protection/ruleset, live Codespaces proof, OCI tenancy/VM/NSG/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain owner-controlled actions.
- Remaining risks: telemetry ports remain intentionally closed; durable collector queue/HA, continuous discovery, vendor protocol support, monitoring alert proof, staging, and production evidence remain open.
- Exact next task: implement authenticated SNMPv3 polling for sysName, sysDescr, uptime, and an initial IF-MIB interface/counter slice with timeout/retry/jitter and no secret exposure.
## Evidence-state vocabulary

For each capability, record separately where applicable: implemented; unit tested; integration tested; protocol-harness tested; Docker tested; CI certified; staging tested; physical-hardware tested; production proven.

## External boundary

Never fabricate OCI, DNS, VPN, physical-device, GitHub-owner, or secret-manager access. Repository automation and operator instructions may be implemented here; only the external execution step is `BLOCKED — EXTERNAL`.


### Round 7 — monitoring immutability and repository-side protocol collector

- Completed: replaced the optional monitoring profile's mutable-only references with reviewed SHA-256 digests for Prometheus, OpenTelemetry Collector Contrib, and Grafana; added a deterministic compose security/pinning test; added the authenticated protocol ingestion boundary; added bounded normalization and device association; added an opt-in worker UDP receiver for syslog, SNMP trap framing, NetFlow, IPFIX, and sFlow with queue/relay metrics; expanded the worker service token contract with the telemetry scope; updated the isolated network-lab runbook.
- Files changed: deploy/oci/compose.monitoring.yml; docs/runbooks/observability.md; docs/runbooks/network-lab.md; tests/audit/monitoring-compose.test.ts; tests/protocol-ingest.test.ts; tests/protocol-collector.test.ts; src/lib/protocol/ingest.ts; src/app/api/v1/ingest/protocol/route.ts; src/lib/auth/service-jwt.ts; src/lib/auth/service-auth.ts; mini-services/worker/service-token.ts; mini-services/worker/protocol-collector.ts; mini-services/worker/index.ts; this ledger.
- Tests: CI run `35579731890` on exact head `00cc58117f4c3b7e5ceb6806594eb27c0d6d2a69` passed gate, E2E, scan, and browser; the gate included bounded ingestion, hostname-over-IP association, RFC5424 extraction, binary protocol version checks, malformed-packet rejection, service-auth source checks, metrics, migrations, production build, security tests, axe, keyboard, and RTL checks.
- Validation results: ARM64 container run `35579731951`, job `106269696630`, passed app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime checks, and strict HIGH/CRITICAL Trivy scans with `ignore-unfixed: false`. The receiver remains disabled unless explicitly enabled and defaults to loopback/non-privileged ports; no UDP listener opens on import or in CI.
- Commit SHAs: monitoring digest pin `b7f4e1c2b36633ac256b1b00b70c1776394c5fbe`; monitoring test escape correction `7a7c38e11460990232fe90347e20359819c7f286`; authenticated ingestion `70bb79c87fc38a59f234b1544b6eeb6753dfa67b`; ingestion tests `b66181f823d23d41078435e1971abf43d9b62d91`; receiver `e0bfc841842cf775a076be9334f8f0d7142d2227`; RFC5424/type corrections `f9577e65d0b85b723a440829ffc80312f6400a38`, `00cc58117f4c3b7e5ceb6806594eb27c0d6d2a69`.
- CI status: exact current head is green in `35579731890` and `35579731951`; GHCR publication remains correctly skipped because this is a draft pull request, not an authorized successful `main` push.
- Newly discovered findings: the repository-side receiver is a production integration boundary, not proof of physical-device interoperability; its SNMP trap path validates BER framing but does not yet perform full SNMPv3 authPriv trap verification or device credential/profile policy. Monitoring image digest availability for the OCI host architecture still requires operator validation.
- Blockers: prior PAT rotation, branch protection/ruleset, live Codespaces proof, OCI tenancy/VM/NSG/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain owner-controlled actions.
- Remaining risks: telemetry ports must stay closed until the owner reviews the NSG/firewall and isolated-lab exposure; the receiver's continuous discovery, durable queue/HA, and physical-vendor evidence are not complete; no staging or production-proven claim is made.
- Exact next task: execute the next repository-actionable CLOUD-11 slice — add full SNMPv3 trap authentication/privacy verification and explicit device credential/profile policy to the receiver — while retaining the external boundary for OCI, VPN, and hardware.

### Round 8 — SNMPv3 trap verification and device-profile policy

- Completed: extended the disposable SNMPv3 harness with real encrypted/authenticated trap construction and decoding, typed varbinds including notification OID and Timeticks, and tamper/wrong-secret rejection; added a fail-closed protocol policy requiring verified authPriv, an exact device association, and a device-bound SNMPV3 CredentialProfile; marked the generic worker BER-framing path as untrusted; updated the network-lab runbook.
- Files changed: scripts/protocol-lab/snmpv3.ts; tests/snmpv3-lab.test.ts; src/lib/protocol/ingest.ts; src/app/api/v1/ingest/protocol/route.ts; mini-services/worker/protocol-collector.ts; tests/protocol-ingest.test.ts; tests/protocol-collector.test.ts; docs/runbooks/network-lab.md.
- Tests: the first trap commit exposed a literal newline escape at lint (35585406320, failed only at tests/snmpv3-lab.test.ts:148); 5015c7b7 removed it. Fresh run 35588028483 on exact head 98049dff7c87e97009969c04ce891380e172bddd passed gate, E2E, browser/axe/keyboard/RTL, and scan.
- Validation results: ARM64 run 35588028422, job 106302873347, passed app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime checks, and strict HIGH/CRITICAL Trivy scans with ignore-unfixed=false. GHCR publication was correctly skipped because PR #12 remains draft.
- Commit SHAs: trap harness 38eb8213a20e2025e969dfe96e06cca54ffd917f; lint correction 5015c7b7e2805187ba6a7c16dae7272cf2ffeaba; device-profile policy 98049dff7c87e97009969c04ce891380e172bddd.
- CI status: repository certification is green at the exact policy head; no secrets or credential values were added.
- Newly discovered findings: the generic worker receiver still cannot verify SNMPv3 USM packets or resolve a vault secret reference; it deliberately labels its BER-framed SNMP path unknown, which the API rejects. The harness proves loopback protocol behavior only, not hardware, staging, or production interoperability.
- Blockers: prior PAT rotation, branch protection/ruleset, live Codespaces proof, OCI tenancy/VM/NSG/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain owner-controlled actions.
- Remaining risks: do not open telemetry ports; a server/worker-side vault-resolved SNMPv3 decoder, durable queue/HA, continuous discovery, staging evidence, and physical-vendor matrix remain incomplete.
- Exact next task: implement the worker-side SNMPv3 authPriv verification path using only a server-side secret reference/profile lookup, emit only bounded verified metadata, and keep unknown/community SNMP traps rejected.

### Round 9 — worker-side SNMPv3 verification

- Completed: added a worker-side verifier that obtains an SNMPv3 profile reference through a telemetry-scoped Next route, resolves the vault secret only in the worker, verifies USM authPriv with the packet engine ID, and relays only bounded metadata; added tests proving the secret is absent from the event; kept generic BER framing fail-closed.
- Files changed: scripts/protocol-lab/snmpv3.ts; mini-services/worker/protocol-collector.ts; tests/protocol-collector.test.ts; tests/protocol-ingest.test.ts; src/app/api/v1/ingest/protocol/snmpv3-profile/route.ts.
- Tests: run `35590744651` on exact head `0cd3fa11019dc79318d059fb9206a4a94e11f101` passed gate, E2E, browser/axe/keyboard/RTL, and scan; worker tests covered vault resolution, USM authPriv verification, bounded event metadata, and no-secret output.
- Validation results: ARM64 run `35590744643`, job `106304455725`, passed app/worker/migrator builds, direct Prisma CLI smoke, architecture/runtime checks, and strict HIGH/CRITICAL Trivy scans with `ignore-unfixed: false`. GHCR publication was correctly skipped because PR #12 remains draft.
- Commit SHAs: progress ledger `d7a64d4d20d926228dae2346b012ff32b8030a06`; worker verifier `0cd3fa11019dc79318d059fb9206a4a94e11f101`.
- CI status: exact worker verifier head is green; no secret value, packet bytes, or device credential was committed or relayed through the API.
- Newly discovered findings: the current CredentialProfile schema does not persist a trusted SNMP engine ID or a boots/time replay window. The worker authenticates and decrypts packets, but a production claim still requires explicit engine-ID enrollment, timeliness/replay policy, durable state, and hardware/staging evidence.
- Blockers: prior PAT rotation, branch protection/ruleset, live Codespaces proof, OCI tenancy/VM/NSG/DNS/SSH, staging approval, VPN, off-host backup key/target, and physical hardware remain owner-controlled actions.
- Remaining risks: do not open telemetry ports; SNMP engine identity/replay controls, durable queue/HA, continuous discovery, staging evidence, and physical-vendor matrix remain incomplete.
- Exact next task: add repository-side SNMP engine-ID pinning and bounded anti-replay/timeliness policy without persisting secrets or raw packets.
