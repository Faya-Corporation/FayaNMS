# FayaNMS — NEXT TASKS (execution backlog, 2026-09-15)

Derived from `FayaNMS-Independent-Current-Main-Audit-2026-09-15.md` + `FayaNMS-Production-Remediation-Roadmap-2026-09-15.md`. Tasks are independently implementable and landable as separate green commits. Sandbox-actionable tasks are marked ✊; user/infrastructure-side are marked 👤.

---

TASK-AUTH-001-A — Login throttling, backoff, lockout, sign-in telemetry ✊

Goal: Bound online password guessing on `/api/auth/*` (outside the `/api/v1` gate; `authorize()` has no attempt control).
Files: `src/lib/auth/options.ts`, NEW `src/lib/auth/login-guard.ts`, `tests/audit/login-guard.test.ts`, deploy doc security note, README security paragraph.
Implementation: Pre-auth sliding-window guard keyed by (trusted-proxy IP, normalized account) with exponential backoff + temporary lockout; typed audit events (`SIGNIN_THROTTLED`, `SIGNIN_LOCKOUT`); enumeration-safe generic failure responses; store behind an interface so the SCALE-001-A shared backend can slot in.
Tests: budget/backoff/lockout/reset pins; trusted-hop keying; audit emission; enumeration-safety.
Acceptance: 50 simulated attempts → throttled with `Retry-After`; lockout recorded in audit trail; all existing suites still green.
Depends on: none.

---

TASK-SVC-001-A — EdDSA-only production startup (Phase 2 made reachable) ✊

Goal: Let production boot with symmetric service secrets fully retired, per the documented rotation end state.
Files: `src/lib/startup/security-policy.ts`, `docs/deploy/env.production.example`, deploy doc note 17, startup-policy tests.
Implementation: Production requires ≥1 valid plane per role: legacy hex-64 shared secret (known-bad-checked) OR valid Ed25519 material (minter private key / verifier public keys / issuer list); startup self-test signs+verifies; typed `SERVICE_PLANE_INVALID` refusals; template gains the two-plane shape.
Tests: EdDSA-only boots clean; empty planes refuse; malformed key material refuses; rotation overlap OK; known-bad symmetric still refused.
Acceptance: Sandbox E2E: both processes boot with `FAYANMS_SERVICE_SECRET` unset; HS256 retirement runbook executes verbatim.
Depends on: none.

---

TASK-SEC-ENV-001-A — Per-service environment split (secret compartmentalization) ✊

Goal: Stop one `.env.production` from serving app+worker+provision; enforce the secret ownership table.
Files: `compose.yml`, NEW `docs/deploy/env.worker.production.example`, `docs/deploy/env.production.example`, deploy doc T5–T7, NEW `tests/audit/env-boundary.test.ts`.
Implementation: Per-service `env_file`s (worker: identity+vault+URLs+CA pin only; app: session/KEK/DB/service identity, no `FAYANMS_VAULT_*`); startup warning path flags out-of-zone secrets (prod-fail after a deprecation window); compose interpolation unchanged via `--env-file`.
Tests: Parse compose + templates; assert zero cross-zone entries per the ownership table.
Acceptance: `docker compose config` renders per-service env with zero cross-zone secrets; tests green; runbook updated.
Depends on: none.

---

TASK-SCALE-001-A — Shared rate-limit store ✊ (design + contract tests; Redis execution optional)

