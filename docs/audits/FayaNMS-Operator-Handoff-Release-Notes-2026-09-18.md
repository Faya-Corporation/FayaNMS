# FayaNMS — Operator Hand-off & Release Notes — branch `z_ai_v2` (2026-09-18)

Audience: the repository owner/operator taking `z_ai_v2` to production.
Single source of truth for: what this branch contains, what is proven, what is
honestly NOT proven, and the exact remaining steps to go-live.

---

## 1. TL;DR

- `z_ai_v2` ends at the commit recorded in the repository ledger (in sync with
  origin). Commit/file deltas vs `origin/main` are re-quantified per round in
  the roadmap ledger and NEXT-TASKS — treat the LEDGER as the live numbers,
  not this snapshot.
- The in-repo verification battery is green at HEAD: **lint 0 · tsc FULL 0 ·
  suite 997 pass / 18 skip / 0 fail** (8,354 expects, 64 files — the R61–R69
  remediation + operator-path + re-review rounds all included; gates
  independently re-executed per the standing standard in R64/R65 and re-run
  post-remediation in R69).
- The independent production re-audit verdict is **PASS with zero open
  P1/P2/P3 findings**. (An independent re-verification of this hand-off's
  earlier snapshot on 2026-09-19 found **2 P0 + 2 P1 authorable findings** —
  credential-bearing SSH first contact, textual IPv6 classification, service-
  JWT proxy bypass, unguarded sensitive reads. ALL FOUR are remediated and
  machine-pinned in R61/R62 on this branch; the reviewer's CI/trigger and
  Dependabot-activation points are folded into the runbook below.)
- **R69 full roadmap re-review (2026-09-19):** every roadmap item re-verified
  at CODE level by a senior independent pass — all substantive claims HELD;
  four findings remediated same-round (R69-F1 **P1**: the snapshots/diff
  route returned decrypted config text with no permission gate → now
  config.download-gated + denial-audited, viewer/auditor fail-closed by
  design; R69-F2 meta/users email-fallback; R69-F3 gov-verify ruleset-plane
  blind spots; R69-F4 ci.yml header wording). Evidence:
  `docs/audits/FayaNMS-R69-Full-Roadmap-ReReview-2026-09-19.md`.
- The authorable backlog is **EMPTY**. Go-live is blocked only by FOUR
  **operator-side actions** (§4): enable CI runners → execute HC-6; **upgrade
  the GitHub plan — R67 LIVE discovery: Free-plan private repos cannot enable
  branch protection at all**; enable `main` protection; certify real devices.
  Then one final fresh independent re-audit.

---

## 2. What landed since `main` — by theme

**Security & device-plane hardening (R50 program):** host-key trust lookup fails
CLOSED (P0 fix); vendor-FIRST orchestration + trust-identity ADR; dedicated probe
permission + target policy + detection budgets; IPv4-only management-address
policy with typed IPv6 refusals; vendor fingerprint registry with bounded
evidence + deterministic match reasons; versioned typed detection API contract;
explicit two-stage detection UI (Use/Keep-mine semantics, first-contact host-key
panel); structured non-secret audit + telemetry; executable backup/DR drill + D1
runbook.

**Reference deployment & supply chain:** HTTPS-by-default `compose.tls.yml`
profile (single trusted proxy hop, `__Secure-*` cookies, container hardening —
cap_drop ALL, no-new-privileges, read-only roots); every base image
**digest-pinned** from real registry resolutions; CI builds both runtime images
and scans them AS IMAGES (trivy HIGH/CRITICAL fail) with per-image CycloneDX
SBOMs; **NEW: `.github/dependabot.yml`** covering both bun manifests (weekly,
grouped security updates, exact-pin preservation — dormant until runners exist).

**Independent audits & verifications:** R51 re-audit (F-1 dial-plane target
policy, F-2 meta username disclosure) → verified; R52 full end-to-end re-audit
→ **PASS**, F-N1 auth-ordering + hygiene set remediated; R52 independently
verified; R58 program sweep re-verified everything at the release SHA.

**Phase HC (production-readiness roadmap — the authorable tail):**

