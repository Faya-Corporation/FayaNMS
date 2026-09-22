# FayaNMS R95 — i18n Tranche 6k: Alerts Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `f7e0cab`

## Scope

`src/components/views/alerts-view.tsx` was keyed through a new `alertsView` namespace. The namespace has 49 non-empty leaves with deep EN/AR parity. The 36-candidate ledger item is zero in the shallow sweep, and the visible surface is keyed across page/tabs/KPIs, status and severity filters, rule/site/search/sort controls, refresh/error/empty states, pagination, and the worker-engine footer. Alert rows, rule/site names, counts, status tokens, and date-fns relative time remain data or formatting values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R95 gate: **5 pass / 0 fail / 115 expectations**.
- Combined governance gate after the implementation: **181 pass / 0 fail / 7,412 expectations** across 17 files.
- Ledger: 8 → **7 entries / 335 candidates**; dictionary totals: 2,201 → **2,250 = 2,250**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `maintenance-view.tsx` (38 candidates).
