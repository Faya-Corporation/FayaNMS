# ADR — Events search (`q`) case-insensitivity contract

Status: Accepted (batch-22, F-047)
Date: 2026-10-03
Scope: `GET /api/v1/events` (platform audit-event timeline search)

## Context

The events timeline search (`q`) does substring matching across six AuditEvent
columns (actorName, action, resourceType, resourceLabel, resourceId,
correlationId). The documented contract dates from the SQLite era, where
`LIKE` is case-insensitive by default. The Phase 21 move to PostgreSQL
silently changed `q` to case-sensitive (Prisma `contains` maps to Postgres
`LIKE`), leaving the documented contract stale (audit finding F-047 /
A3-11). A mixed-case search that used to match ("backup" vs "BACKUP")
stopped matching after the provider switch.

## Decision

The documented contract — case-insensitive substring search — is the
intended product behavior and is restored explicitly: every `q` `contains`
filter now passes Prisma `mode: "insensitive"` (compiles to Postgres
`ILIKE`), and the route docstring states the contract without referencing
the retired SQLite provider.

## Consequences

`ILIKE` cannot use a plain btree index, so a `q` filter is a scan across six
columns — measurably heavier than a case-sensitive `LIKE`. This is accepted
for now because:

- the route's output is bounded (`pageSize` hard-capped at 100 in
  `paginationSchema`; `q` capped at 120 chars), so per-load cost stays
  acceptable;
- AuditEvent is append-only (no retention sweep touches it — F-047's
  ops-data sweep explicitly excludes the audit chain), so the table is the
  long-term growth case and the cost question must be answered by an index,
  not by deleting history.

## Follow-up (named, not scheduled)

If AuditEvent volume makes the 6-column `ILIKE` scan the dominant page-load
cost, the fix is NOT a schema-breaking rewrite but one of:

1. a **dedicated normalized search column** (e.g. `searchText` maintained on
   write, concatenating the six fields lowercased) with a plain btree/trgm
   index, or
2. a **`pg_trgm` GIN index** over the existing columns (requires the
   `pg_trgm` extension; compose-managed Postgres image must include it).

Either is additive (migration + write-path change only on the events read
model) and should land with its own hot-path-index migration + regression
pin in the RT-015 style. Until then, the bounded page size keeps the scan
acceptable.

## Constraint discovered (2026-10-04, follow-up wave 3)

Option 2 has a CI-plane precondition that was not visible when this ADR was
written: the Zonky embedded PostgreSQL build used by CI's migrate-only
database replica ships NO contrib modules (verified directly — no
`pg_trgm.so` and no `pg_trgm.control` in the extracted binaries), so a
`CREATE EXTENSION pg_trgm` migration would fail CI reproducibility unless
the CI plane first gains a contrib-capable Postgres. The compose-managed
`postgres:16` production image already includes contrib, so only the CI
plane is affected. Option 1 (normalized column + index) avoids the
extension for the write path but still needs a trgm-or-better index to
serve substring search, so it inherits the same constraint for its index.
The follow-up therefore stays documented — now with the named CI-plane
precondition — and the volume trigger above remains unmet.
