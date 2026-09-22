# FayaNMS R96 — i18n Tranche 6l: Maintenance Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `d0fa34b`

## Scope

`src/components/views/maintenance-view.tsx` was keyed through a new `maintenanceView` namespace. The namespace has 65 non-empty leaves with deep EN/AR parity. The 38-candidate ledger item is zero in the shallow sweep, and the visible surface is keyed across page/KPI/status/filter chrome, the maintenance CRUD form, overlap warning, row actions and scope/status badges, pagination, and the delete confirmation dialog. Device/site names, change numbers, dates, hostnames, and date-fns relative time remain data or formatting values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R96 gate: **5 pass / 0 fail / 146 expectations**.
- Combined governance gate after the implementation: **186 pass / 0 fail / 7,686 expectations** across 18 files.
- Ledger: 7 → **6 entries / 297 candidates**; dictionary totals: 2,250 → **2,315 = 2,315**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `discovery-view.tsx` (43 candidates).
