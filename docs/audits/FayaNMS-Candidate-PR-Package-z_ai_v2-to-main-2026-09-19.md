# FayaNMS — Candidate PR Package: `z_ai_v2` → `main` (2026-09-19)

**Purpose:** the operator opens ONE pull request and pastes ONE body. This document is that
paste-ready package plus the merge-time decision tree. Prepared in R67; numbers verified at
`d6c61da` (merge pre-flight: `git merge-tree --write-tree origin/main z_ai_v2` → **exit 0, zero
conflicts** — the merge lands CLEAN).

---

## 1. The PR, ready to paste

**Base:** `main`  **Compare:** `z_ai_v2`  **Title:**

```text
Merge z_ai_v2 → main: hardened production readiness (R34–R66), 35 commits, 198 files
```

**Body:**

````markdown
## What this merges

35 commits of the single-session remediation + hardening program (R34–R47 phases A–J, R50–R52
branch program, R53–R66 Phase-HC + re-verification program): **198 files changed, +14,738 / −1,973**
vs `main` @ `27e0eea`. Merge pre-flight: `git merge-tree --write-tree` exit 0 — zero conflicts.

## Thematic changelog

- **Authorization & service identity** — role matrix + permission sync, service-JWT surface
  isolation at the proxy (machine paths only, pre-rate-gate 401), sensitive read RBAC
  (credentials GET admin-gated; snapshot decrypted texts config.download-gated).
- **First-contact SSH safety** — credential-free host-key capture (zero vault access, zero auth
  attempts, protocol-proven via persona auth-attempt counter); deferred two-stage enrollment.
- **Canonicalization-safe target policy** — group-math IPv6 classification in app + worker
  (expanded/hex/dotted/v4-mapped forms classify identically; unparsable literals fail CLOSED).
- **Phase HC (HC-1..HC-5)** — per-endpoint rate budgets, meta bootstrap split, RequestContext
  removal, full EN/AR i18n chrome parity with machine parity pins, Dependabot config (dual bun
  manifests, security-grouped).
- **Supply chain** — CI images digest-pinned (postgres:16-alpine ×3 + oven/bun:1.3.14), Actions
  actions SHA-pinned, dual-lockfile osv scan, gitleaks history scan.
- **Governance** — ci.yml triggers push-main/PR/workflow_dispatch; required-checks shape unified
  to ALL FOUR jobs (`gate`,`e2e`,`browser`,`scan`) across every operation doc; CODEOWNERS header
  aligned; executable ruleset read-back (`scripts/gov-verify.ts`).
- **E2E & a11y** — 12 HTTP + browser journeys, axe-core wcag2a/aa zero critical/serious, RTL
  sweeps, keyboard-only sweeps.
- **Audit trail** — 66 rounds of evidence docs + 978-pin executable suite; every commit's CI
  state recorded honestly.

## Verification status

- Local gates (CI env shape, 3-knob contract): lint 0 · tsc 0 · suite **978 pass / 18 skip /
  0 fail** (8,260 expects, 62 files).
- LIVE: app/meta 200 · worker /health 200 · unauth worker probe 401 fail-closed.
- Remote CI: the four jobs will execute ON THIS PR (pull_request trigger) the moment runner
  capacity exists — see merge-time decision tree below.
- Honest gaps (unchanged): `build:gate` memory profile unproven in sandbox (≥8 GB needed),
  real-device certification (LAB), live-restore certified-refused.

## Operator checklist attached to this PR

1. HC-6 evidence: green 4-job run (PR checks or dispatch) + run URL recorded.
2. Ruleset: `main` protected with ALL FOUR required checks — verify with
   `bun scripts/gov-verify.ts main` → GOV-VERIFIED(0) before flipping any doc claim.
3. Mirror the ruleset onto `z_ai_v2` while it remains the integration branch.
4. Final pre-go-live gate: fresh INDEPENDENT re-audit on the post-merge release SHA.
````

---

## 2. Merge-time decision tree (the two HC-6 vehicles)

Runner capacity is the single external blocker. Both execution paths are already proven
triggerable; the PR path is preferred because the checks attach to the PR itself and become the
required-check record:

```text
IF runner capacity exists (hosted minutes or self-hosted):
  OPTION A (preferred): open this PR → the pull_request event runs ALL FOUR jobs on the merge
                        ref → HC-6 evidence = the PR's own green checks (gate, e2e, browser,
                        scan) — no separate dispatch needed.
  OPTION B:             Actions → CI gate → Run workflow (workflow_dispatch on z_ai_v2) →
                        green run URL → then open this PR (its checks re-run and must also be
                        green).

THEN, in order (hand-off runbook R63-corrected, R67-amended):
  0. PLAN CHECK (R67 LIVE DISCOVERY): this repo is PRIVATE on GitHub Free — branch protection /
     rulesets are PLAN-GATED (the API answers 403 "Upgrade to GitHub Pro or make this repository
     public to enable this feature", observed live 2026-09-19 via scripts/gov-verify.ts). OWNER
     action BEFORE any ruleset work: upgrade the account (Pro for a personal owner; Team+ for an
     org) or decide to make the repo public. No token scope change can lift this.
  1. bun scripts/gov-verify.ts main        # pre-read: expect GOV-NOT-VERIFIED(1) — main is open
                                           # (or GOV-PLAN-BLOCKER(2) until step 0 is done)
  2. Configure the ruleset (TASK-GOV-001-A): PR required, ≥1 approval + CODEOWNERS, conversation
     resolution, required checks = ALL FOUR (gate, e2e, browser, scan), no force-push/deletion,
     scoped admin-bypass decision recorded.
  3. bun scripts/gov-verify.ts main        # post-read: MUST be GOV-VERIFIED(0) before any doc
                                           # flips to "active" (truth-first)
  4. Merge this PR (squash OFF — keep the 35-commit history linear; required checks satisfied
     by the PR's own runs).
  5. bun scripts/gov-verify.ts z_ai_v2     # mirror ruleset verification on the integration branch
  6. Fresh INDEPENDENT re-audit on the post-merge release SHA (the final go-live gate).
ELSE (capacity still absent — the state at R66/R67):
  runs #34 / #89 / 35406875963 / 35408254887 all failed with 0 steps (no runner assigned);
  verify Actions minutes/billing, or attach a self-hosted runner (≥8 GB RAM for build:gate).
  No code or workflow change is needed — every trigger path is ready.
  NOTE (R67): even with capacity restored, GOV-001 additionally needs the PLAN upgrade (step 0)
  — two independent operator prerequisites now, both settings/billing-side, zero code changes.
```

## 3. Review-load note (CODEOWNERS)

The merge diff touches governed paths (`.github/`, `docs/audits/`, `prisma/`, worker API, auth
libs) → once the ruleset is active, CODEOWNERS review from `@fayafatehi` is REQUIRED for this PR.
Configure approval BEFORE merging (step 2 above), or merge first and rely on post-hoc rulesets —
the runbook order is configure-then-merge (step 2 → 4).

## 4. Evidence index (what the reviewer reads first)

- Hand-off release notes (single entry point): `docs/audits/FayaNMS-Operator-Handoff-Release-Notes-2026-09-18.md`
- Program ledger: `docs/audits/FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md`
- Re-verification episode + remediations: R61–R64 evidence docs; R65/R66 operator-path proofs
- Full per-round detail: `worklog.md` (repo), R34–R66 entries
