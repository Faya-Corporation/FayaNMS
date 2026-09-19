# FayaNMS — R70: Merge to `main` Executed + First Real CI Gate Execution + DB-Bootstrap Remediation

- **Date:** 2026-09-19
- **Author:** Senior independent full-stack engineer (Z.ai session, `web-77040f61`)
- **Trigger:** explicit operator instruction — *"keep going and merge all to main"*
- **Repo state at round start:** `z_ai_v2` @ `6538d46` (R69), synced 0/0; `origin/main` @ `27e0eea` (0 commits ahead); merge-base = `27e0eea` ⇒ fast-forward possible with zero divergence risk.

---

## 1. Pre-merge verification (all re-executed fresh this round)

| Gate | Result |
| --- | --- |
| Test suite (`bun test tests/`, 3-knob env contract) | **997 pass / 18 skip / 0 fail** — 8,354 expects, 64 files, 4.96 s |
| `bun run lint` | exit 0 |
| `bunx tsc --noEmit` | exit 0 |
| LIVE `GET /` | 200 |
| LIVE `GET /api/v1/meta` | 200 |
| LIVE worker `GET /health` (:3030) | 200 |
| LIVE unauth `GET /api/v1/devices` | **401 fail-closed** |
| LIVE unauth `GET /api/v1/devices/1/snapshots/diff` | **401 fail-closed** (R69-F1 fix confirmed live) |

Gate env contract staged at `/tmp/fayanms-ci-gate.env` (3-knob + fail-closed service keys per R64).

## 2. Merge execution — `z_ai_v2` → `main`

- Local `main` created at `origin/main` (`27e0eea`); `git merge --ff-only z_ai_v2`.
- Result: **fast-forward `27e0eea..6538d46`** — 213 files changed, **+16,377 / −1,990**, **39 commits**.
- Push: exit 0 (`To https://github.com/fayafatehi/FayaNMS.git · 27e0eea..6538d46 main -> main`).
- Post-merge read-back: `main` == `z_ai_v2` == `origin/main` == `origin/z_ai_v2` == `6538d46` (all four refs identical, 0/0 sync everywhere).
- **Linear history preserved** — pure fast-forward, no merge commit, no squash. Every one of the 39 commits (R2 era → R69) remains individually addressable, as required by the linear-history invariant `gov-verify.ts` asserts.
- Provenance note: the previously prepared PR route (`docs/audits/FayaNMS-Candidate-PR-Package-z_ai_v2-to-main-2026-09-19.md`) was superseded by this **direct operator-authorized merge**; an addendum has been appended to that document (it is retained as the record of the rehearsed PR path, merge-tree exit 0 / tree `92222d2`).

## 3. Post-merge probes on `main`

1. **HC-6 dispatch probe #4** → `POST /actions/workflows/ci.yml/dispatches {ref: main}` → **204 accepted**; run **`35414649589`** created, bound `head_branch: main`, `head_sha: 6538d46…`. The workflow_dispatch trigger is now proven **four times across four SHAs** (`13a8fcf` ×2, `91d3f97`, `6538d46`) and for the first time **on the default branch**.
2. **`bun scripts/gov-verify.ts main`** (token via `GOV_VERIFY_TOKEN`, never argv/printed) → **exit 2, `GOV-PLAN-BLOCKER`** — exact typed classification: *"this repo is PRIVATE on a GitHub Free plan — branch protection / rulesets are plan-gated … No token scope change can lift this."* Honest status: **`main` is merged but NOT yet governance-verified**; GOV-001 remains blocked on the plan upgrade (step 0 of the runbook), unchanged by the merge.

## 4. CI bring-up — the FIRST real gate execution in the infra-blocked era

Runs #34/#89 and the two earlier R65/R68 dispatches all died with **0 executed steps** (runner-capacity signature). Run `35414649589` is different — **the gate job executed for real**, ~1m57s:

| Step | Conclusion |
| --- | --- |
| Set up job / Initialize containers (PG 16 service) / checkout / setup-bun | ✅ |
| Install dependencies / Install worker dependencies (frozen) | ✅ |
| **Lint** | ✅ |
| **Typecheck (tsc — src/ + worker zero-error policy)** | ✅ |
| **Tests (role matrix, authorization contract, service auth, crypto, audit chain)** | ❌ |
| Everything downstream (certify, brand, schema, drift guard, seed, i18n, build) | skipped (step-failure semantics) |

`e2e` / `browser` / `scan` jobs: skipped (depend on `gate`).

### Root cause (from the real runner log)

