# FayaNMS R93 — i18n Tranche 6i: Backup Compliance Keyed

Date: 2026-09-22
Branch: `main`
Baseline commit: `847eee0`

## Scope

`src/components/views/backup-compliance-view.tsx` was keyed through a new `backupCompliance` namespace. The namespace has 37 non-empty leaves with deep EN/AR parity. The 30-candidate ledger item is zero in the shallow sweep, and the complete visible surface is keyed: compliance legend, page/loading/error states, KPI descriptions/status labels, per-site table and empty state, stale-device section, and row accessibility labels. Backup values, timestamps, percentages, site names, and shared compliance-band semantics remain data or formatting values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R93 gate: **5 pass / 0 fail / 89 expectations**.
- Combined governance gate after the implementation: **171 pass / 0 fail / 6,987 expectations** across 15 files.
- Ledger: 10 → **9 entries / 404 candidates**; dictionary totals: 2,114 → **2,151 = 2,151**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `change-approvals-view.tsx` (33 candidates).
