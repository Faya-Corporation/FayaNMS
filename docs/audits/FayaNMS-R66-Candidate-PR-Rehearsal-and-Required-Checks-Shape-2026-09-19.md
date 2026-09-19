# FayaNMS — R66: Candidate-PR Rehearsal + Required-Checks Shape Unification (2026-09-19)

**Branch:** `z_ai_v2` · **Tree at round start:** `0d28a34` (R65) — 0/0 synced · **Scope:** operator-path preparation (merge rehearsal, HC-6 re-dispatch probe) + one governance-shape defect found and fixed.

---

## 1. Candidate-PR rehearsal (protective merge pre-flight)

With `origin/main` still at `27e0eea` (re-fetched this round, NOT moved):

| Check | Result |
| --- | --- |
| Merge simulation (`git merge-tree --write-tree origin/main z_ai_v2`) | **exit 0 — CLEAN, zero conflicts** (tree `92222d2` written) |
| Legacy marker scan (`changed in both` / conflict markers) | **0** |
| Commits ahead | **35** (`origin/main..z_ai_v2`) |
| Diff size | **198 files changed, +14,738 / −1,973** |

The protective merge `z_ai_v2` → `main` will land cleanly whenever the operator opens it.

## 2. HC-6 re-dispatch probe (second data point)

`POST /actions/workflows/ci.yml/dispatches {"ref":"z_ai_v2"}` → **204** → run **`35408254887`**
(event `workflow_dispatch`, head `0d28a34` — correct binding again) → `gate` **failure with 0 steps**;
`browser`/`scan`/`e2e` skipped with 0 steps. **Identical signature to #34 / #89 / `35406875963`** —
the GitHub-hosted runner infra failure persists; NOT a code regression (this same tree is green
locally, §5). The dispatch trigger path remains proven; the blocker remains runner capacity alone.

## 3. Governance defect found and fixed: required-checks shape drift (2-check / 3-check docs vs 4-job reality)

**Discovery:** while preparing the ruleset pre-flight, the required-checks sets across the
operation-facing documents contradicted each other AND the workflow:

- ci.yml defines **FOUR jobs**: `gate`, `e2e`, `browser`, `scan` (no `name:` overrides → check
  names = job ids; `e2e`/`browser` added R45/R47).
- The ci.yml header (R47) already pinned the correct marker: `required-checks: gate, scan, e2e, browser`.
- But the authoritative ruleset definition **TASK-GOV-001-A still said `gate`+`scan` (2)** — pre-R47
  wording that predates the e2e/browser jobs; four other operation docs said `gate`+`scan`+`e2e` (3);
  the roadmap/go-live definition said "the 4 required checks" WITHOUT naming them.

**Why it matters (not a typo):** an operator configuring the ruleset from TASK-GOV-001-A would
protect `main` with fewer required checks than the workflow actually runs — **e2e/browser failures
could then MERGE**. The required-checks set is the enforcement boundary of the release.

**Fixed (canonical shape = all FOUR, matching the header marker):**

| File | Before | After |
| --- | --- | --- |
| `docs/audits/FayaNMS-NEXT-TASKS.md` (TASK-GOV-001-A Goal) | required `gate`+`scan` | required `gate`+`e2e`+`browser`+`scan` (all FOUR, R66 correction noted) |
| `docs/ci/ci-gate.yml` (§2) | (`gate`, `scan`) | (`gate`, `e2e`, `browser`, `scan` — all FOUR jobs) |
| `docs/certification/MATRIX.md` (GOV-001-A row) | `gate`+`scan`+`e2e` | `gate`+`e2e`+`browser`+`scan` (all FOUR — R66) |
| `docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md` (note 4) | gate+scan+e2e ×2 | all FOUR (gate+e2e+browser+scan) ×2 |
| `docs/audits/FayaNMS-FINAL-Production-Gate-2026-09-15.md` (GOV-001 + CI-001 checklist) | `gate` + `scan` + `e2e`; 3-check re-run | all FOUR; 4-job battery wording |
| `docs/audits/FayaNMS-Operator-Handoff-Release-Notes-2026-09-18.md` (Step 2) | `gate`, `scan` — and `e2e`, `browser` once runners exist | all FOUR **NOW** (deferring checks would let e2e/browser failures merge) |
| `docs/brand/SOCIAL-REPOSITORY.md` (§6 item 3, historical ✅ record) | — | point-in-time fact RETAINED + R66 correction note appended (the R9-era config described there was lost — GOV-001) |
| Roadmap (OWNER-GOV-001 row + go-live item 3) | "the 4 required checks" (unnamed) | named: `gate`+`e2e`+`browser`+`scan` |

Historical audit snapshots (FINAL-Production-Readiness-Audit, Independent-Current-Main-Audit) are
point-in-time records and were NOT rewritten — truth-first applies forward, not retroactively.

**Pin:** NEW `tests/audit/r66-gov-required-checks-shape.test.ts` (6 pins):
A — ci.yml defines EXACTLY the four jobs, no `name:` override (check name = job id; the parser
class must include digits — `e2e` contains one); B — R47 header marker intact;
C — TASK-GOV-001-A Goal names all four, stale 2-check goal gone; D — ci-gate.yml / MATRIX /
deploy note 4 / FINAL-gate checklist / hand-off Step 2 all four-check, stale 3-check strings gone;
E — SOCIAL-REPOSITORY keeps the historical fact AND the correction note;
F — roadmap names the four checks in both places.

## 4. Suite impact

972 → **978 pass / 18 skip / 0 fail** (8,260 expects, 62 files; +6 pins). lint 0 · tsc 0.

## 5. LIVE re-verification (same tree)

- App `GET /api/v1/meta` → **200**.
- Worker `:3030` → `GET /health` → **200**; unauthenticated `POST /simulate/connect` → **401**
  (fail-closed).

## 6. State after R66

- Authorable backlog: **empty again** — the shape drift found this round was fixed and pinned in the same increment.
- Operator path (unchanged order, now fully rehearsed): runner capacity → re-dispatch / candidate PR (merge pre-flight: CLEAN) → protect `main` with **all FOUR** required checks → LAB hardware cert (Step 0 demo fleet ready) → protective merge → independent final audit on the release SHA.
