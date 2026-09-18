# FayaNMS — Production-Readiness Implementation Roadmap (2026-09-18)

**Branch:** `z_ai_v2` · **Baseline verified by:** `FayaNMS-z_ai_v2-Full-End-to-End-Production-ReAudit-2026-09-18.md` (PASS; zero P1/P2; gates 894/18/0 in CI shape)
**Purpose:** the concrete, ordered path from the current CONTROLLED-PILOT state to PRODUCTION. Every item names its files, its tests, its acceptance bar, and its gates. Owner-side and lab-side items are stated with exact hand-off instructions so the repository work itself never blocks on ambiguity.
**Execution protocol (unchanged):** every increment = implement + machine-pin + full gates (lint 0 · tsc 0 · full suite · `prisma validate`) + live verification where behavior changes + its own green commit pushed to `origin/z_ai_v2`, with the worklog and NEXT-TASKS updated in the same commit.

---

## Phase R52 — ReAudit remediation ✅ LANDED (this increment, same-day)

The full end-to-end re-audit produced one actionable code finding and a hygiene set; ALL are remediated and machine-pinned in the same increment:

- **R52-F-N1 (P3):** AI routes (`ai/assist`, `ai/change-draft`, `ai/rca-draft`) now resolve the actor BEFORE any DB work (401-before-404 ordering; existence oracle closed). Pins: `tests/audit/r52-auth-ordering.test.ts` (10 pins incl. the `ai/query` within-handler regression guard). Live-proven: 401 unauthenticated / honest 404 authenticated / 200 LLM path.
- **R52-F-N2 (INFO):** stale comments corrected (`proxy.ts` pointer; `meta.users` real consumer = alert assign/suppress picker).
- **R52-H1/H2/H3 (P3):** dead `credentials-view.tsx` deleted; 9 unused runtime deps removed + socket.io pair demoted to devDeps (examples-only); schema "NO Json" rule documents its single sanctioned exception (`LoginGuardState.failures`), pinned as the ONLY Json column.

**Acceptance met:** lint 0 · tsc 0 · suite 884 → **894 pass / 18 skip / 0 fail** (52 files) · live AI-plane + mobile verification.

---

## Phase HC — Authorable hardening backlog (NEXT: R53+)

Everything here is executable inside the sandbox with no external dependency, ordered by risk-reduction per unit of effort. Each item lands as its own increment.

### HC-1 — Per-endpoint rate budgets for high-cost surfaces (R53, next)

- **Why:** the carried CTRL-3 note — budgets are per client-kind (300 GET / 120 mutation per minute); the AI LLM round-trips and the CSV import are orders of magnitude costlier than an average mutation and deserve their own tighter budgets.
- **Files:** `src/lib/security/rate-gate.ts` (add a named-budget registry: e.g. `ai:*` → 10/min, `devices/csv-import` → 5/min), `src/app/api/v1/ai/*/route.ts`, `devices/csv-import/route.ts`; wire the named budget through the proxy plane where the route family is known.
- **Tests:** extend the rate-gate audit pins — budget-table literal pins (route → budget), a decision test for the named-budget lookup, and the documented-default pin (unknown route → current budgets).
- **Acceptance:** each high-cost route answers 429 with `Retry-After` from its own budget; the global budgets unchanged for everything else; pins green.
- **Gates:** standard battery; live 429 demonstration on `/api/v1/ai/query` (11th rapid call) + normal-call unaffected.

### HC-2 — Authenticated bootstrap split for `/api/v1/meta` (R54)

- **Why (F-N3):** the session-exempt bootstrap surface still exposes the active user directory (id/name/role + email local-part). Fine for the demo lab; wrong for production.
- **Design:** `/api/v1/meta` keeps ONLY the pre-auth-needed reference data (vendors, sites, credential profiles) for the sign-in transition; NEW authenticated `/api/v1/meta/users` (or a `?include=users` behind the session gate) serves the alert assign/suppress picker; the client fetches the users segment after hydration.
- **Files:** `src/app/api/v1/meta/route.ts`, `src/lib/api-client.ts` (MetaPayload split + fetch orchestration), `alert-action-dialogs.tsx`, sign-in gate consumers; NEXT-TASKS + README bootstrap-surface note.
- **Tests:** proxy-exemption pins (users data no longer reachable pre-auth — wire-level assertion in the auth audit suite), client split pins, e2e journey keeps the picker working.
- **Acceptance:** unauthenticated `GET /api/v1/meta` contains zero user records (machine-pinned); picker works authenticated.
- **Depends on:** nothing.

### HC-3 — Deprecated `RequestContext` removal (R55, mechanical)

- **Why:** `api.ts:40-59` documents the deprecated `requestContext()`/`_ctx` params still plumbed through ~50 call sites — dead weight with a tracked debt note.
- **Files:** `src/lib/api.ts` + the ~50 call sites (mechanical: drop the param, keep `fail()` signatures via the request-bound context).
- **Tests:** existing suites are the safety net; add a lint-level pin that `requestContext` is exported but no longer referenced outside `api.ts` internals.
- **Acceptance:** zero `_ctx` params in route handlers; tsc + full suite green; `api.ts` debt comment retired.
- **Depends on:** nothing (purely mechanical; schedule between behavioral items).

