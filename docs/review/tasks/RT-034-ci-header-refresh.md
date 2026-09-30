# RT-034 — ci.yml governance header: refresh the stale branch-protection claim

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-064 | A5-12 | P3 | S | Zero — comment-only change |

## Problem & evidence

`.github/workflows/ci.yml:6-10,15-17` — the header still claims:
> `Branch protection: NOT ACTIVE. Live API read-back 2026-09-15 … Until then, direct pushes to main run these gates`

Branch protection has been ACTIVE since worklog Task 3 (2026-09-19+; required checks gate/e2e/browser/scan, strict, `enforce_admins=false` per the audit). The header contradicts the current state and the `r66`/`gov-verify.ts` contracts — audit-trail confusion risk.

## Impact

Governance drift: an auditor reading the workflow believes protection is off; contracts (`scripts/gov-verify.ts`, `tests/audit/r66-gov-required-checks-shape.test.ts`, `docs/runbooks/governance.md`) say otherwise.

## Root cause

The header was written during the CI bring-up era and never refreshed after protection landed.

## Required change

1. **`.github/workflows/ci.yml`** lines 3-25 (the `GOVERNANCE STATUS` block): rewrite to the current truth:
   - `Branch protection: ACTIVE (owner-applied, worklog Task 3, 2026-09-19). Required checks: gate, e2e, browser, scan (strict; enforce_admins=false).`
   - Replace the "until then, direct pushes…" prose with a pointer: `Executable contract: bun scripts/gov-verify.ts (GOV gate); see docs/runbooks/governance.md.`
   - Keep the historical one-liner about the bring-up era (runs #1–#6) but mark it clearly as HISTORY, not status.
   - Do NOT change any workflow logic, triggers, steps, or pins — comments only.
2. Cross-check one line each: `docs/runbooks/governance.md` and the `required-checks:` comment (line 21) still agree with the new header (they describe the same contract; fix any date/claim drift found in THOSE lines only if factually wrong — no contract changes).
3. This does NOT satisfy or touch A5-04 (gov-verify vs actual protection reconciliation — that stays deferred; the two are related but distinct: this RT fixes documentation truth, A5-04 fixes the executable contract gap).

## Tests to add

File: `tests/audit/rt034-ci-header-truth.test.ts` (comment police; possibly extend `tests/audit/current-state-ledger.test.ts` if it already pins header text).

1. `header no longer claims protection is NOT ACTIVE` — read ci.yml lines 1-30: the string `NOT ACTIVE` is gone; `ACTIVE` + a date + `gov-verify` pointer present.
2. `header lists the enforced required checks` — asserts the four check names appear in the header block (contract mirror of the applied protection).
3. `workflow semantics untouched` — negative/guard: the YAML's jobs/triggers/steps hash (or structural diff against a pinned snapshot) is unchanged by this RT (comment-only enforcement, e.g. assert `on:`/`jobs:` sections byte-match the pre-change snapshot committed in the test).

## Acceptance criteria

- [ ] ci.yml header states protection is ACTIVE with the correct required checks and points at gov-verify.
- [ ] Zero non-comment diff in ci.yml.
- [ ] governance.md/gov-verify narratives show no new contradictions.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt034-ci-header-truth.test.ts   # new suite green
bun test tests/audit/r66-gov-required-checks-shape.test.ts tests/audit/current-state-ledger.test.ts   # governance peers green
bun test tests/                                      # no regressions
node_modules/typescript/bin/tsc --noEmit             # exit 0
bun run lint                                         # 0 errors
```

## Rollout & rollback notes

Comment-only; revert-safe. Refresh the "live read-back" date whenever protection settings change again — note that maintenance rule in the header itself so the next drift is self-flagging.


## Status

Fixed (5711b3c)
