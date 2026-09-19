# FayaNMS — R67: Executable GOV Read-Back + Candidate PR Package + Plan-Gate Discovery (2026-09-19)

**Branch:** `z_ai_v2` · **Tree at round start:** `d6c61da` (R66) — 0/0 synced · **Scope:** operator-path acceleration — GOV-001-A acceptance made executable, the candidate PR pre-written, and ONE new operator prerequisite discovered LIVE (plan gating).

---

## 1. NEW deliverable: `scripts/gov-verify.ts` — TASK-GOV-001-A's acceptance criterion made executable

Until now "verify via API read-back" was a manual checklist. It is now a typed, fail-closed CLI:

- Queries the LIVE GitHub API for BOTH protection mechanisms — classic branch protection
  (`GET /repos/{o}/{r}/branches/{branch}/protection`) AND rulesets (`GET /repos/{o}/{r}/rulesets`) —
  and every source found must satisfy the invariants.
- Invariants (the R66 canonical shape): required checks = **ALL FOUR** (`gate`, `e2e`, `browser`,
  `scan`), enforcement ACTIVE (classic `enforcement_level` ≠ off / ruleset `enforcement=active`),
  approvals ≥ 1, code-owner review required, force-push disabled, deletion disabled, conversation
  resolution enabled, linear history (advisory).
- Truth-first: prints the API-OBSERVED value for every invariant, PASS/FAIL field-by-field; exits
  **0** GOV-VERIFIED / **1** GOV-NOT-VERIFIED (invariant failures) / **2** typed config errors.
- Security posture: token from `GOV_VERIFY_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN` (env-ONLY, never
  argv, never printed, never logged); no top-level await; no target-sensitive constructs; the unit
  suite pins its SHAPE and NEVER executes it (network I/O stays out of tests).

**LIVE-VERIFIED fail-closed (one-off, real API, token via env, never persisted):**

```text
$ GOV_VERIFY_TOKEN=… bun scripts/gov-verify.ts main
GOV-PLAN-BLOCKER(2): this repo is PRIVATE on a GitHub Free plan — branch protection / rulesets
are plan-gated. OWNER action BEFORE GOV-001: upgrade the account (Pro for a personal owner;
Team+ for an org) or make the repo public. No token scope change can lift this.
(script exit code: 2)
```

## 2. NEW operator prerequisite discovered LIVE: the GitHub-Free plan gate

The one-off smoke run against the real repo returned **HTTP 403** from the protection endpoint:

> `"Upgrade to GitHub Pro or make this repository public to enable this feature."`

This is GitHub's **plan-gating** message (distinct from a token-scope error) — the private repo
runs under GitHub Free, where branch protection/rulesets are a paid feature. **No earlier doc
recorded this; TASK-GOV-001-A was silently un-executable on the current plan.** The corrected
operator path gains a step 0: plan upgrade (or a deliberate repo-publicization decision) BEFORE
any ruleset work. Recorded in: hand-off Step 2, candidate PR package decision tree (step 0 +
ELSE-branch note), NEXT-TASKS OWNER-GOV-001. Two independent operator prerequisites now exist
(runner capacity AND plan level) — both settings/billing-side, zero code changes.

## 3. CODEOWNERS header drift fixed (same spirit as R66)

The header still required 'the "CI gate" required status check' (pre-R47 singular). Now: ALL FOUR
required status checks, ruleset-path wording (Settings → Rules → Rulesets), and the executable
read-back pointer (`bun scripts/gov-verify.ts`, GOV-VERIFIED(0) as the only basis for doc flips).
The ownership rules themselves are untouched (all governed paths → `@fayafatehi`).

## 4. NEW deliverable: candidate PR package (`docs/audits/FayaNMS-Candidate-PR-Package-…md`)

Paste-ready title + body for the single protective PR `z_ai_v2` → `main` (35 commits, 198 files,
+14,738/−1,973; merge pre-flight exit 0 recorded). Key recorded fact: **opening the PR itself
fires the `pull_request` event, which runs ALL FOUR jobs on the merge ref — the PR is an HC-6
vehicle, not merely a merge vehicle** (preferred over dispatch because the checks attach to the
PR and become the required-check record). Includes the merge-time decision tree (R67-amended:
plan check as step 0), the CODEOWNERS review-load note, and the evidence index.

## 5. Pin: `tests/audit/r67-gov-readback-and-pr-package.test.ts` (8 pins A–H)

A — script exists and pins the FOUR-check constant; B — both protection mechanisms read +
enforcement asserted; C — token env-only / never printed / typed exit contract (0/1/2) / auth
built from the env-read variable; D — execution hygiene (no top-level await, no Set-spread, suite
never executes it); E — CODEOWNERS four-check header + stale singular wording gone + ownership
rules intact; F — PR package paste-ready (title, four-check shape, PR-runs-CI fact, pre/post
read-back discipline, merge pre-flight exit 0, capacity fallback); G — **PAT hygiene** (no token
material in any new artifact; caught the script's own `github_pat_...` usage example and forced a
token-agnostic wording); H — the plan-blocker is a typed, fail-closed contract on the shared fetch
path.

## 6. Gates + LIVE (this tree)

- lint **0** · tsc **0** (repo tsconfig covers `scripts/`).
- Suite **978 → 986 pass / 18 skip / 0 fail** (8,306 expects, 63 files; +8 pins).
- LIVE: app `GET /api/v1/meta` → **200**; worker `:3030` `/health` → **200**; unauthenticated
  `POST /simulate/connect` → **401** fail-closed.

## 7. State after R67

- Authorable backlog: **empty** (the plan-gate is settings/billing-side; nothing more to author).
- Operator prerequisites, complete and honest: ① runner capacity (HC-6 vehicle proven twice) ②
  **GitHub plan upgrade for branch protection (NEW)** ③ LAB hardware/demo-fleet certification.
- Order: capacity → open the candidate PR (paste-ready) → four green checks → plan-upgraded
  ruleset on `main` verified by `gov-verify.ts` GOV-VERIFIED(0) → merge → mirror ruleset onto
  `z_ai_v2` (same tool) → independent final audit on the release SHA.
