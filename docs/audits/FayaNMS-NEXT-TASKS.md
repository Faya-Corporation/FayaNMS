# FayaNMS — NEXT TASKS (execution backlog, 2026-09-15)

Derived from `FayaNMS-Independent-Current-Main-Audit-2026-09-15.md` + `FayaNMS-Production-Remediation-Roadmap-2026-09-15.md`. Tasks are independently implementable and landable as separate green commits. Sandbox-actionable tasks are marked ✊; user/infrastructure-side are marked 👤.

---

TASK-AUTH-001-A — Login throttling, backoff, lockout, sign-in telemetry ✊ → ✅ LANDED (R35, 2026-09-15)

Goal: Bound online password guessing on `/api/auth/*` (outside the `/api/v1` gate; `authorize()` has no attempt control).
Files: `src/lib/auth/options.ts`, NEW `src/lib/auth/login-guard.ts`, `tests/audit/login-guard.test.ts`, deploy doc security note, README security paragraph.
Implementation: Pre-auth sliding-window guard keyed by (trusted-proxy IP, normalized account) with exponential backoff + temporary lockout; typed audit events (`SIGNIN_THROTTLED`, `SIGNIN_LOCKOUT`); enumeration-safe generic failure responses; store behind an interface so the SCALE-001-A shared backend can slot in.
Tests: budget/backoff/lockout/reset pins; trusted-hop keying; audit emission; enumeration-safety.
Acceptance: 50 simulated attempts → throttled with `Retry-After`; lockout recorded in audit trail; all existing suites still green.
Depends on: none.
Landed (R35): guard module + `authorize()` enforcement BEFORE the DB lookup/scrypt + route pre-check on the credentials callback only (429 + `Retry-After` envelope); HMAC-keyed non-reversible account identity (no raw identifiers stored/logged/emitted); 30 s·2^n lockout capped at 4 min (never permanent, decays fully, success resets); bounded store (5,000-key cap, 64 stamps/key) behind `LoginGuardStore`; 37 contract tests; env knobs documented in `.env.example` + `docs/deploy/env.production.example` + deploy-doc security note 20. **Honest scope: login abuse control implemented — this is the single-process store; distributed production rate limiting (fleet-wide budgets) remains TASK-SCALE-001-A, which reuses this guard's store interface. The parent AUTH-001 finding is PARTIALLY FIXED (in-process) until that lands.**

---

TASK-SVC-001-A — EdDSA-only production startup (Phase 2 made reachable) — **LANDED (R36)** ✅

Goal: Let production boot with symmetric service secrets fully retired, per the documented rotation end state.
Landed as: mode-aware startup policy (eddsa-only / dual / hs256-legacy / unconfigured, derived from configuration — no mode switch); Ed25519-only production config boots clean with NO `FAYANMS_SERVICE_SECRET`; app requires its own private key in eddsa-only mode (it mints control tokens); malformed/wrong-type key material fails at BOOT (static reasons, no material echoed); duplicate public keys deduplicated; `kid` pinned inert; worker boot check (`identity-boot.ts`) mirrors the policy worker-side; legacy HS256 minting made visible (explicit warning); env templates + README + deploy-doc note 17 rewritten around the three states and the two-plane ownership table.
Evidence: `tests/auth/service-identity-modes.test.ts` (38 pins incl. the full startup matrix and the Ed25519-public-key-as-HMAC confusion attempt); suite 456 → 494; LIVE production-boot proof with EdDSA-only env (`GET /` → 200, internal route → 401) plus boot-refusal negative controls; certify.ts exit 0.
Audit status: **SVC-001: FIXED** — Ed25519-only production identity is bootable and verified end-to-end.
Parent context: secret SCOPE separation (which process may hold which material) remains TASK-SEC-ENV-001-A.
Depends on: none.

---

TASK-SEC-ENV-001-A — Per-service environment split (secret compartmentalization) ✊ → ✅ LANDED (R37, 2026-09-15)

Goal: Stop one `.env.production` from serving app+worker+provision; enforce the secret ownership table.
Landed as: `.env.production` demoted to the HOST-SIDE interpolation file only (`--env-file`; build args, composed `DATABASE_URL`, host port); app runtime env split to `.env.production.app` (session/KEK/CONTROL identity, NO `FAYANMS_VAULT_*`); worker runtime env split to `.env.production.worker` (WORKER identity/vault entries/WebAPI CA pin, NO `NEXTAUTH_SECRET`/KEK/`POSTGRES_PASSWORD`/`DATABASE_URL`); provision receives NO env file (composed `DATABASE_URL`; demo-mode stays a `-e` override). Both runtimes WARN at boot on out-of-zone variables (by name, never values) — `findAppSecretScopeWarnings` (vault wildcard + worker-zone vars) in `security-policy.ts` and `findWorkerSecretScopeWarnings` in worker `identity-boot.ts` — with the documented deprecation window after which they refuse. Templates `docs/deploy/env.app.production.example` + `env.worker.production.example` (new), `env.production.example` rewritten host-side; deploy-doc T6 rewritten + security note 21; README LANDED block.
Evidence: `tests/audit/env-boundary.test.ts` (30 pins: compose env-file mapping incl. the shared-file abolition, template zone purity both ways, warning semantics, value-never-echoed, required-vars-never-forbidden, boot wiring); suite 494 → 524. `docker compose config` NOT VERIFIED — infrastructure limitation (no Docker in this environment); the static boundary tests are the executable verification here.
Audit status: **SEC-ENV-001: FIXED** — runtime configuration boundaries match the ownership table (runtime `docker compose config` render remains runner/lab evidence, CI-001).
Depends on: none.

