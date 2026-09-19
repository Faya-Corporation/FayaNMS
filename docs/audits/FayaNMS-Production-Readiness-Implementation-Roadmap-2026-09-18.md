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
- **Steps:** the moment runner capacity exists → trigger the full 4-job battery via **`workflow_dispatch`** (added R63) or by opening the candidate PR (pull_request triggers all four jobs; a push to `z_ai_v2` alone runs NOTHING) → verify all 4 jobs green (gate incl. `build:gate`, e2e, browser incl. the D/B journeys, scan incl. dual-lockfile osv + image SBOM) → record the run URL in NEXT-TASKS → flip README CI badge from "runner-blocked" honesty note to the live status.
- **Acceptance:** a green full-workflow run on the release SHA; `build:gate` evidence no longer OOM-caveated.
- **Depends on:** OWNER-CI-001 (external).

---

## Phase OWNER — operator-side prerequisites (unchanged, exact hand-off)

- **OWNER-CI-001 — GitHub Actions runner capacity.** The repo's `ci.yml` is complete, SHA-pinned, and honestly documented as runner-blocked since run #34. Action: enable hosted runners (or a self-hosted runner with ≥ 8 GB RAM for `build:gate`) on `fayafatehi/FayaNMS`; then execute HC-6. No code change required — the workflow is ready.
- **OWNER-GOV-001 — branch protection / ruleset on `main`.** Exact config already codified in TASK-GOV-001-A + deploy note 4 (require PR + the 4 required checks `gate`+`e2e`+`browser`+`scan` — R66 correction aligns every doc with the workflow header marker; linear history, signed commits recommended). Action: Settings → Rules → Rulesets on GitHub. No code change required. NOTE: `z_ai_v2` is the working integration branch; protection is requested for `main` per the task definition — mirroring it onto `z_ai_v2` is recommended once R52+ merges.

## Phase LAB — real-device certification (unchanged)

- **R50-T090..T092** (SSH CLI fleet + sophos WebAPI + failure classes) against real/virtual appliances — Step 0 remains the PUBLIC DEMO DEVICE PLANE (`docs/certification/PUBLIC-DEMO-DEVICES.md` + `bun run demo:fleet`) so an operator with credentials can start without hardware; then **TASK-CERT-HW-001-A** publishes the per-vendor × firmware × capability matrix and re-opens the LIVE-restore decision behind operator opt-in + preflight/canary (FUNC-001).

## Go-live definition (what "production-ready" means here)

1. HC-1..HC-5 LANDED (HC-6 rides OWNER-CI-001); re-audit verdict stays PASS with zero open P1/P2/P3-authorable.
2. OWNER-CI-001 closed: green 4-job workflow run on the release SHA (HC-6 evidence recorded).
3. OWNER-GOV-001 closed: `main` protection active with the 4 required checks (`gate`, `e2e`, `browser`, `scan`).
4. LAB: R50-T090..T092 certified on at least one representative per vendor family; matrix published; LIVE-restore decision documented (certified-refused or opt-in).
5. Final pre-go-live increment: fresh independent full re-audit on the release SHA + this checklist re-run top to bottom.

---

## Current status ledger

