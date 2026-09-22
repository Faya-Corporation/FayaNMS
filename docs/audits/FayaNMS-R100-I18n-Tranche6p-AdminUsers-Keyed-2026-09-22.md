# FayaNMS R100 — i18n Tranche 6p: Admin Users Keyed

Date: 2026-09-22  
Branch: `main`  
Baseline commit: `41a21a4`

## Scope

`src/components/views/admin-users-view.tsx` was keyed through a new `adminUsers` namespace. The namespace has 78 non-empty leaves with deep EN/AR parity. All 51 shallow candidates are now zero across the administration header, KPI strip, account filters/table, role catalog, row permission controls, create-user validation and dialog, and reset-password dialog. User and role data, permission keys, relative timestamps, and audit event tokens remain data or technical values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and the ledger entry still present.
- Isolated R100 gate: **5 pass / 0 fail / 172 expectations**.
- Combined governance gate: **206 pass / 0 fail / 9,007 expectations** across 22 files (`r56`, `r80`–`r100`); prior tranche pins were updated to the current dictionary and ledger totals.
- Ledger: 3 → **2 entries / 113 candidates**; dictionary totals: 2,554 → **2,632 = 2,632**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `change-detail-view.tsx` (52 candidates).
