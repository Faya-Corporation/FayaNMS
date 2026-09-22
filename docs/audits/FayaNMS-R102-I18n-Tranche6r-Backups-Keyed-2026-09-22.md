# FayaNMS R102 — i18n Tranche 6r: Backups Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `ca05ae4`

## Scope

`src/components/views/backups-view.tsx` was keyed through a new `backups` namespace. The namespace has 117 non-empty leaves with deep EN/AR parity. All 61 shallow candidates are now zero across backup history, download controls, pagination, policy forms and validation, scope chips, policy tables, policy actions, and the delete dialog. Shared cron hints now accept an optional translator while preserving existing English callers.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and the backups ledger entry still present.
- Isolated R102 gate: **5 pass / 0 fail / 248 expectations**.
- Combined governance gate: **216 pass / 0 fail / 9,904 expectations** across 24 files (`r56`, `r80`–`r102`); prior tranche pins were updated to the current dictionary and empty-ledger state.
- Ledger: 1 → **0 entries / 0 candidates**; dictionary totals: 2,733 → **2,850 = 2,850**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

The i18n tranche program is complete; the R56 sweep now forbids future unledgered candidates.
