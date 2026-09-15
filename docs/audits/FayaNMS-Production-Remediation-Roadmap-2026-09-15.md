# FayaNMS — Production Remediation Roadmap (2026-09-15)

**Baseline:** HEAD `b9d3d50` — independent score **79/100, BLOCKED** (see `FayaNMS-Independent-Current-Main-Audit-2026-09-15.md`).
**Target:** ≥ 90/100, zero P0/P1 release blockers, green release SHA.
**Ordering rationale:** governance/CI first (unblocks all evidence), then identity/secret isolation, then scale, then certification, then hardening. Every task is independently landable as a green commit; no live-write behavior becomes less restrictive at any point.

---

## Phase 0 — P0 release blockers (governance & CI)

### TASK GOV-001-A — Restore branch protection on `main` *(settings-side, owner token required)*
- **Priority:** P0 | **Depends on:** nothing
- **Problem:** `main.protected=false`, required checks off (live API 2026-09-15); `ci.yml` header claims the opposite (DOC-001).
- **Files:** GitHub repo settings (no repo code); `.github/workflows/ci.yml` L1–14 header.
- **Implementation:** Ruleset/branch protection on `main`: PRs required, ≥1 approval + CODEOWNERS where applicable, conversation resolution, required `gate` + `scan`, forbid force-push/deletion, admin bypass explicitly scoped (keep the documented break-glass or remove it — decision recorded in SOCIAL-REPOSITORY §6). Correct the workflow header to state live truth with a "verified YYYY-MM-DD" stamp.
- **Constraints:** Do not claim protection until the API read-back says `protected:true`; add that read-back to the verification step.
- **Tests:** Governance verification step: API read-back asserted true; brand honesty test updated to pin the live state.
- **Acceptance:** Live API: `protected:true`, `gate`+`scan` required; `ci.yml` header matches live truth.

### TASK CI-001-A — Restore CI evidence on the release SHA *(user-side, billing/minutes)*
- **Priority:** P0 | **Depends on:** none (parallel with GOV-001-A)
- **Problem:** Runs #34–#47 fail with zero steps executed, no runner assigned (GitHub-hosted runner unavailability). Latest success `5cc0a5f` (2026-09-13).
- **Files:** none (infrastructure); optional: `.github/workflows/ci.yml` (runner fallback strategy).
- **Implementation:** Verify Actions minutes/billing for the account; re-run `gate`+`scan` on the release SHA from the UI. If unavailable long-term, add a self-hosted runner or reduce matrix concurrency; consider a scheduled weekly full run to keep evidence fresh.
- **Constraints:** Release tags must be forbidden from commits without green required checks (GOV-001-A).
- **Tests:** none.
- **Acceptance:** Current HEAD has successful `gate` + `scan` runs; artifacts (SBOM, scans) retained.

---

## Phase 1 — P1 security and identity

### TASK SEC-ENV-001-A — Per-service environment split
- **Priority:** P1 | **Depends on:** none
- **Problem:** One `.env.production` serves `app`, `worker`, and `provision` (`compose.yml` L65/97/123); worker receives DB/session/KEK material; app receives device vault material.
- **Files:** `compose.yml`; `docs/deploy/env.production.example`; `docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md` (T5/T6/T7); possibly `Dockerfile*` (no change expected).
- **Implementation:** Introduce `env.production` + `env.worker.production` (+ provisioning via the existing one-off pattern). Worker env file: service identity, vault entries, worker URLs, WebAPI CA pin — nothing else. App env file: session/KEK/DB/service-identity — no `FAYANMS_VAULT_*`. Compose interpolation continues from the host-side file via `--env-file`; runtime `env_file` per service.
- **Constraints:** Backward-compatible warning path: startup policy WARNs (prod FAILs after one deprecation window) if a process receives secrets outside its ownership table; never log secret values in the checker.
- **Tests:** New `tests/audit/env-boundary.test.ts`: parse `compose.yml` + both templates; assert the ownership table (app: no `FAYANMS_VAULT_*`; worker: no `NEXTAUTH_SECRET`/`FAYANMS_CONFIG_ENC_KEY`/`POSTGRES_PASSWORD`/`DATABASE_URL`).
- **Acceptance:** `docker compose config` renders per-service env with zero cross-zone entries; tests green; runbook updated.

