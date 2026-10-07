# FayaNMS — GA remediation release notes (draft, 2026-10-06 program)

> Status: DRAFT — finalized only when owner gates (GA-READINESS rows 1, 11–14)
> are resolved. Every item below shipped through a green-CI PR merge; nothing
> here is claimed from a local tree.

## Security & tenancy (fix waves GA-0..GA-6, + GA-4b control plane)

- **Baseline (PR #74 `60ea5c6`):** every OPEN finding from the 2026-10-06
  re-audit re-verified against source with file:line evidence (zero stale);
  `docs/review/` program docs; sharp 0.35.5 override for the new upstream
  HIGH advisory GHSA-wq5f-xc86-pv6w (scan gate restored).
- **Tenancy I (PR #75 `fe9c39e`):** `/api/v1/sites` is session-scope-aware
  (rows AND aggregates; deny-all/malformed fail closed); backup-policy
  POST/PATCH refuse out-of-scope and fleet-wide actuation; PATCH evaluates
  the EFFECTIVE post-replacement scope (P1-A02/A03).
- **Tenancy II (PR #76 `f817e3a`):** report schedules freeze their site scope
  at creation (immutable); report generation/runs intersect availability,
  backup, capacity, incidents with the frozen scope; worker path runs under
  the SCHEDULE's scope (never widens); per-user notification read receipts
  (P1-A01 + P2).
- **API-client lifecycle (PR #77 `3af334c`):** API clients gain
  `expiresAt`/`rotatedAt` lifecycle and a `siteScopeJson` resource scope; the
  acknowledge-client bypass is removed (P1-A04/A05).
- **Operations honesty (PR #78 `5140b2c`):** simulated surfaces (HA
  failover-test, collector rebalance APPLY) are FAIL-CLOSED behind
  `FAYANMS_DEMO_MODE` (403 SIMULATION_DISABLED; gate precedes all
  data-dependent branches — the CI empty-fleet lesson); protocol DLQ gains
  operator recovery: dead-letter listing, guarded idempotent requeue with
  audit, depth metric + alert rule (P0-R05/P1-O02/P1-O03).
- **Report honesty (PR #79 `24ccacf`):** PDF/XLSX stop being delivery tags —
  a dependency-free PDF 1.4 writer and a minimal OOXML spreadsheet writer
  render REAL bytes at delivery from the stored artifact; byte-level tests
  verify the xref and the zip CRCs (GA-5).
- **Session lifetime (this wave):** ABSOLUTE session cap enforced on the
  token's `iat` anchor — `FAYANMS_SESSION_MAX_AGE_HOURS` (default 12,
  0 = legacy off, invalid values fail SAFE to the default) — closing the
  sliding-window gap (P2-S01). The "deliberately NOT implemented" owner note
  is replaced by the implementation + rollback lever.
- **DR tooling (this wave):** WAL archiving ships in the compose postgres
  service (`archive_mode=on` → `fayanms-wal` volume) with a PITR runbook
  section; scheduled age-encrypted backups ship as a compose sidecar
  (`deploy/oci/backup-sidecar/`, refuse-plaintext, pipe-only plaintext
  window) alongside the existing host-cron script (P0-R03 in-repo scope).

## Documentation truth

- `docs/release/GA-READINESS.md` is now the ONE canonical release gate table
  (14 rows, each with evidence + re-verification instructions).
- `docs/certification/MATRIX.md` §4: GOV-001-A retotaled to ACTIVE—PARTIAL
  (protection verified live: 4 required checks strict, no force-push/
  deletion; the approval requirement remains the owner's residual gap);
  CI-001-A retotaled to RESOLVED (green runs listed).
- `docs/implementation/CURRENT-STATE.md` carries a truth banner pointing to
  the canonical table and correcting its stale snapshot claims.

## Explicitly NOT claimed (owner-gated)

- Vendor T3 certification (needs real/vendor-virtual appliances).
- Staging deploy/burn-in + final independent re-audit (needs OCI secrets,
  host, owner sign-off).
- Off-host backup custody, key custody, real-target DR drill, RPO/RTO
  approval.
