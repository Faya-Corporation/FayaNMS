# FayaNMS R89 — i18n tranche 6e: changes view keyed

Date: 2026-09-22
Branch: `main`
Scope: `src/components/views/changes-view.tsx`

## Result

The Changes and My Changes views now consume a new `changesView` namespace. All 27 pre-tranche sweep candidates (the page header, KPI labels/descriptions, status chips, filters, empty/error states, table headings, actions, row summaries, and pagination controls) are keyed. Dynamic status-chip keys and existing localized risk labels are resolved at render time. Device and step counts use locale-appropriate ICU plural categories.

The namespace has 44 non-empty leaves with exact EN/AR deep parity. Dictionary totals move from 1,938 to 1,982 leaves in both locales. Data-plane change titles, requester names, status/risk badge resolution, date formatting, and em-dash defensive placeholders remain intentionally outside this shallow chrome sweep.

## Verification

- `tests/audit/r89-i18n-tranche-6e.test.ts`: 6 pass, 104 expectations.
- Combined i18n governance (`r56` plus `r80`–`r89`): 151 pass, 0 fail, 6,258 expectations across 11 files; the ledger is 13 views and 520 candidates.
- The next ledger tranche is `events-view.tsx` (27 candidates).

The full application gate and live browser evidence were not rerun in this environment because project dependencies and the operator/browser runtime are unavailable. No database, environment, or screenshot artifacts were staged.