---

TASK-SCALE-001-A — Shared rate-limit store ✊ → ✅ LANDED (R38, 2026-09-15) for the API gate plane

Goal: Fleet-wide quotas when multi-instance; keep single-host default zero-infra.
Landed as: `src/lib/api/rate-store.ts` — ONE store contract, two implementations: bounded in-memory default (identical gate semantics, zero new infra) and opt-in PostgreSQL shared store (`FAYANMS_RATE_STORE=postgres`) reusing the database the app already runs (no new service; a Redis service would add mandatory infra the single-host deployment does not run — the interface accepts further backends). Postgres hits serialize per key via `pg_advisory_xact_lock` and run prune → count → insert/deny in ONE transaction (no GET/increment/SET race); denied attempts consume no slots; per-key pruning + global stale sweep bound retention; unreachable store fails CLOSED (pinned, documented decision). `takeRateSlot` is now async over the resolved store; the proxy awaits it; unknown `FAYANMS_RATE_STORE` values refuse.
Evidence: `tests/audit/rate-store.test.ts` (19 pins: shared contract over BOTH backends — budget/Retry-After-oldest-stamp/slide/key-isolation/no-slot-consumption/parallel-atomicity 12→5 — PLUS the acceptance: two clients on separate Prisma pools share ONE budget both directions; fail-closed outage; resolution policy incl. unknown-refusal); rate-gate suite converted to await (26 pins intact, incl. bounded-sweep + spoofing + proxy-wiring order).
Honest scope: the LOGIN guard (AUTH-001-A) keeps its per-instance store — its read-modify-write lockout state needs the same atomic per-key transaction shape; a plain SQL KV would race across instances and was REFUSED as a false fix. Tracked as TASK-SCALE-001-B (below). Parent AUTH-001 remains PARTIALLY FIXED (distributed login plane pending).
Audit status: **SCALE-001: FIXED for the API rate gate (the finding's named surface); login plane → TASK-SCALE-001-B.**
Depends on: none (the AUTH-001-A store interface stays; the API gate had no shared seam before this).

---

TASK-SCALE-001-B — Distributed backend for the login guard's lockout state ✊

Goal: Close the remaining AUTH-001 half: fleet-wide login budgets/lockout when 2+ app instances.
Files: `src/lib/auth/login-guard.ts` (+ store), reuse `src/lib/api/rate-store.ts` patterns.
Implementation: Give the guard an atomic per-key transaction path (the rate-store's `pg_advisory_xact_lock` + prune/count/decision shape) so read-modify-write lockout state cannot race across instances; keep the in-memory default; reuse `FAYANMS_RATE_STORE` or a dedicated knob.
Tests: Two-client shared lockout test (instance A locks, instance B honors); concurrency pins.
Acceptance: Login budgets mean one fleet budget under `FAYANMS_RATE_STORE=postgres`; AUTH-001 flips to FIXED.
Depends on: SCALE-001-A (landed — same atomic pattern).

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

TASK-TEST-001-A — Continuous browser + multi-container journeys ✊ → ✅ LANDED (R39, 2026-09-15) as HTTP-level E2E journeys + CI gate

Goal: Close the continuous-E2E gap.
Landed as: `tests/e2e/` — release-critical journeys driven over REAL HTTP against the REAL topology (production standalone server + poll-based worker + PostgreSQL + simulator plane — zero mocks, per the remediation prompt C2 "no giant brittle suite" + C3 "not mocked internal state"): J1 auth (NextAuth CSRF dance → session → authorized route → logout → session dead), J2 inventory (create/read/update/409-duplicate), J3 change lifecycle (submit → MEDIUM bindable approvals → worker-driven execute → SUCCESSFUL; PLUS the failure case failAt=APPLY → truthful FAILED per-step states), J4 API client (token-once → scoped bearer ack → scope refusal → revoke → 401 after), J5 login throttle (burst → 429+Retry-After → full recovery). The harness (`e2e-server.ts`) creates/migrates/seeds its own `fayanms_e2e` database, boots `.next/standalone/server.js` (fresh random secrets per run — the CI fixture values are production-refused by design, P1-019) and a minimal-env worker (SEC-ENV-001 modeled); journeys skip unless `FAYANMS_E2E=1` (the unit gate stays hermetic). `.github/workflows/ci.yml` gained a hard-gate `e2e` job (postgres service + build + `FAYANMS_E2E=1 bun test tests/e2e/`).
**Journey-found P1 regression, fixed in the same commit:** `src/app/api/auth/[...nextauth]/route.ts` dropped the Next.js route context when forwarding POST to NextAuth — `handler(req)` without ctx destructures `nextauth` from undefined → **EVERY runtime credentials sign-in 500'd since R35** (the unit tier mocked the handler and could not see it; the live journey could). Fix: forward ctx (next-auth v4.24.15 awaits params).
Evidence: `FAYANMS_E2E=1 bun test tests/e2e/` → **6/6 pass (52.6 s) against the live stack**; unit suite unchanged (journeys skip: 549 tests / 543 pass + 6 skips).
Honest scope: Playwright/visual browser journeys, RTL-parity and keyboard-only sweeps remain a separate authoring task (A11Y-001-A / browser-E2E) — these are HTTP-level journeys; the CI `e2e` job execution is runner-blocked (CI-001) and recorded honestly on every push.
Depends on: none (was: CI-001-A — decoupled: the journeys run locally and will run in CI the moment runners return).

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
