# FayaNMS R90 — i18n tranche 6f: events view keyed

Date: 2026-09-22
Branch: `main`
Scope: `src/components/views/events-view.tsx`

## Result

The Events view now consumes a new `eventsView` namespace. All 27 pre-tranche sweep candidates are keyed across the page header, KPI strip, filter controls, live-poll chrome, section states, pagination, and the memoized event-row/JSON expansion helpers. Existing `timeRange` translations continue to supply the shared range labels; event-specific fallbacks are keyed locally.

The namespace has 42 non-empty leaves with exact EN/AR deep parity. Dictionary totals move from 1,982 to 2,024 leaves in both locales. Event action/result tokens, actor/resource/correlation identifiers, JSON payloads, technical timestamps, and relative-time output remain data-plane or format values rather than translated chrome.

## Verification

- `tests/audit/r90-i18n-tranche-6f.test.ts`: 5 pass, 98 expectations.
- The R56 ledger is reduced to 12 views and 493 candidates; the next tranche is `snapshots-view.tsx` (29 candidates).
- Combined r56+r80–r90 governance: 156 pass, 0 fail, 6,438 expectations across 12 files.

The full application gate and live browser evidence were not rerun in this environment because project dependencies and the operator/browser runtime are unavailable. No database, environment, or screenshot artifacts were staged.