Goal: Fleet-wide quotas when multi-instance; keep single-host default zero-infra.
Files: `src/lib/api/rate-gate.ts` (+ NEW `src/lib/api/rate-store.ts`), `compose.yml` (optional redis, disabled default), docs.
Implementation: Store interface (in-memory default; Redis/Postgres behind `FAYANMS_RATE_STORE`); atomic sliding-window; global `Retry-After`; documented fail behavior (pinned decision).
Tests: Contract tests for both backends (Redis skipped when absent); two-client shared-budget test.
Acceptance: Two store clients observe one shared budget in tests; behavior switch documented.
Depends on: AUTH-001-A (reuses the guard's store interface).

---

TASK-DOC-001-A — Governance-truth drift fixes ✊ (rides with any commit)

Goal: `ci.yml` header + env template must match live reality.
Files: `.github/workflows/ci.yml` L1–14, `docs/deploy/env.production.example` L16–23.
Implementation: Header states protection truth with a "verified <date>" stamp (flips to "active" only when the live API confirms); template marks `FAYANMS_SERVICE_SECRET` as the legacy/optional plane once SVC-001-A lands.
Tests: Brand/doc honesty pins extended to the workflow header claims.
Acceptance: No doc claims contradict live API or shipped policy.
Depends on: GOV-001-A for the flip to "active"; corrective wording can land now.

---

TASK-GOV-001-A — Restore branch protection on `main` 👤

Goal: `main.protected=true` with required `gate`+`scan`; kill the GOV-001 P0.
Files: GitHub settings (owner token); `ci.yml` header stamp.
Implementation: Ruleset: PR required, ≥1 approval (+CODEOWNERS), conversation resolution, required checks, no force-push/deletion, scoped admin bypass decision recorded; verify via API read-back.
Tests: Governance verification step asserting the read-back.
Acceptance: Live API: `protected:true` + required checks; docs match.
Depends on: none (owner-side).

---

TASK-CI-001-A — Restore CI evidence on the release SHA 👤

Goal: Green `gate`+`scan` on current HEAD; kill the CI-001 P0.
Files: none (billing/minutes); optional runner fallback in `ci.yml`.
Implementation: Verify Actions minutes/billing; re-run from UI; if unavailability persists, self-hosted runner or scheduled weekly full run.
Tests: n/a.
Acceptance: Release SHA has successful required runs; artifacts retained.
Depends on: none (owner-side; parallel with GOV-001-A).

---

TASK-DEPLOY-001-A — HTTPS-by-default reference deployment ✊

Goal: Make the safe path the default path.
Files: NEW `compose.tls.yml`, deploy doc D2, env template origin examples.
Implementation: TLS-terminating proxy profile (auto certs + HSTS) as the documented default; plain-80 explicitly labeled isolated-LAN-pilot-only; secure cookies verified end-to-end.
Tests: Config render test for the TLS profile; docs honesty pins.
Acceptance: Fresh-host runbook yields HTTPS origin; plain HTTP requires deliberate opt-out.
Depends on: none.

---

TASK-SUPPLY-001-A — Digest-pinned bases + built-image scanning ✊ (authoring; execution needs runners)

Goal: Immutable inputs; image-level scan evidence.
Files: `Dockerfile`, `Dockerfile.worker`, `compose.yml`, `.github/workflows/ci.yml`.
Implementation: Pin base images by digest (bump procedure documented); CI builds both images, Trivy `image` scan by digest, image SBOM; optional provenance.
Tests: CI step asserts digest pinning (regex) and scan success.
Acceptance: Release SHA has image-scan evidence; bases immutable.
Depends on: CI-001-A (runner capacity).

---

TASK-TEST-001-A — Continuous browser + multi-container journeys ✊ (authoring; execution needs runners)

Goal: Close the continuous-E2E gap.
Files: NEW `tests/e2e/` (Playwright), `ci.yml` (service containers + job).
Implementation: Journeys: sign-in incl. throttle, inventory CRUD, backup/diff, change draft→approve→execute (simulator), restore (simulator), incidents/alerts, reports, admin negatives, RTL parity, keyboard-only; compose smoke with health + job-engine loop.
Tests: The journeys themselves.
Acceptance: Journeys green in CI on every push; failures block.
Depends on: CI-001-A.

---

TASK-OPS-003-A — Backup/DR drill + runbook ✊

Goal: Prove recoverability (app loss, DB loss, KEK loss/rotation, interrupted change).
Files: NEW `scripts/drill-restore.ts` (or runbook script), deploy doc D1 expansion.
Implementation: Scripted pg_dump→fresh-host restore→health→simulator restore drill; KEK-loss scenario documented as catastrophic-with-webhook/rotation guidance; RPO/RTO recorded.
Tests: Drill assertions (row counts, health endpoints, snapshot decrypt).
Acceptance: Drill passes from backups alone; runbook executed verbatim.
Depends on: none.

---

TASK-CERT-HW-001-A — Real/virtual appliance certification matrix 👤

Goal: Replace "protocol-harness certified" with per-vendor hardware evidence; unlock safe LIVE restore consideration (FUNC-001).
Files: NEW `docs/certification/MATRIX.md`; harnesses stay as CI anchors.
Implementation: Vendor × firmware × capability matrix (auth, backup, drift, change, fail-fast, rollback, restore, key rotation, interruption, large config); evidence recorded; then optional typed live-restore behind operator opt-in + preflight/canary.
Tests: CI pins that README/deploy claims match the matrix exactly.
Acceptance: Published matrix; claims ≡ evidence.
Depends on: hardware lab access (non-sandbox).