### TASK AUTH-001-A — Login throttling, backoff, lockout, telemetry
- **Priority:** P1 | **Depends on:** none
- **Problem:** `/api/auth/*` sits outside the `/api/v1` gate (`src/proxy.ts` matcher) and `authorize()` has no attempt throttling — unbounded online guessing.
- **Files:** `src/lib/auth/options.ts` (authorize), new `src/lib/auth/login-guard.ts`, `src/instrumentation.ts` (no change expected), `tests/audit/login-guard.test.ts`; docs: deploy security note.
- **Implementation:** Pre-auth guard keyed by (trusted-proxy IP, normalized account) with sliding-window attempt budget, exponential backoff, temporary lockout with typed audit event (`SIGNIN_THROTTLED`, `SIGNIN_LOCKOUT`), constant-time failure responses to avoid user enumeration; failure counts in the shared store abstraction so SCALE-001-A can swap the backend without signature change.
- **Constraints:** Fail-closed on guard errors? No — availability trade-off: fail-open per-IP but fail-closed per-account lockout must survive restarts only via the shared store (Phase 2); document honestly. Never reveal lockout state pre-auth beyond generic messages.
- **Tests:** Unit pins for budget/backoff/lockout/reset, enumeration-safe responses, trusted-hop keying; audit-event emission.
- **Acceptance:** Simulated stuffing (e.g., 50 attempts) → throttled with `Retry-After`; audit trail shows typed events; no user enumeration.

### TASK SVC-001-A — EdDSA-only production startup (complete Phase 2)
- **Priority:** P1 | **Depends on:** none
- **Problem:** Startup policy requires `FAYANMS_SERVICE_SECRET` unconditionally; documented EdDSA-only end state cannot boot.
- **Files:** `src/lib/startup/security-policy.ts`; `docs/deploy/env.production.example`; `docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md` note 17; worker side `mini-services/worker/control-auth.ts`/`service-token.ts` config checks.
- **Implementation:** Policy change: production requires **at least one valid plane per role** — either the legacy shared secret (hex-64, known-bad-checked) OR valid Ed25519 material (private key on minters, peer public keys on verifiers, issuer list covering the configured topology). Validate key material at startup (parse, sign/verify self-test), fail typed (`SERVICE_PLANE_INVALID`). Template gains the two-plane shape with the symmetric block marked optional/legacy.
- **Constraints:** Never accept an empty plane set; never silently prefer one plane; rotation overlap must keep working (both planes accepted).
- **Tests:** Extend the startup-policy tests: EdDSA-only boots (violations empty), empty planes refuse, malformed key material refuses, mixed rotation OK, known-bad symmetric still refused.
- **Acceptance:** A sandbox E2E boots both processes EdDSA-only with `FAYANMS_SERVICE_SECRET` unset; Phase-2 runbook executes verbatim.

---

## Phase 2 — Production scaling & hardening

### TASK SCALE-001-A — Shared rate-limit store
- **Priority:** P1 (P2 for single-host) | **Depends on:** AUTH-001-A (same store abstraction)
- **Problem:** `src/lib/api/rate-gate.ts` buckets are process-local Maps.
- **Files:** `src/lib/api/rate-gate.ts` (+ new `rate-store.ts`), `compose.yml` (optional redis service, disabled by default), docs.
- **Implementation:** Extract a store interface (in-memory default; Redis or PostgreSQL implementation behind `FAYANMS_RATE_STORE`); atomic sliding-window ops; global `Retry-After`; memory bounds retained.
- **Constraints:** Single-host default stays in-memory (zero new mandatory infra); fail behavior of the shared store documented (fail-open per-IP with alarm vs fail-closed — decide and pin).
- **Tests:** Contract tests against both backends (skip Redis when absent); multi-instance simulation via two store clients asserting shared budgets.
- **Acceptance:** Two app instances share a budget in tests; documented env switches behavior.

### TASK DEPLOY-001-A — HTTPS-by-default reference deployment
- **Priority:** P2 | **Depends on:** none
- **Files:** new `compose.tls.yml` (Caddy/Traefik reference profile) or runbook D2 expansion; `docs/deploy/env.production.example`; startup policy (optional strict-origin warning).
- **Implementation:** Ship a TLS-terminating proxy profile with automatic/internal certs + HSTS, and make the runbook's default path HTTPS; plain-80 profile kept explicitly labeled "isolated-LAN pilot only".
- **Acceptance:** Fresh-host runbook produces an HTTPS origin end-to-end; secure cookies active.

