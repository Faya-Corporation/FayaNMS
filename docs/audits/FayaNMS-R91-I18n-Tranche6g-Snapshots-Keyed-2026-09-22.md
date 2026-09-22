# FayaNMS R91 — i18n tranche 6g: snapshots view keyed

Date: 2026-09-22
Branch: `main`
Scope: `src/components/views/snapshots-view.tsx`

## Result

The Snapshots view now consumes a new `snapshotsView` namespace. All 29 pre-tranche sweep candidates are keyed across page/card chrome, filters, compare-selection guidance, empty/error states, table headings, row accessibility labels, pagination, and the compare dialog. Existing status-label resolution remains shared through `useStatusLabel`.

The namespace has 39 non-empty leaves with exact EN/AR deep parity. Dictionary totals move from 2,024 to 2,063 leaves in both locales. Device hostnames, IDs, checksums, sizes, version/date formatting, and em-dash data fallbacks remain data or format values.

## Verification

- `tests/audit/r91-i18n-tranche-6g.test.ts`: 5 pass, 94 expectations.
- Combined i18n governance (`r56` plus `r80`–`r91`): 161 pass, 0 fail, 6,608 expectations across 13 files.
- The R56 ledger now contains 11 views and 464 candidates; the next tranche is `drift-view.tsx` (30 candidates).

The full application gate and live browser evidence were not rerun in this environment because project dependencies and the operator/browser runtime are unavailable. No database, environment, or screenshot artifacts were staged.
