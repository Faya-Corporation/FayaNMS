# FayaNMS — R63: CI Trigger Correction + Hand-off Refresh — 2026-09-19

Branch `z_ai_v2` · closes the reviewer's process points from the independent
re-verification (the code findings were closed in R61/R62).

## 1. CI trigger — the HC-6 execution path is now executable

**The finding (verified against GitHub + the tree):** the workflow triggers on
`push` to `main` and `pull_request` ONLY — a push to `z_ai_v2` runs nothing,
so the old HC-6 step ("push a no-op docs commit") could never have executed
the 4-job release gate. The reviewer was right.

**The fix:** `workflow_dispatch:` added to `.github/workflows/ci.yml` (with an
inline rationale comment). The corrected HC-6 execution paths are:

1. **manual dispatch** — Actions tab → CI gate → Run workflow on the branch
   SHA (available the moment runner capacity exists), or
2. **the candidate PR** — `pull_request` triggers all four jobs.

Also note: the header history comment mentions a historical "corrupted
`branches:` trigger" era — the current block was verified well-formed
(`branches: [main]`, exactly one branches entry in the trigger block, all
three triggers present — PyYAML-parsed one-off + pinned in the test below).

## 2. Hand-off release notes — drift and caveats corrected

The R59 snapshot had gone stale (the reviewer's INFO finding). The document
now:

- points at the LEDGER for live numbers instead of hard-coding a commit count;
- records the 2026-09-19 re-verification episode explicitly: 2 P0 + 2 P1
  authorable findings, ALL remediated + machine-pinned (R61/R62), with the
  changelog table extended through R62;
- corrects the HC-6 runbook ordering (§4 step 1) — dispatch or PR, never a
  branch push;
- documents the TWO Dependabot activation caveats: (a) the config activates
  from the DEFAULT branch, i.e. at/after the merge — not at this push;
  (b) Dependabot update jobs are separate GitHub-generated Actions jobs and
  need their own capacity check;
- carries the runner-memory nuance: standard hosted `ubuntu-latest` documents
  8 GB exactly — a self-hosted runner gives safer headroom for `build:gate`.

The roadmap HC-6 section's step text was corrected the same way, and the old
"push a no-op docs commit" instruction is now machine-pinned as GONE.

## 3. Test pins — `tests/audit/r63-ci-trigger-and-handoff.test.ts` (4)

| # | Pin |
|---|---|
| 1 | ci.yml declares push + `branches: [main]` + pull_request + workflow_dispatch |
| 2 | the TRIGGER BLOCK carries exactly one well-formed branches entry; no `branches: ain]` artifact anywhere (the header's historical mention of the corruption is legitimate and excluded) |
| 3 | the hand-off documents the corrected HC-6 path + both Dependabot caveats |
| 4 | the roadmap HC-6 step contains the trigger truth and no longer instructs a z_ai_v2 push |

## 4. Gates (CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | clean |
| `bunx tsc --noEmit` | exit 0 |
| `bun test tests/` | **963 → 967 pass / 18 skip / 0 fail** (8,214 expects, 60 files) |
| ci.yml one-off | PyYAML: triggers = push / pull_request / workflow_dispatch, branches = [main] |

## 5. LIVE verification

App root 200 · `/api/v1/meta` 200 (the Next.js dev process was found down
after the heavy test runs and restarted — worker mini-service had stayed up
the whole time, its claim/tick loops logging 200s throughout).

## 6. Honest scope

- `workflow_dispatch` execution behavior is GitHub-side; it proves out with
  OWNER-CI-001/HC-6 exactly like the rest of the workflow.
- The hand-off doc now deliberately defers live counts to the ledger — this
  class of INFO drift cannot recur in the numbers it defers; the commit
  table's SHAs are historical facts and stable.