### TASK SUPPLY-001-A — Digest-pinned bases + built-image scanning
- **Priority:** P2 | **Depends on:** CI-001-A (runner availability)
- **Files:** `Dockerfile`, `Dockerfile.worker`, `compose.yml` (postgres digest), `.github/workflows/ci.yml`.
- **Implementation:** Pin bases by digest (with version comment + bump procedure); CI builds both images, runs Trivy `image` scan by digest, generates image SBOM; optional provenance/signing.
- **Acceptance:** CI proves image-level scan on the release SHA; base digests documented.

### TASK OPS-002-A — Compose runtime hardening
- **Priority:** P2 | **Depends on:** none
- **Files:** `compose.yml`; deploy doc.
- **Implementation:** `read_only: true` where feasible (tmpfs for /tmp), `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `pids_limit`, cpu/mem limits, explicit `restart` policies (present), logging limits (present) — applied per service after smoke-testing.
- **Acceptance:** Hardened stack passes the demo-seed + health E2E; documented deviations listed.

---

## Phase 3 — Real-device certification (Gate D)

### TASK CERT-HW-001-A — Physical/virtual appliance certification matrix
- **Priority:** P1 (product) | **Depends on:** hardware lab access (non-sandbox)
- **Problem:** All certification is protocol-harness level; no real-device evidence exists; LIVE restore intentionally refused (FUNC-001).
- **Files:** `docs/certification/` (new matrix), `mini-services/worker/harness/` (regression anchors only).
- **Implementation:** Per vendor × firmware: auth modes, backup, drift, controlled change, fail-fast/canary, rollback, restore (where safe), host-key/TLS rotation, interruption/timeout, large-config handling. Publish evidence; only then consider typed live-restore enablement behind an explicit operator opt-in flag + preflight/canary.
- **Acceptance:** Published matrix with repeatable evidence per claimed capability; README/deploy claims match the matrix exactly.

---

## Phase 4 — E2E / UX / accessibility (Gate E part 1)

### TASK TEST-001-A — Continuous browser + integration journeys
- **Priority:** P1 | **Depends on:** CI-001-A
- **Files:** new `tests/e2e/` (Playwright), `.github/workflows/ci.yml` (service containers + job).
- **Implementation:** Critical journeys: sign-in (incl. throttle), inventory CRUD, config backup/diff, change draft→approval→execute (simulator), restore (simulator), incidents/alerts, reports, admin/RBAC negative paths, RTL/AR parity, keyboard-only pass; multi-container compose smoke (app+worker+postgres) with health + job-engine loop.
- **Acceptance:** Journeys run in CI on every push; failures block.

### TASK A11Y-001-A — Automated accessibility + manual audit closure
- **Priority:** P2 | **Depends on:** TEST-001-A
- **Implementation:** axe-core in Playwright journeys; close remaining §6 QA-matrix cells; screen-reader pass on the 5 highest-traffic views.
- **Acceptance:** Zero critical axe violations; recorded manual pass.

---

## Phase 5 — Deployment/SRE hardening (Gate E part 2)

### TASK OPS-003-A — Backup/DR drill + runbook
- **Priority:** P1 | **Depends on:** none
- **Implementation:** Scripted pg_dump/restore drill incl. KEK-loss and KEK-rotation scenarios; document RPO/RTO; worker/app recovery from host loss; interrupted-change recovery playbook.
- **Acceptance:** A fresh host rebuild from backups passes app+worker health and a simulator restore; runbook executed verbatim.

### TASK OPS-004-A — Observability baseline
- **Priority:** P2 | **Depends on:** none
- **Implementation:** Expose/aggregate health + job counters + queue depth; alert on worker claim failures, stale leases, drift-guard failure, sign-in lockout spikes; document SLO candidates.
- **Acceptance:** Alert rules fire in a drill; dashboards show the documented signals.

---

## Phase 6 — Final production certification

- Re-run the independent audit against the release SHA; require: score ≥ 90, zero P0/P1, all Phase 0–1 acceptance criteria met, live protection true, green release CI, DR drill evidence, published certification matrix.
- Production acceptance checklist (12 items) in the audit doc is the sign-off sheet.

---

## Execution notes

- Sandbox-actionable now: AUTH-001-A, SVC-001-A, SEC-ENV-001-A, SCALE-001-A, DEPLOY-001-A, OPS-002-A, OPS-003-A (scripted), TEST-001-A (authoring; execution needs runners), plus DOC-001 corrections riding along each.
- Non-sandbox: GOV-001-A, CI-001-A (owner token/billing), CERT-HW-001-A (hardware), runner-dependent CI execution.
