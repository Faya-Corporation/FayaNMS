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

---

## 7. R71 ADDENDUM — bring-up iteration 2: the certify step's lab-hatch env

With the DB bootstrap fixed, dispatch #5 (run **`35415388173`** @ main/`d3136c6`) executed the gate **one step deeper than any run in repo history**:

| Step (run `35415388173`) | Conclusion |
| --- | --- |
| Set up job → containers → checkout → setup-bun → both installs | ✅ |
| Lint / Typecheck | ✅ |
| **Migration history applies to a fresh PostgreSQL** (the R70 fix, new position) | ✅ |
| **Tests (the FULL 1031-test suite)** | ✅ **GREEN IN REAL CI — `1013 pass / 18 skip / 0 fail` (8,388 expects, 65 files), byte-identical to local** |
| Live SSH adapter certification | ❌ `SSH_TARGET_POLICY_REFUSED: loopback` |

### Root cause

The certification driver IS the loopback lab: it dials in-process `127.0.0.1` protocol harnesses **by design**, and the R50 target-policy honors the documented caller-provided hatch `FAYANMS_PROBE_ALLOW_SPECIAL=true`. The step never set the hatch because the driver had only ever been executed inside the sandbox shell that exported it — the same class of latent environment-coupling defect as R70's bootstrap hole, in the next never-executed step.

### Fix + proof (R71, same protocol)

- The ci.yml certify step now presents `FAYANMS_PROBE_ALLOW_SPECIAL: "true"` **plus the three R64 hermeticity knobs** (`FAYANMS_SERVICE_PRIVATE_KEY=""`, `FAYANMS_SERVICE_PUBLIC_KEYS=""`, `FAYANMS_SERVICE_ENV_FILE=""`) — the exact env of the CI replica.
- **CI-replica re-execution locally (exact step env): `CERT RESULT: PASSED` — 134 PASS checks, 5 flavors, protocol level, exit 0.** (Diagnostic note, recorded honestly: a sandbox-shell run *without* the R64 knobs shows spurious 401s on the HTTP-surface checks — the dev `.env`'s key material leaks into the in-process mint/verify round trip via the `.env` fallback; CI has no `.env` and was never affected. The knobs make the step hermetic in ANY environment.)
- Pin suite: `tests/audit/r71-certify-step-env.test.ts` (5 pins — step env, hatch, knobs, finding record, PAT hygiene).
- Expected next: dispatch #6 should carry the gate past certification into brand/schema/drift/i18n/build steps; `e2e`/`browser`/`scan` get their first real executions if the gate goes green.

---

## 8. R72 ADDENDUM — bring-up iteration 3: the FIRST GREEN GATE + downstream seed-KEK fix + gitleaks triage

Dispatch #6 (run **`35416148348`** @ main/`18c1a28`) — **the FIRST GREEN GATE JOB in repo history** (2m32s):

| Job | Result |
| --- | --- |
| **gate** | ✅ **SUCCESS — every step**: deps ×2, lint, typecheck, migration replay (R70 position), **Tests 1018/18/0**, SSH certification (R71 env), brand ×3, prisma validate, shadow DB + drift guard, demo seed smoke, i18n parity, **production build** |
| e2e | ❌ first-ever execution — harness seed failed |
| browser | ❌ first-ever execution — same seed failure |
| scan | ❌ first-ever execution — gitleaks exited 2 |

### 8.1 e2e + browser — the seed-KEK ambient dependency

The shared harness's seed subprocess inherited `process.env` for its config KEK and only the e2e job's sparse env (`DATABASE_URL` alone) preceded it → `FAYANMS_CONFIG_ENC_KEY is missing or not 64 hex chars — refusing to encrypt/decrypt configuration at rest` (the app-boot env DID have the key via `appEnv`; the seed path did not). The sandbox never caught it because Bun auto-loads the dev `.env` (which carries a valid key) into every ambient process. Replicated deterministically: explicit-empty key → **exit 1 with the exact CI error**; valid 64-hex → **`Seed complete.`** (exit 0). **Fix**: the seed env now carries the run's fresh `RUN_SECRET` (+ `FAYANMS_CONFIG_ENC_KEY_ID: "k1"`) — the same KEK the server-under-test boots with, so seeded ciphertext decrypts on the journey path. Local end-to-end harness re-execution remains blocked by the documented R68 environmental preconditions (no standalone build in this sandbox) — dispatch is the verifier of record.

### 8.2 scan — first real gitleaks run triaged into a committed allowlist

`gitleaks detect` (full 193-commit history) exited 2 with findings that are ALL committed, audit-trialed throwaway fixtures: test-fixture hex constants (`tests/**`), the audit trail quoting them (`docs/audits/`, `worklog.md`), the harness's own loopback key material (`mini-services/worker/harness/` incl. its self-signed `sfos-webapi-*.pem`), the documented CI fixture hex (`ci.yml`, `.env.example`, retired `docs/ci/ci-gate.yml`). **Fix**: committed `.gitleaks.toml` — `[extend] useDefault = true` (the full default ruleset stays active everywhere) + a seven-path allowlist with the triage rationale inline, including the machine-proven non-authority argument (the P1-019 startup policy REFUSES the fixture values at production boot). Widening requires a new triage note (pinned). **Verified with checksum-verified gitleaks 8.24.3** (upstream SHA256SUMS matched): baseline 10 findings → scoped v1 → 7 → final: **exit 0, "no leaks found"**.

### 8.3 Round record

- NEW `tests/audit/r72-seed-kek-and-gitleaks-triage.test.ts` (7 pins: useDefault kept, exactly seven allowlist paths + no regex/commits nukes, inline triage, seed-KEK env, finding records, PAT hygiene). Suite 1018 → **1025/18/0**.
- Docs: this §8; roadmap R72 row; NEXT-TASKS R72 UPDATE; dual worklogs R71+R72.
- Expected next (dispatch #7): gate green again; e2e/browser harness proceeds past seed into the journeys; scan goes green with the committed allowlist. Any further first-execution findings continue the same per-run remediation protocol.
