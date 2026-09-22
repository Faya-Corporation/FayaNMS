# FayaNMS R97 — i18n Tranche 6m: Discovery Keyed

Date: 2026-09-22  
Branch: `main`  
Baseline commit: `057c91d`

## Scope

`src/components/views/discovery-view.tsx` was keyed through a new `discoveryView` namespace. The namespace has 69 non-empty leaves with deep EN/AR parity. The 43-candidate ledger item is zero in the shallow sweep, and the visible surface is keyed across scan history, candidate selection/import, scan progress, the new-scan form, the import dialog, accessibility labels, severity labels, and skipped-candidate feedback. IPs, CIDRs, correlation IDs, hostnames, vendor/model values, protocols, OS fingerprints, counts, and relative timestamps remain data or formatting values.

## Verification

- Red test observed before implementation: missing namespace, unkeyed source, and ledger entry.
- Isolated R97 gate: **5 pass / 0 fail / 153 expectations**.
- Combined governance gate: **191 pass / 0 fail / 7,975 expectations** across 19 files (`r56`, `r80`–`r97`); prior tranche pins were updated to the current dictionary and ledger totals.
- Ledger: 6 → **5 entries / 254 candidates**; dictionary totals: 2,315 → **2,384 = 2,384**.
- `git diff --check` passed for the scoped files.

Full application lint/typecheck, full CI, and live browser re-execution remain unavailable in this environment. No deployment, branch-protection, or operator-side changes were made.

Next authorable tranche: `incident-detail-view.tsx` (43 candidates).
