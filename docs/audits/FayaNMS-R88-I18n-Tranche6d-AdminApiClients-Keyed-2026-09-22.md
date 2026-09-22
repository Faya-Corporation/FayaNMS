# FayaNMS R88 — i18n tranche 6d: admin API clients keyed

Date: 2026-09-22
Branch: `main`
Scope: `src/components/views/admin-api-clients-view.tsx`

## Result

The Administration → API Clients view is fully keyed through a new `adminApiClients` namespace. The 27 pre-tranche sweep candidates (12 PROP + 15 JSX) are gone, including page chrome, KPIs, table headers, empty/error states, create/reveal/rotate dialogs, buttons, aria labels, and copy toasts. The existing technical/data-plane survivors remain intentional: API scope tokens, client data, the `grafana-dashboard` example, sha256, and English `formatDistanceToNow` output.

The namespace has 48 non-empty leaves with exact EN/AR deep parity. Dictionary totals move from 1,890 to 1,938 leaves in both locales. Arabic values use the established API terminology and preserve technical tokens where the UI contract requires them.

## Verification

- `tests/audit/r88-i18n-tranche-6d.test.ts`: 5 pass, 122 expectations.
- Combined i18n governance (`r56` plus `r80`–`r88`): 145 pass, 0 fail, 6,068 expectations across 10 files.
- The R56 ledger now contains 14 views and 547 candidates; the next tranche is `changes-view.tsx` (27 candidates).

The full application gate and live browser evidence were not rerun in this environment because project dependencies and the operator/browser runtime are unavailable. No database, environment, or screenshot artifacts were staged.
