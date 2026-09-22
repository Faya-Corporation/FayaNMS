# FayaNMS R94 — i18n Tranche 6j: Change Approvals Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `fad79b9`

## Scope

`src/components/views/change-approvals-view.tsx` was keyed through a new `changeApprovals` namespace. The namespace has 50 non-empty leaves with deep EN/AR parity. The 33-candidate ledger item is zero in the shallow sweep, and the visible surface is keyed across the page/KPI/filter/search/table chrome, row approve/reject actions, SoD and entitlement tooltips, and the approve/reject decision dialog. Change numbers, risk levels, requester names, dates, and API data remain data or formatting values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R94 gate: **5 pass / 0 fail / 116 expectations**.
- Combined governance gate after the implementation: **176 pass / 0 fail / 7,201 expectations** across 16 files.
- Ledger: 9 → **8 entries / 371 candidates**; dictionary totals: 2,151 → **2,201 = 2,201**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `alerts-view.tsx` (36 candidates).