### HC-4 — i18n completion of chrome copy (R56)

- **Why:** devices/device-detail render some chips/labels as English literals — a documented, deliberate triage decision now scheduled as its own completion pass; en/ar parity is already exact at the key level (1285 = 1285).
- **Files:** the literal sites in `devices-view.tsx` / `device-detail-view.tsx` (and any other view the sweep finds); `messages/en.json` + `messages/ar.json` in lockstep (parity pin exists — keep it green).
- **Tests:** extend the brand/i18n audit: a sweep pin that no `views/*-view.tsx` file contains hardcoded user-visible string literals above a small documented allowlist.
- **Acceptance:** parity pin green; RTL spot-check journey still passes; screenshots en + ar.
- **Depends on:** native-Arabic review of the new strings (sandbox can draft; operator-side linguistic sign-off recommended — fold into the lab visit).

### HC-5 — Supply-chain automation config (R57, small)

- **Why:** no dependabot/renovate; pin discipline is currently manual + the CI osv gate.
- **Files:** NEW `.github/dependabot.yml` (bun ecosystem, weekly, both manifests, grouped security updates) — or renovate.json if the operator prefers; README supply-chain note.
- **Tests:** a config-hygiene pin that the file exists and declares both manifest paths + the known versioning policy (exact pins respected via allow list).
- **Acceptance:** config merged; first dependency-update PRs appear once CI runners exist (OWNER-CI-001) — until then the weekly diff is reviewable manually.
- **Depends on:** nothing (config lands now; effect activates with runners).

### HC-6 — Release gate on real CI (post OWNER-CI-001)

- **Why:** the gate battery has been run in the CI env shape locally since R50.8, but the CI-001 signature (no runner capacity since run #34) means no REMOTE run has ever executed the 4-job workflow end-to-end.
- **Steps:** the moment runner capacity exists → push a no-op docs commit → verify all 4 jobs green (gate incl. `build:gate`, e2e, browser incl. the D/B journeys, scan incl. dual-lockfile osv + image SBOM) → record the run URL in NEXT-TASKS → flip README CI badge from "runner-blocked" honesty note to the live status.
- **Acceptance:** a green full-workflow run on the release SHA; `build:gate` evidence no longer OOM-caveated.
- **Depends on:** OWNER-CI-001 (external).

---

## Phase OWNER — operator-side prerequisites (unchanged, exact hand-off)

- **OWNER-CI-001 — GitHub Actions runner capacity.** The repo's `ci.yml` is complete, SHA-pinned, and honestly documented as runner-blocked since run #34. Action: enable hosted runners (or a self-hosted runner with ≥ 8 GB RAM for `build:gate`) on `fayafatehi/FayaNMS`; then execute HC-6. No code change required — the workflow is ready.
- **OWNER-GOV-001 — branch protection / ruleset on `main`.** Exact config already codified in TASK-GOV-001-A + deploy note 4 (require PR + the 4 required checks, linear history, signed commits recommended). Action: Settings → Rules → Rulesets on GitHub. No code change required. NOTE: `z_ai_v2` is the working integration branch; protection is requested for `main` per the task definition — mirroring it onto `z_ai_v2` is recommended once R52+ merges.

## Phase LAB — real-device certification (unchanged)

- **R50-T090..T092** (SSH CLI fleet + sophos WebAPI + failure classes) against real/virtual appliances — Step 0 remains the PUBLIC DEMO DEVICE PLANE (`docs/certification/PUBLIC-DEMO-DEVICES.md` + `bun run demo:fleet`) so an operator with credentials can start without hardware; then **TASK-CERT-HW-001-A** publishes the per-vendor × firmware × capability matrix and re-opens the LIVE-restore decision behind operator opt-in + preflight/canary (FUNC-001).

## Go-live definition (what "production-ready" means here)

1. HC-1..HC-5 LANDED (HC-6 rides OWNER-CI-001); re-audit verdict stays PASS with zero open P1/P2/P3-authorable.
2. OWNER-CI-001 closed: green 4-job workflow run on the release SHA (HC-6 evidence recorded).
3. OWNER-GOV-001 closed: `main` protection active with the 4 required checks.
4. LAB: R50-T090..T092 certified on at least one representative per vendor family; matrix published; LIVE-restore decision documented (certified-refused or opt-in).
5. Final pre-go-live increment: fresh independent full re-audit on the release SHA + this checklist re-run top to bottom.

---

## Current status ledger

| Phase | State |
|---|---|
| R52 (re-audit remediation) | ✅ LANDED — this increment |
| HC-1 rate budgets | 🔜 NEXT (R53) |
| HC-2 meta split | queued |
| HC-3 RequestContext removal | queued |
| HC-4 i18n completion | queued |
| HC-5 dependabot config | queued |
| HC-6 real-CI release gate | blocked → OWNER-CI-001 |
| OWNER-CI-001 / OWNER-GOV-001 | external, config ready |
| LAB R50-T090..T092 + CERT-HW-001-A | external, Step 0 ready (`demo:fleet`) |
