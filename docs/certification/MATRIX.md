# FayaNMS — Device Certification Matrix & Lab Procedure (CERT-HW-001-A / FUNC-001-A)

**Status date:** 2026-09-15 (Asia/Riyadh) · **Baseline:** the production remediation session (R34–R43).
**Prime rule (never violated):** protocol-harness certification ≠ real-hardware certification. A capability below is claimed ONLY at the highest tier actually evidenced.

## 1. Evidence tiers (the vocabulary every claim must use)

| Tier | Meaning | Evidence required |
|---|---|---|
| T0 unit tested | Pure logic (parsers, planners, guards) covered by the contract suite | `bun test tests/` pins |
| T1 protocol harness | The REAL transport client drives an in-repo wire-accurate harness persona | `bun mini-services/worker/certify.ts` exit 0 |
| T2 simulator | Full app+worker+DB stack on the in-app simulator plane | E2E journeys (`tests/e2e/`) 6/6 |
| T3 lab hardware | The same stack against a physical/virtual vendor appliance, evidence recorded per capability | THIS document, signed rows |
| T4 production certified | T3 + a production deployment window with change-freeze + rollback rehearsal | deployment log + audit trail refs |

**Current top tier per capability: T1/T2 everywhere. NO T3 row exists yet — every T3 cell is honestly BLOCKED (no hardware in the sandbox).**

## 2. Vendor × capability matrix (current truth)

Transports: SIMULATOR (all vendors, T2), LIVE_SSH (five CLI vendors, T1), LIVE_WEBAPI (sophos, T1, read-only TLS).

| Vendor | Auth | Backup (read) | Drift detect | Controlled change | Fail-fast/canary | Rollback | Restore | Host-key/TLS rotation | Interruption recovery | Large config | Top tier |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cisco-ios | T1 | T1/T2 | T2 | T2 (plan-validated delta) | T2 | T2 | **REFUSED by design on LIVE** | T1 (pin/rotate flow) | T1 (typed timeouts) | T1 | T2 |
| fortinet-fortios | T1 | T1/T2 | T2 | T2 | T2 | T2 | REFUSED on LIVE | T1 | T1 | T1 | T2 |
| hpe-aos-cx | T1 | T1/T2 | T2 | T2 | T2 | T2 | REFUSED on LIVE | T1 | T1 | T1 | T2 |
| juniper-junos | T1 | T1/T2 | T2 | T2 | T2 | T2 | REFUSED on LIVE | T1 | T1 | T1 | T2 |
| palo-panos | T1 | T1/T2 | T2 | T2 | T2 | T2 | REFUSED on LIVE | T1 | T1 | T1 | T2 |
| sophos (SFOS WebAPI) | T1 (TLS-first, fail-closed) | T1 (GetConfig) | — | **NOT IMPLEMENTED (read-only allowlist)** | — | — | REFUSED on LIVE | T1 (CA pin) | T1 (TLS timeouts) | — | T1 |

Legend: `T1/T2` = protocol-harness certified AND simulator-verified. `REFUSED on LIVE` = the engine refuses typed (`LIVE_RESTORE_NOT_CERTIFIED`) — a capability boundary, not a bug. Restore IS certified on the SIMULATOR plane (T2, snapshot-exact semantics).

**README/deploy claims are pinned to this matrix by CI** (`tests/audit/` governance suites fail if docs claim a tier above evidence).

## 3. REAL-HARDWARE CERTIFICATION PROCEDURE (FUNC-001-A gate)

Per vendor × firmware version × capability row: execute, record evidence, sign the row. No row may be claimed from a harness run.

1. **Lab setup** — appliance on an isolated lab VLAN; FayaNMS stack (app+worker+PG) on the lab host; device enrolled with a dedicated least-privilege credential; SSH host key enrolled out-of-band (or CA pinned for sophos).
2. **Preflight** — `Test Connection` (app→worker hop) reachable; credential resolves worker-side from the vault (SEC-ENV-001 worker zone); startup policy banner clean.
3. **Auth + read** — live probe + full-config backup ×3; byte-compare backup #1 vs #2 (deterministic normalizations documented); verify snapshot integrity hash + KEK envelope.
4. **Drift** — modify running config OUT-OF-BAND on the appliance; verify drift detection and re-backup convergence.
5. **Controlled change (T3 target)** — execute the documented per-flavor plan-validated delta (interface description marker); VERIFY step asserts the marker in the live config; post-change snapshot captured.
6. **Failure path** — `failAt=APPLY` journey on the live device; confirm truthful FAILED state, blast radius (only reached devices touched), rollback executed, post-rollback validation asserts the marker GONE.
7. **Interruption** — kill the worker mid-APPLY; verify the lease/write-lock recovery path and that the device is left in a documented, re-derivable state.
8. **Rotation** — rotate the device credential + the SSH host key (out-of-band verify → re-enroll); confirm fail-closed between (mismatch refuses before authentication).
9. **Restore enablement decision (FUNC-001)** — full-config LIVE restore stays REFUSED until, per vendor: the vendor-safe staging design (preflight → exact target snapshot → integrity verify → vendor-safe staging → commit/apply → reconnect → recapture running config → exact/normalized verification → rollback on failure) is implemented per the typed plan pipeline AND rows 1–8 are T3-signed. Never send raw snapshot bytes as blind CLI input.

**Signing:** each executed row records date, firmware, device model, operator, evidence artifact (transcript + audit-trail IDs). GOV-001's branch protection must be active before any T4 claim.

## 4. External blocker classifications (2026-09-15)

- **FUNC-001-A (LIVE restore): REAL-HARDWARE CERTIFICATION BLOCKED.** The fail-closed refusal stays (typed, audited, honestly documented). Product decision recorded: backup/change management can release with restore explicitly unsupported; enabling live restore requires section 3.
- **GOV-001-A (protect main): OWNER ACTION REQUIRED.** Exact settings: ruleset/branch protection on `main` — require PR, ≥1 approval (+CODEOWNERS), conversation resolution, required checks `gate`+`scan`+`e2e`, forbid force-push + deletion, admin bypass scoped and recorded (SOCIAL-REPOSITORY §6); verify via API read-back (`protected:true`) before flipping any doc claim (the docs currently say NOT ACTIVE — truth-first).
- **CI-001-A (green release SHA): INFRASTRUCTURE BLOCKED.** Symptom since run #34: every run fails with ZERO steps executed, no runner assigned (GitHub-hosted runner unavailability for this private repo — capacity/minutes). Owner remediation: verify Actions minutes/billing; re-run the release SHA from the Actions UI; if unavailability persists, add a self-hosted runner or reduce matrix concurrency; a green OLD SHA is not release evidence.
- **CERT-HW-001-A: REAL-HARDWARE BLOCKED** (no physical/virtual appliances in the sandbox). Section 3 is the executable lab procedure. **Partial de-risk plane published (2026-09-16): `docs/certification/PUBLIC-DEMO-DEVICES.md`** — free public demo devices (Cisco DevNet, per-user AAA credentials) give REAL-device auth/read evidence (TCP/SSH/read tier of section-3 rows 1–3) with zero hardware; the drift/change/failure/interruption/rotation/restore rows (steps 4–9) REMAIN lab-gated and can never be claimed from a shared public device. The per-vendor free path for the remaining flavors is the operator-hosted virtual appliance (free VM downloads — the lab accepts "physical/virtual vendor appliance").