| Phase | State |
|---|---|
| R52 (re-audit remediation) | ✅ LANDED |
| HC-1 rate budgets | ✅ LANDED (R53) — evidence: `FayaNMS-R53-HC1-Rate-Budgets-2026-09-18.md` |
| HC-2 meta split | ✅ LANDED (R54) — evidence: `FayaNMS-R54-HC2-Meta-Users-Split-2026-09-18.md` |
| HC-3 RequestContext removal | ✅ LANDED (R55) — evidence: `FayaNMS-R55-HC3-RequestContext-Removal-2026-09-18.md` |
| HC-4 i18n completion | ✅ LANDED (R56) — evidence: `FayaNMS-R56-HC4-I18n-Chrome-2026-09-18.md` |
| HC-5 dependabot config | ✅ LANDED (R57) — evidence: `FayaNMS-R57-HC5-Dependabot-Config-2026-09-18.md` |
| HC-6 real-CI release gate | blocked → OWNER-CI-001 (Phase HC authorable queue now EMPTY: HC-1..HC-5 all LANDED) |
| Phase HC completion report (R58 sweep) | ✅ R58 — `FayaNMS-Phase-HC-Completion-Report-2026-09-18.md` (gates + wire contracts + journeys re-verified on release SHA 5d71466) |
| Operator hand-off release notes (R59) | ✅ R59 — `FayaNMS-Operator-Handoff-Release-Notes-2026-09-18.md` (single entry point for the operator runbook: OWNER-CI-001 → HC-6, OWNER-GOV-001, LAB, merge + final re-audit) |
| R52 INFO polish notes (R60) | ✅ R60 — `FayaNMS-R60-Info-Polish-Zero-2026-09-18.md` (remaining 3 of 4 INFO notes closed: ci.yml postgres digest-pinned ×3, gitignore path explicit, README Bun floor 1.3.14; INFO list now EMPTY — audit trail carries zero open notes of any severity) |
| R61 P0 remediations (re-verification) | ✅ R61 — `FayaNMS-R61-P0-SSH-First-Contact-and-IPv6-Canonicalization-2026-09-19.md` (credential-free SSH first contact — zero vault, zero auth, protocol-proven via a persona auth-attempt counter; canonicalization-safe IPv6 in both target-policy copies; suite 947 → 954) |
| R62 P1 remediations (re-verification) | ✅ R62 — `FayaNMS-R62-P1-Service-Scoping-and-Read-RBAC-2026-09-19.md` (service-JWT surface isolation at the proxy; credentials GET admin-gated; snapshot texts config.download-gated with decrypt only on the privileged path; suite 954 → 963) |
| R63 CI trigger + hand-off corrections | ✅ R63 — `FayaNMS-R63-CI-Trigger-and-Handoff-Corrections-2026-09-19.md` (workflow_dispatch added — the corrected HC-6 execution path; hand-off notes refreshed: ledger-deferred numbers, Dependabot default-branch activation caveat, corrected runbook ordering; suite 963 → 967) |
| R64 gate re-execution + unit-gate hermeticity | ✅ R64 — `FayaNMS-R64-Gate-Reexecution-and-Hermeticity-2026-09-19.md` (R61–R63 gates independently RE-EXECUTED from a cold shell: recorded 967/18/0 exactly reproduced at the R63 tree; found + fixed a unit-gate hermeticity defect — the dev `.env` regenerated post-R62 leaked key material into in-process mint/verify via bun auto-load + the worker's `.env`-file fallback; explicit-empty suppression + `FAYANMS_SERVICE_ENV_FILE` knob in both reader copies; 3-knob gate env contract documented; 5 pins; suite 967 → 972) |
| R65 session-resume verification + HC-6 dispatch executed | ✅ R65 — `FayaNMS-R65-Operator-Path-Dispatch-Verification-2026-09-19.md` (resume reconciliation: summary claimed R60/@38c93f1 "fixes not started" — repo actually at R64/`7cb6be4` pushed 0/0; gates independently RE-EXECUTED: lint 0 · tsc 0 · 972/18/0 exact reproduction under the 3-knob gate env; LIVE re-proven (meta 200 · worker /health 200 · unauth 401 fail-closed); **HC-6 `workflow_dispatch` EXECUTED end-to-end for the first time** — 204 → run `35406875963` bound to `z_ai_v2`@`7cb6be4` → gate failure with 0 steps = the known runner-infra signature (#34/#89), trigger path PROVEN, sole remaining blocker is runner capacity; `agent-ctx/` scratch dir gitignored) |
| R66 candidate-PR rehearsal + required-checks shape unification | ✅ R66 — `FayaNMS-R66-Candidate-PR-Rehearsal-and-Required-Checks-Shape-2026-09-19.md` (merge pre-flight: `merge-tree --write-tree` exit 0 — the protective merge is CLEAN, 35 commits / 198 files / +14,738−1,973; second HC-6 dispatch probe on `0d28a34`: run `35408254887` → gate failure 0 steps, same infra signature; **governance defect fixed**: TASK-GOV-001-A + 6 more operation docs carried stale 2-check/3-check required-checks sets vs the 4-job workflow — an operator following them would let e2e/browser failures MERGE; all unified to `gate`+`e2e`+`browser`+`scan` matching the R47 header marker; 6 new pins; suite 972 → 978) |
| R67 executable GOV read-back + candidate PR package + plan-gate discovery | ✅ R67 — `FayaNMS-R67-Executable-Gov-Readback-and-PR-Package-2026-09-19.md` (TASK-GOV-001-A acceptance made EXECUTABLE: `scripts/gov-verify.ts` reads classic protection AND rulesets live, asserts all FOUR checks + approvals + code-owner review + force-push/deletion off, typed exit 0/1/2, token env-only; **LIVE smoke run discovered the GitHub-Free PLAN GATE** — private repo branch protection answers 403 "Upgrade to GitHub Pro or make this repository public": a plan prerequisite no earlier doc recorded, now step 0 of the runbook; CODEOWNERS header aligned to the four-check shape; paste-ready candidate PR package authored (the PR's own pull_request checks are an HC-6 vehicle); 8 pins A–H incl. PAT-hygiene; suite 978 → 986) |
| R68 browser golden-path re-execution + hand-off refresh | ✅ R68 — `FayaNMS-R68-Browser-Reexecution-and-Handoff-Refresh-2026-09-19.md` (HC-6 probe #3: run `35411315267` @ `13a8fcf` → same 0-steps infra signature — trigger triple-proven across three SHAs; golden-path browser journey RE-EXECUTED live with zero console/page errors: sign-in → shell → devices EN → العربية RTL (`dir=rtl`, `الأجهزة`, zero h-scroll, genuinely localized chrome) → back to EN → sign-out gate; honest harness-precondition finding recorded (standalone build artifact absent + :3030 collision — environmental, not regression); hand-off numbers refreshed (986/18/0, FOUR operator blockers, R63–R67 changelog rows, dispatch triple-probe); README badge alt retired its pre-R47 wording) |
| R69 FULL ROADMAP RE-REVIEW + same-round remediations | ✅ R69 — `FayaNMS-R69-Full-Roadmap-ReReview-2026-09-19.md` (senior independent full-stack re-review of EVERY roadmap item against the ACTUAL code via three parallel deep-read passes — R52, HC-1..HC-5, R61/R62 remediations, HC-5, gov-verify/ci.yml: **all substantive claims HELD**; FOUR findings found + fixed + pinned same round: **R69-F1 (P1) snapshots/diff route returned decrypted config text with NO permission gate → config.download-gated before any DB work + CONFIG_DIFF_DENIED audit, viewer/auditor fail-closed by design**; R69-F2 meta/users full-email fallback → local-part; R69-F3 gov-verify ruleset plane now asserts non_fast_forward/deletion/required_conversation_resolution/required_linear_history + header/label reconciliation; R69-F4 ci.yml header names ALL FOUR jobs; path-correction appendix added below; suite 986 → **997/18/0**; LIVE 200/200/401 + unauth diff 401 + budgets re-demoed 429) |
| R70 MERGE TO MAIN + first real CI execution + DB-bootstrap fix | ✅ R70 — `FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md` (operator-authorized DIRECT merge executed: pure fast-forward `27e0eea..6538d46`, 39 commits / 213 files / +16,377−1,990, linear history preserved, all four refs identical 0/0; dispatch probe #4 → 204 → run `35414649589` @ main = **FIRST REAL gate execution** after the infra-blocked era — deps/lint/tsc ✅, Tests failed on the empty CI DB (`public.User does not exist`); latent ordering defect FIXED: `prisma migrate deploy` moved ABOVE Tests, duplicate retired, proven on a byte-fresh replica DB (`fayanms_gatecheck` → 997/18/0); gov-verify main re-classified exit 2 `GOV-PLAN-BLOCKER` — plan gate persists post-merge; 16 pins; suite 997 → 1013/18/0) |
| R71 CI bring-up iteration 2 — certify step lab-hatch env | ✅ R71 — R70 audit doc §7 (`FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md`): dispatch #5 (run `35415388173` @ `d3136c6`) went DEEPER than any run in history — **the FULL test suite GREEN IN REAL CI (1013/18/0, byte-identical to local) with the R70 bootstrap fix live** — then failed at the next never-executed step: Live SSH certification refused its own 127.0.0.1 harnesses (`SSH_TARGET_POLICY_REFUSED: loopback`) because the step never presented the documented `FAYANMS_PROBE_ALLOW_SPECIAL=true` lab hatch (driver only ever ran inside the sandbox shell that exported it); FIX: step env now presents the hatch + the three R64 hermeticity knobs; CI-replica re-execution with the exact step env: **CERT RESULT: PASSED (134 checks, 5 flavors)**; 5 pins; suite 1013 → 1018/18/0 |
| R72 CI bring-up iteration 3 — FIRST GREEN GATE + seed-KEK fix + gitleaks triage | ✅ R72 — R70 audit doc §8: dispatch #6 (run `35416148348` @ `18c1a28`) = **FIRST GREEN GATE JOB in repo history** (every step incl. Tests 1018/18/0, SSH certification, drift guard, i18n, production build); e2e/browser first-ever execution failed at the harness seed (ambient `FAYANMS_CONFIG_ENC_KEY` dependency — masked locally by bun auto-load of dev `.env`) → seed env now carries the run's fresh RUN_SECRET (replicated: empty → exact CI error exit 1; valid 64-hex → Seed complete.); scan first-ever gitleaks run exited 2 on committed throwaway fixtures → committed `.gitleaks.toml` (useDefault kept + seven-path triaged allowlist, P1-019 non-authority rationale) verified with checksum-verified gitleaks 8.24.3: **"no leaks found" (exit 0, 193 commits)**; 7 pins; suite 1018 → 1025/18/0 |
| R73 CI bring-up iteration 4 — FIRST GREEN e2e + D-file missing-goto defect + trivy triage | ✅ R73 — R70 audit doc §9: run `35417127704` @ `feafb0d` = gate GREEN **second consecutive** + **FIRST GREEN e2e JOB in repo history** (R72 seed-KEK fix proven on the wire) + main TASK-BROWSER-E2E suite first-time green 6/6 (B1–B5: sign-in, dashboard, axe ×2, keyboard, RTL); browser D-file (R50.8 detection journeys) failed 6/6 on a **genuine defect the sandbox could never see** — its `signIn()` filled `#sign-in-email` on a never-navigated `about:blank` page (goto lived only in `openAddDeviceSheet`) → FIXED: signIn navigates first, byte-mirroring the proven B-file (first real execution anywhere for this file); scan gitleaks GREEN (R72 allowlist proven) but trivy fs exited 1 on its ONLY finding — the committed test-only loopback SFOS harness key (P1-019 non-authority, gitleaks-trialed R72) → FIXED two planes: trivy dedicated `skip-files` input scoped `mini-services/worker/harness/tls/*` (mechanism verified against pinned action source: → `TRIVY_SKIP_FILES` env) + `.dockerignore` excludes the TLS fixtures from image layers (lazy PEM reads verified in `startSfosWebApiHarness()`); machine proof with checksum-verified trivy 0.70.0 on a byte-faithful git-archive tree: no skip → exit 1 single HIGH secret (byte-identical to the run); with skip → **exit 0, zero findings**; 7 pins; suite 1025 → 1032/18/0 (8,470 expects, 68 files) |
| R74 CI bring-up iteration 5 — sidebar-group journey + image build-arg | ✅ R74 — R70 audit doc §10: dispatch #7 (run `35420764756` @ `7a9a34f`) = gate GREEN **third consecutive** + e2e GREEN **second consecutive** + trivy fs GREEN (R73 skip-files proven on the wire); the two remaining failures each moved a layer deeper: (1) browser — the R73 signIn fix HELD; the D-file then waited on the "Devices" button, which is rendered INSIDE the collapsible "Network" sidebar group (auto-opens only while it owns the active view — dashboard after sign-in ⇒ closed; `openGroups[group.id] ?? containsActive`) → openAddDeviceSheet now expands the group (nav-scoped, visibility-guarded) before clicking the item, the same journey an operator performs; (2) scan — the image-build step's FIRST execution was refused by the Dockerfile's own T1 guard (production NEXT_PUBLIC_SITE_URL mandatory; localhost/*.local rejected by siteUrl()) → CI passes an IETF-reserved example.com origin for the SCAN-TARGET images (never run or deployed; provenance inline; real deployments keep the real origin via compose --env-file); 5 pins; suite 1032 → 1038/18/0 (8,498 expects, 69 files) |
| R75 CI bring-up iteration 6 — journey-accurate D-tests + portable non-root user | ✅ R75 — R70 audit doc §11: run `35421797082` @ `af91847` = gate GREEN **fourth consecutive** + e2e GREEN **third consecutive** + browser **9/12** (D6, D8+D9, D10 joined the green B-suite); three JOURNEY bugs fixed (D7 strict-mode substring→exact; D11 impossible one-chip two-button sequence→two passes; D12 sandbox-specific code→topology-honest typed-code invariant) + scan image build died `addgroup: not found` (slim base ships neither adduser nor addgroup) → pinned uid/gid 10001 registered via /etc/passwd+/etc/group appends (same non-root result, no packages, no network); 7 pins |
| R76 CI bring-up iteration 7 — FIRST GREEN BROWSER JOB (12/12) + image build type resolution | ✅ R76 — R70 audit doc §12: run `35422501995` @ `6d01aeb` = gate GREEN **fifth consecutive** + e2e GREEN **fourth consecutive** + **browser GREEN FIRST TIME in repo history (12/12 — B-suite + all six detection-panel journeys after four bring-up iterations)**; scan one layer deeper: next build type-checks the whole repo (root tsconfig include `**/*.ts` — the documented src/ + worker zero-error policy) so the image build must resolve ssh2/@types/ssh2 for the worker TS files (TS2307; ci.yml's frozen worker-deps step provides this to the other jobs; Docker build stage never had it; Bun segfault followed the type errors during teardown) → build stage installs worker deps frozen from the committed lockfile (byte-mirrors the CI jobs) while the runtime stage stays worker-free (audited image content unchanged); 5 pins |
| R77 CI bring-up iteration 8 — build COMPLETED: artifact-verified gate + disk prewash | ✅ R77 — R70 audit doc §13: run `35423093770` @ `c73f14b` = gate GREEN **sixth consecutive** + e2e GREEN **fifth consecutive** + browser GREEN **second consecutive 12/12**; the image build went deeper than ever — next build COMPLETED (full route summary) and Bun 1.3.14 then segfaulted at process exit (its own teardown bug, exit 132 after success) with the runner at **0 MB free** → build success verified by ARTIFACTS (.next/BUILD_ID + standalone required or RUN fails — no `|| true`, a failed build still fails) + scan-job disk prewash (hosted image unused toolchains + docker prune before the build); 5 pins; suite 1050 → 1055/18/0 (8,574 expects, 72 files) |
| R78 CI bring-up iteration 9 — artifact-verified build PROVED; first image scan triaged | ✅ R78 — R70 audit doc §14: run `35423693016` @ `819feb1` = gate/e2e/browser GREEN + the image build PASSED with the artifact-verified gate (BUILD_ID + standalone proven; the Bun teardown segfault only a documented note); the FIRST image scan found **88 HIGH/CRITICAL — all base Debian packages** (fixes published after the base was built; pinned digest IS the current tag resolution, registry-verified) → both runtime stages track the Debian security channel (apt-get upgrade, lists dropped, root before USER) + image scans gain `ignore-unfixed: true` (fatal for every fixable HIGH/CRITICAL; unfixable reported, not fatal; fs scan untouched); 5 pins; suite 1055 → 1060/18/0 (8,600 expects, 73 files) |
| R79 **HC-6 ACCEPTED — FIRST FULL 4-JOB GREEN RUN** | ✅ R79 — R70 audit doc §15: run `35424363304` @ `cf258cd` (2026-09-19) **SUCCESS — all four jobs**: gate 3m21s (every step) · e2e · browser 12/12 · scan 7m58s (gitleaks, semgrep, osv ×2, SBOM, trivy fs, both image builds artifact-verified, both image scans, per-image SBOMs); closes the nine-iteration bring-up (R70 DB bootstrap → R71 certify hatch → R72 seed KEK + gitleaks → R73 missing-goto + trivy fs → R74 sidebar + build-arg → R75 journeys + portable user → R76 worker types → R77 artifacts + disk → R78 OS-vuln triage); README badge/prose flipped to the green truth; OWNER-CI-001 execution half CLOSED (remaining operator items: OWNER-GOV-001 plan-gated ruleset + LAB hardware matrix); 4 pins |
| R80 i18n tranche 1 — six views keyed | ✅ R80 — `FayaNMS-R80-I18n-Tranche1-Six-Views-Keyed-2026-09-19.md`: the R56 `PENDING_VIEWS` debt ledger's first shrink (untouched at 824 candidates / 33 files since R56) — **placeholder, ztp, changes-templates, noc, changes-calendar, sites fully keyed by hand** against full inventories (incl. non-swept lowercase/template copy), five new namespaces (`sites`/`noc`/`changesCalendar`/`changeTemplates`/`placeholder`, 66 leaves, en = ar deep parity, byte-preserving insertion); ledger 32 → **26 entries (824 → 791 candidates)**; ztp's three technical example placeholders exact-match-governed by the new `KEYED_SURVIVORS` (LIVE-chip precedent); 8 new pins + sweep governance moved; suite 1064 → **1073/18/0** (8,919 expects, 75 files); lint 0 · tsc 0; LIVE EN/AR verified per-view incl. RTL wallboard + calendar weekdays, zero console/MISSING_MESSAGE, no h-overflow; dictionary 1,484 = 1,484 leaves |
| OWNER-CI-001 / OWNER-GOV-001 | external, config ready |
| LAB R50-T090..T092 + CERT-HW-001-A | external, Step 0 ready (`demo:fleet`) |

---

## R69 path-correction appendix (senior independent re-review, 2026-09-19)

The full re-review re-verified every item above against the actual tree (HEAD `91d3f97`). All substantive claims HELD (each item is implemented, pinned, and live-proven); four authorable findings were remediated in the same round (R69-F1 diff-route RBAC P1, R69-F2 meta/users email fallback P3, R69-F3 gov-verify ruleset-plane blind spots P3, R69-F4 ci.yml header wording). The plan prose above predates the R47–R55 layout moves, so its illustrative `Files:` paths drifted — the TRUE implementation paths, verified this round:

| Item | Plan prose said | Actual (verified) |
|---|---|---|
| HC-1 rate gate | `src/lib/security/rate-gate.ts` | `src/lib/api/rate-gate.ts` (registry `resolveNamedRouteBudget`; store `src/lib/api/rate-store.ts`) |
| HC-1 proxy wiring | `src/middleware.ts` | `src/proxy.ts` (Next.js 16 convention — `proxy.ts` IS the middleware) |
| HC-3 envelope lib | `src/lib/api.ts` | `src/app/api/v1/_lib/api.ts` |
| HC-4 view sweep | `src/views/*-view.tsx` | `src/components/views/*-view.tsx` |
| HC-4 parity numbers | "1285 = 1285" | `1419 = 1419` leaf keys since R56 (pre-R56 figure was correct then) |
| HC-4 sweep semantics | "small documented allowlist" | two views pinned at zero (`devices-view` + `device-detail-view`, LIVE chip survivor) + a 32-view shrinking-ceiling debt ledger (`PENDING_VIEWS`, 823 candidates at R56 baseline) that only prevents growth |

Historical plan prose is intentionally left untouched (snapshot discipline — corrections live here and in the R69 evidence doc).
