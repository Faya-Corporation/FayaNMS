# FayaNMS — Operator Hand-off & Release Notes — branch `z_ai_v2` (2026-09-18)

Audience: the repository owner/operator taking `z_ai_v2` to production.
Single source of truth for: what this branch contains, what is proven, what is
honestly NOT proven, and the exact remaining steps to go-live.

---

## 1. TL;DR

- `z_ai_v2` is **28 commits ahead of `origin/main`** (179 files, **+12,513 / −1,875**),
  ends at `9274be7`, and is pushed + in sync with origin.
- The in-repo verification battery is green at HEAD: **lint 0 · tsc FULL 0 ·
  suite 943 pass / 18 skip / 0 fail** (7,998 expects, 56 files — +49 audit pins
  over the program).
- The independent production re-audit verdict is **PASS with zero open
  P1/P2/P3-authorable findings**.
- The authorable backlog is **EMPTY**. Go-live is blocked only by three
  **operator-side actions** (§4): enable CI runners → execute HC-6; enable `main`
  protection; certify real devices. Then one final fresh independent re-audit.

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

---

## 3. Verification status — proven where, honestly

**Proven in this sandbox (live app + CI-shaped env):** full lint/type/test
battery; envelope + rate-limit + auth-ordering wire contracts; meta split
contracts; EN/AR-RTL browser journeys; assign-to-picker e2e; mobile-390 layout;
YAML config hygiene. Every claim has an evidence document (§5).

**NOT provable here — activates operator-side:**
- **Remote CI run:** `ci.yml` (4 jobs: gate incl. `build:gate`, e2e, browser,
  scan) is complete and SHA-pinned but has had **no runner capacity since run
  #34** — a green remote run is exactly HC-6's acceptance.
- **`build:gate` (production build):** needs ≥8 GB RAM; sandbox has ~2 Gi — the
  OOM caveat stands and is closed only by HC-6 on real runners.
- **Dependabot:** config merged + machine-pinned; PRs appear once GitHub can run
  the scheduled update jobs (same runner prerequisite).
- **Real-device certification:** needs operator hardware/credentials (§4 step 3).

---

## 4. Operator runbook — the remaining path to go-live

**Step 1 — OWNER-CI-001: restore runner capacity, then execute HC-6.**
Enable hosted runners for `fayafatehi/FayaNMS` (billing/minutes) — or attach a
self-hosted runner with **≥8 GB RAM** (for `build:gate`). Then, per the roadmap
HC-6 section: push a no-op docs commit → verify ALL FOUR jobs green on that run
(gate incl. `build:gate`, e2e, browser incl. the D/B journeys, scan incl.
dual-lockfile osv + image SBOM) → record the run URL in NEXT-TASKS → flip the
README CI badge from the runner-blocked honesty note to live status.

**Step 2 — OWNER-GOV-001: protect `main` (exact config from TASK-GOV-001-A).**
Settings → Rules → Rulesets on `main`: PR required, ≥1 approval + CODEOWNERS
review for the governed paths, conversation resolution, required checks
(`gate`, `scan` — and `e2e`, `browser` once runners exist), no force-push, no
deletion, scoped admin-bypass decision recorded; verify via API read-back
(`protected:true` + required checks). Recommended: mirror the ruleset onto
`z_ai_v2` while it remains the integration branch.

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
