# FayaNMS R101 — i18n Tranche 6q: Change Detail Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `6de2490`

## Scope

`src/components/views/change-detail-view.tsx` was keyed through a new `changeDetail` namespace. The namespace has 101 non-empty leaves with deep EN/AR parity. All 52 shallow candidates are now zero across the change header/actions, KPI and detail panels, plans/devices/steps, approval actions, linked records, pre-checks, execute/decision/confirmation dialogs, and timeline output helpers. Change numbers, names, risk/status tokens, device and step data, timestamps, and command output remain data or technical values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and the change-detail ledger entry still present.
- Isolated R101 gate: **5 pass / 0 fail / 217 expectations**.
- Combined governance gate: **211 pass / 0 fail / 9,424 expectations** across 23 files (`r56`, `r80`–`r101`); prior tranche pins were updated to the current dictionary and ledger totals.
- Ledger: 2 → **1 entry / 61 candidates**; dictionary totals: 2,632 → **2,733 = 2,733**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `backups-view.tsx` (61 candidates).
