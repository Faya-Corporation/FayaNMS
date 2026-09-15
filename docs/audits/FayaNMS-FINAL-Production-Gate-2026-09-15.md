# FayaNMS — FINAL Production Gate (operator/release checklist)

**Score 85/100 · CONTROLLED PILOT · 2026-09-15 · audited HEAD `c65a9b1`**
Release to "PRODUCTION READY" requires every ☐ below ticked with evidence. Do not tick from hope.

## A. Code-side posture (current: all green)

- [x] Per-service secret scopes enforced (compose split + boot warnings → future refusal) — `tests/audit/env-boundary.test.ts`
- [x] Ed25519-only production service identity bootable; legacy plane only in migration modes — deploy note 17
- [x] Login abuse control live (throttle/lockout/Retry-After, journey-proven) — AUTH-001-A + E2E J5
- [x] Shared distributed rate store available (`FAYANMS_RATE_STORE=postgres`) — SCALE-001-A
- [x] All execution-safety guards source-pinned (single-flight, atomic step claim, device write locks, fail-fast, exact typed restore, approval fingerprint/quorum/expiry)
- [x] SSRF two-plane guard; DNS-rebinding residual classified ACCEPTED RISK with threat model
- [x] TLS-terminating proxy profile shipped (`compose.tls.yml` + Caddyfile; HSTS, auto-redirect, cert rotation)
- [x] Container hardening (cap_drop ALL, no-new-privileges, read-only app/worker roots, PID/mem bounds)
- [x] Base images digest-pinned; CI builds + image-scans + SBOMs
- [x] 12 h admin sessions; production stdout not tee'd to unbounded files
- [x] 580 governance/contract pins + 6/6 live E2E journeys + 6-vendor protocol certification + drift guard 0

## B. Owner actions (blockers — required for PRODUCTION READY)

- [ ] **GOV-001**: enable `main` ruleset/branch protection — PRs required, ≥1 approval (+CODEOWNERS), conversation resolution, required checks `gate` + `scan` + `e2e`, force-push + deletion forbidden, admin bypass scoped and recorded (SOCIAL-REPOSITORY §6). Verify via API read-back `protected:true`, THEN flip the docs (they currently state NOT ACTIVE — truth-first).
- [ ] **CI-001**: restore Actions runner capacity — verify minutes/billing; re-run `gate`+`scan`+`e2e` on the release SHA from the Actions UI; if unavailability persists, add a self-hosted runner. A green OLD SHA is not release evidence.

## C. Lab actions (blockers — required for PRODUCTION READY)

- [ ] **CERT-HW-001 / FUNC-001**: execute `docs/certification/MATRIX.md` §3 per vendor × firmware (nine-step procedure, per-row signing). LIVE restore stays REFUSED until its gate passes — do not remove the typed refusal any other way.

## D. Non-blocking authoring backlog (post-gate)

- [x] TASK-SCALE-001-B — distributed backend for the login guard's lockout state (atomic per-key transaction shape). LANDED R46: `FAYANMS_RATE_STORE=postgres` makes the login plane fleet-wide (`LoginGuardState` + per-key advisory-lock tx); AUTH-001 FIXED end-to-end — `tests/audit/login-guard-distributed.test.ts` (20 pins, two-instance acceptance).
- [ ] TASK-BROWSER-E2E — Playwright/visual journeys + axe a11y + RTL/keyboard sweeps on the rendering layer.

## E. Release ritual (every release, after A–C are green)

1. `git pull` on the deploy host; take a `pg_dump` snapshot (D1).
2. `docker compose --env-file .env.production -f compose.yml -f compose.tls.yml build` (rebuild bakes the origin).
3. `-f compose.yml -f compose.tls.yml run --rm --no-deps provision sh -c 'bunx prisma migrate deploy'` (forward-only migrations; drift guard proved history ≡ schema).
4. `-f compose.yml -f compose.tls.yml up -d`; watch `docker compose logs app` for the clean policy banner.
5. Verify: `curl -I https://<domain>/` (TLS + HSTS), sign-in works (journey-proven path), Job Center claims, audit trail writes.
6. Record the release SHA + CI run IDs + gate evidence in worklog.md. Evidence before assertion.