| Item | Commit | One-line outcome |
|---|---|---|
| HC-1 per-endpoint rate budgets (R53) | `329f0f8` | ai/* 10/min, csv-import 5/min named budgets behind the SAFE-002 pre-handler gate; live 429 on the 11th call |
| HC-2 authenticated bootstrap split (R54) | `49d33f3` | `/api/v1/meta` sheds the user directory (zero user records pre-auth); actor-gated `/api/v1/meta/users` |
| HC-3 RequestContext removal (R55) | `64dca8f` | deprecated per-call context retired from all four envelope builders, ~100 call sites mechanically removed; envelope invariance wire-proven |
| HC-4 i18n chrome completion (R56) | `955aad4` | devices/device-detail fully keyed (en/ar 1419=1419, genuine Arabic ICU plurals); FIRST parity pin; 32-view shrinking debt ledger |
| HC-5 dependabot config (R57) | `5d71466` | supply-chain automation for BOTH manifests, machine-pinned hygiene |
| Phase HC completion report (R58) | `9274be7` | full sweep re-verified at the release SHA; go-live checklist item 1 MET |
| Operator hand-off release notes (R59) | `09863a4` | this document (numbers refreshed R63) |
| R52 INFO polish zeroed (R60) | `38c93f1` | ci.yml postgres digest-pinned ×3; gitignore path; README Bun floor 1.3.14 — INFO list EMPTY |
| **P0 remediations (R61)** | `5ba5080` | credential-free SSH first contact (zero vault, zero auth — proven against a real SSH persona via a server-side auth-attempt counter) + canonicalization-safe IPv6 in BOTH target-policy copies |
| **P1 remediations (R62)** | `75b0479` | service-JWT surface isolation at the proxy (machine surface only; human paths → hard 401) + sensitive read RBAC (credentials GET admin-gated; snapshot texts config.download-gated, decrypt only on the privileged path) |
| R63 CI trigger + hand-off corrections | `b6bf443` | `workflow_dispatch` added (the old no-op-push HC-6 step could never fire); this document refreshed; two Dependabot activation caveats recorded |
| R64 gate re-execution + hermeticity | `7cb6be4` | R61–R63 gates re-executed from a cold shell (exact reproduction); unit-gate hermeticity defect found + fixed (dev `.env` leak via bun auto-load + file fallback; 3-knob gate env contract) |
| R65 dispatch path executed | `0d28a34` | `workflow_dispatch` EXECUTED end-to-end for the first time (run `35406875963` → gate 0-steps infra failure — trigger proven, capacity still the blocker); resume-summary drift caught again |
| R66 required-checks shape + merge pre-flight | `d6c61da` | governance defect fixed (7 operation docs carried 2/3-check required-checks sets → ALL FOUR; under-protection would let e2e/browser failures merge); `merge-tree --write-tree` exit 0 — the protective merge is CLEAN |
| R67 executable GOV read-back + PLAN GATE | `13a8fcf` | `scripts/gov-verify.ts` (live dual-mechanism read-back, typed exits); **LIVE discovery: GitHub Free plan-gates branch protection (403 "Upgrade to GitHub Pro…")** — runbook step 0 added; CODEOWNERS header aligned; paste-ready candidate PR package authored |
| R68 browser re-execution + hand-off refresh | `91d3f97` | HC-6 probe #3 (run `35411315267` @ `13a8fcf` — trigger TRIPLE-proven); golden-path browser journey re-executed live (EN → AR/RTL → sign-out, ZERO console/page errors); honest harness-precondition finding recorded; README badge alt fixed |
| **R69 full roadmap re-review + remediations** | this commit | EVERY roadmap item re-verified at code level (3 parallel deep-read passes) — claims HELD; **R69-F1 (P1) snapshots/diff RBAC gap closed** (config.download gate + CONFIG_DIFF_DENIED audit; viewer/auditor fail-closed) + meta/users email fallback + gov-verify ruleset-plane hardening (four protective rule types) + ci.yml header wording; suite 986 → 997 |

---

## 3. Verification status — proven where, honestly

**Proven in this sandbox (live app + CI-shaped env):** full lint/type/test
battery; envelope + rate-limit + auth-ordering wire contracts; meta split
contracts; EN/AR-RTL browser journeys; assign-to-picker e2e; mobile-390 layout;
YAML config hygiene. Every claim has an evidence document (§5). R68: the
golden-path browser journey (sign-in → shell → devices EN/AR-RTL → sign-out
gate, zero console/page errors) was RE-EXECUTED live against the running app.
R69: unauth meta 200 / worker /health 200 / unauth worker 401 fail-closed;
unauth snapshots/diff 401 at the proxy AND 401-before-404 at the handler
(wire pin); HC-1 named budgets re-demoed on the wire (401×10 → 429 ai/query,
401×5 → 429 csv-import). BEHAVIOR CHANGE (R69-F1, intentional): viewer and
auditor sessions now receive 403 on the snapshot-diff dialogs — the response
is decrypted configuration text and the boundary is the server, matching how
the raw download route already treats them.
NOTE (R68): the full e2e/browser HARNESS suite additionally requires (a) the
`.next/standalone` production-build artifact — absent in the current tree; a
rebuild trips the ≥8 GB OOM caveat below — and (b) free ports (the harness
worker collides with the session worker's :3030 — EADDRINUSE). Both
preconditions are operator-side/LAB-side; the agent-browser live journey is
the in-sandbox equivalent and stays green.

**NOT provable here — activates operator-side:**
- **Remote CI run:** `ci.yml` (4 jobs: gate incl. `build:gate`, e2e, browser,
  scan) is complete and SHA-pinned but has had **no runner capacity since run
  #34** — a green remote run is exactly HC-6's acceptance. NOTE (R63, per the
  2026-09-19 re-verification): the workflow triggers on **push-to-main,
  pull_request, and `workflow_dispatch`** — a push to `z_ai_v2` alone runs
  NOTHING. HC-6 is executed via the manual dispatch run or the candidate PR.
  R65–R68: the dispatch path was EXECUTED three times (runs `35406875963` @
  `7cb6be4`, `35408254887` @ `0d28a34`, `35411315267` @ `13a8fcf`) — each
  accepted (204), correctly bound, then gate-failed with **0 steps** (the
  known infra signature): trigger PROVEN, capacity still absent.
- **`build:gate` (production build):** needs ≥8 GB RAM; sandbox has ~2 Gi — the
  OOM caveat stands and is closed only by HC-6 on real runners. Standard
  hosted `ubuntu-latest` documents 8 GB exactly — a self-hosted runner gives
  safer headroom if the build sits close to that limit.
- **Dependabot:** config merged + machine-pinned. TWO activation caveats
  (R63, per the re-verification): (a) the config sits on `z_ai_v2`, NOT the
  default branch — GitHub activates version updates from the config on the
  DEFAULT branch, so it activates at/after the merge, not at this push;
  (b) Dependabot update jobs are GitHub-generated Actions jobs — they need
  Actions capacity too and should be checked separately from the ci.yml
  runner situation.
- **Real-device certification:** needs operator hardware/credentials (§4 step 3).

---

## 4. Operator runbook — the remaining path to go-live

**Step 1 — OWNER-CI-001: restore runner capacity, then execute HC-6.**
Enable hosted runners for `fayafatehi/FayaNMS` (billing/minutes) — or attach a
self-hosted runner with **≥8 GB RAM** (for `build:gate`). Then, per the roadmap
HC-6 section (CORRECTED ordering — the workflow does NOT trigger on pushes to
`z_ai_v2`): trigger the full 4-job battery via **`workflow_dispatch`** (Actions
tab, added R63) or by **opening the `z_ai_v2` → `main` PR** (pull_request
triggers all four jobs) → verify ALL FOUR jobs green (gate incl. `build:gate`,
e2e, browser incl. the D/B journeys, scan incl. dual-lockfile osv + image SBOM)
→ record the run URL in NEXT-TASKS → flip the README CI badge from the
runner-blocked honesty note to live status.

**Step 2 — OWNER-GOV-001: protect `main` (exact config from TASK-GOV-001-A).**
R67 PLAN PREREQUISITE (discovered live via `scripts/gov-verify.ts`): the private repo is on
GitHub Free — branch protection/rulesets are plan-gated (API 403: "Upgrade to GitHub Pro or
make this repository public to enable this feature"). Upgrade the account or make the repo
public BEFORE configuring anything below; no token scope can lift it.
Settings → Rules → Rulesets on `main`: PR required, ≥1 approval + CODEOWNERS
review for the governed paths, conversation resolution, required checks
(`gate`, `e2e`, `browser`, `scan` — all FOUR jobs; R66 correction: configure
all four NOW, not "e2e/browser once runners exist" — the jobs already exist
and configuring only gate+scan would let e2e/browser failures merge), no
force-push, no deletion, scoped admin-bypass decision recorded; verify via
`bun scripts/gov-verify.ts main` (R67) — GOV-VERIFIED(0) is the ONLY basis
for flipping any doc claim to "active" (truth-first). Recommended: mirror
the ruleset onto `z_ai_v2` while it remains the integration branch.

**Step 3 — LAB certification (R50-T090..T092 + TASK-CERT-HW-001-A).**
Start with **Step 0, no hardware needed**: `docs/certification/PUBLIC-DEMO-DEVICES.md`
+ `bun run demo:fleet` (public demo device plane). Then run the SSH-CLI-fleet /
Sophos-WebAPI / failure-class suites against at least one representative per
vendor family; publish the per-vendor × firmware × capability matrix; document
the LIVE-restore decision (certified-refused or operator opt-in + preflight/
canary).

**Step 4 — merge + final gate.**
Open `z_ai_v2` → `main` as a PR (protection from Step 2 now enforces the
checks), merge, then execute the roadmap's final pre-go-live increment: a
**fresh independent full re-audit on the release SHA** + the go-live checklist
re-run top to bottom. That re-audit must be independent — it is deliberately
NOT claimed by this hand-off.

---

## 5. Evidence index — where every proof lives

| Area | Document |
|---|---|
| Production-readiness roadmap + status ledger | `docs/audits/FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md` |
| Execution backlog (ACTIVE = operator-side only) | `docs/audits/FayaNMS-NEXT-TASKS.md` |
| R52 full re-audit (PASS verdict) | `docs/audits/FayaNMS-z_ai_v2-Full-End-to-End-Production-ReAudit-2026-09-18.md` |
| HC-1..HC-5 + completion report | `FayaNMS-R53-HC1-Rate-Budgets` / `R54-HC2-Meta-Users-Split` / `R55-HC3-RequestContext-Removal` / `R56-HC4-I18n-Chrome` / `R57-HC5-Dependabot-Config` / `FayaNMS-Phase-HC-Completion-Report` (all `-2026-09-18.md`) |
| Supply-chain (digest pins, image scans) | `tests/audit/supply-chain.test.ts` header + README supply-chain notes |
| Deploy/TLS reference profile | `compose.tls.yml` + `docs/deploy/` + `tests/audit/deploy-hardening.test.ts` |
| Demo device plane (LAB Step 0) | `docs/certification/PUBLIC-DEMO-DEVICES.md` + `bun run demo:fleet` |
| Round-by-round worklog | `worklog.md` (repo) — R50 → R58 entries with per-round gates + LIVE matrices |

---

## 6. Known honest limitations (tracked, not hidden)

- `build:gate` OOM caveat (this sandbox) — closes with OWNER-CI-001/HC-6.
- Dependabot config dormant until runners exist (hygiene machine-pinned).
- i18n: `LIVE` chip, `—` placeholders, date-fns English relative times are
  documented survivors; 32 partially-keyed views are ledgered at R56 ceilings
  (`PENDING_VIEWS` — counts may only shrink, untracked literals are forbidden).
- Arabic copy is machine-drafted net-ops terminology — native-speaker sign-off
  folds into the LAB visit (HC-4 acceptance note).
- CI osv/gitleaks/trivy executions are workflow-complete but runner-blocked —
  same HC-6 closure.
- Docker compose render + live TLS smoke NOT VERIFIED here (no Docker in the
  sandbox) — recorded in the deploy-hardening test header.

**Verdict: the branch is production-ready to the limit of what this environment
can prove; everything beyond that limit is a named, ready-to-execute operator
step.**