```
The table `public.User` does not exist in the current database.
(fail) AUTH-001-A — route pre-check on POST /api/auth/callback/credentials > …
```

The gate's **Tests step ran before the committed migration history was replayed onto the fresh CI service container**. The old ordering (`prisma migrate deploy` placed *after* `bun test`) had only ever been exercised against the sandbox's long-lived, already-migrated database — and the infra-blocked CI era (CI-001) meant no real runner ever reached this step to expose the gap. Classic latent ordering defect: every local "hermetic" gate re-execution (R61/R64/R67/R69) re-used the pre-migrated DB at `localhost:5433`, so the bootstrap hole was invisible to all of them.

### Remediation (this round, `ci.yml`)

1. **`Migration history applies to a fresh PostgreSQL (service container)` moved ABOVE `Tests`** — `bunx prisma migrate deploy` replays the committed history alone (the T7 provisioning path) and is idempotent. The step's name remains truthful: at its new position the service DB is still untouched by anything else.
2. The **duplicate post-Tests `migrate deploy` step retired**, replaced by a pointer comment; fresh-database provisioning proof now lives in the e2e/browser harness (creates/migrates its own `fayanms_e2e` database) and in the drift guard (`migrate diff --exit-code` against `fayanms_shadow`).
3. Stale governance-status comments corrected to current truth: the header's *"infrastructure-blocked — no runner assigned"* (CI-001) and the browser job's identical claim are replaced by the R70 status (runner block lifted 2026-09-19; bring-up tracked per run). Pins elsewhere (r66/r69) on the four-check header marker and job shape are untouched.
4. Exactly **one** `bunx prisma migrate deploy` occurrence remains in the workflow (drift with the shadow-DB flow impossible).

### Local proof on a byte-fresh database (CI replica, this round)

```
CREATE DATABASE fayanms_gatecheck  (drop-if-exists first)
DATABASE_URL=…fayanms_gatecheck bunx prisma migrate deploy   → all migrations applied
DATABASE_URL=…fayanms_gatecheck bun test tests/              → 997 pass / 18 skip / 0 fail (8,353 expects)
```

This reproduces CI's exact "fresh container + migrate deploy, no seed" state and proves the bootstrap is sufficient — **no seed dependency** exists in the suite. (`fayanms_gatecheck` is a throwaway local database; it is not referenced by any committed code.)

## 5. Honest residual risk register

| # | Risk | Status |
| --- | --- | --- |
| 1 | `e2e`, `browser`, `scan` jobs have **never really executed** (always skipped behind gate). First real execution happens after this fix lands; further bring-up findings are expected and will be remediated per run (dispatch-driven iteration, same protocol). | **Open, expected** |
| 2 | Runner capacity is **intermittent**: three same-day dispatches (`35406875963`, `35408254887`, `35411315267`) died 0-step; `35414649589` executed fully. Re-dispatch remains the recovery path. | Open, infra |
| 3 | GOV-001 (ruleset with the four required checks on `main`) stays blocked on the GitHub plan upgrade — `GOV-PLAN-BLOCKER(2)` re-confirmed on merged `main` this round. | Open, owner |
| 4 | The gate's Tests step now mutates the service DB before the seed smoke step (as it always did locally); seed is idempotent and refuses production NODE_ENV — unchanged behavior, documented here for the record. | Accepted |
| 5 | Direct-to-main pushes currently rely on operator discipline; formal enforcement (PRs required + four required checks) is GOV-001, plan-gated. | Open, owner |

## 6. Evidence index

- Merge: `git log` ff range `27e0eea..6538d46`; post-merge `rev-list --left-right --count` 0/0 on both branches; push log line quoted in §2.
- Dispatch #4: run **`35414649589`** (jobs API read-back; gate job id `105820761040`; step table §4).
- Root-cause excerpt: real runner log line *"The table `public.User` does not exist in the current database."* quoted §4.
- Replica proof: §4 code block (997/18/0 on `fayanms_gatecheck`).
- gov-verify main: typed exit **2 / `GOV-PLAN-BLOCKER`**, verbatim message quoted §3.
- Pre-merge gates + LIVE: §1 table.
- Pin suite: `tests/audit/r70-merge-to-main-and-ci-bootstrap.test.ts` (A–H) — asserts the migrate-before-tests ordering, single `migrate deploy` occurrence, four-job shape, merge/run/plan-blocker record strings, PAT hygiene.
- Ledger rows: roadmap R70; NEXT-TASKS (OWNER-CI-002 CI bring-up; OWNER-GOV-001 unchanged); hand-off §merge; dual worklogs R70.
