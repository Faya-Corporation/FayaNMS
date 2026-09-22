# FayaNMS R92 — i18n Tranche 6h: Drift Keyed

Date: 2026-09-22
Branch: `main`
Commit: `4222a40` baseline for this tranche

## Scope

`src/components/views/drift-view.tsx` was keyed through a new `driftView` namespace. The namespace has 51 non-empty leaves with deep EN/AR parity. All 30 R56 sweep candidates are removed, including page/KPI/filter/table/pagination chrome, empty/error states, the configuration diff dialog, triage confirmation, and row action/accessibility labels. Existing status-label resolution remains shared; operational values and technical formatting remain data-plane values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R92 gate: **5 pass / 0 fail / 118 expectations**.
- Combined governance gate after the implementation: **166 pass / 0 fail / 6,826 expectations** across 14 files.
- Ledger: 11 → **10 entries / 434 candidates**; dictionary totals: 2,063 → **2,114 = 2,114**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `backup-compliance-view.tsx` (30 candidates).
