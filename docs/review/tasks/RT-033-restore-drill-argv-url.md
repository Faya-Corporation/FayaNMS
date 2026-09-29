# RT-033 — restore-drill.sh: keep the database URL off the command line

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-063 | A5-11 | P3 | S | Low — argv hygiene only; pg_restore/psql behavior unchanged |

## Problem & evidence

`deploy/oci/restore-drill.sh:22-24`:
```bash
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$tmp" "$BACKUP_FILE"
pg_restore --exit-on-error --no-owner --no-acl --dbname "$TARGET_DATABASE_URL" "$tmp"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select 1 as restore_probe;'
```
`RESTORE_TARGET_DATABASE_URL` (with credentials) appears in `argv` → visible in host `ps`/audit logs for the duration of the drill. The script is otherwise fail-closed (approval flag, isolated target required, tmp cleanup trap — lines 8-21).

## Impact

Credential exposure in process listings/audit logs during DR drills.

## Root cause

Connection passed as a CLI argument instead of libpq's supported file/env channels.

## Required change

`deploy/oci/restore-drill.sh`:
1. Use a libpq connection **service file** (or PGPASSWORD) — preferred: derive the connection without argv:
   ```bash
   export PGPORT PGHOST PGDATABASE PGUSER PGPASSWORD   # parsed from $TARGET_DATABASE_URL
   ```
   Parsing a postgres URL in bash is error-prone; the robust minimal change is a temporary **pgpass file**:
   ```bash
   pgpass=$(mktemp)
   chmod 600 "$pgpass"
   # *:*:*:*:<password>  with host/port/db/user extracted from the URL
   ```
   Implementation note: URL shape is `postgresql://user:pass@host:port/db` (single canonical shape in this repo — `deploy/oci/env.example:14`). Extract with bash parameter expansion (`${URL#*://}`, `${part%%@*}` etc.) into `PGHOST/PGPORT/PGUSER/PGPASSWORD` env vars, which BOTH `pg_restore` and `psql` honor, and pass `--dbname="$PGDATABASE"` (bare db name, no URL). Add the cleanup trap: extend `cleanup()` (line 20) to `rm -f "$tmp"` AND unset the password export (`trap` already exists — add the var removal there; env vars don't need file cleanup but a stray `pgpass` file would, so prefer the env-var approach and skip the file entirely).
   - Guard: fail loudly if the URL doesn't match the expected shape (extend the line-13 validation with a shape regex) — never half-parse credentials.
2. Keep the `select 1` probe behavior identical (env-driven connection).
3. Runbook one-liner if `docs/runbooks/disaster-recovery.md` shows the env-var usage (it does reference RESTORE_TARGET_DATABASE_URL — the contract stays, only the argv handling changes; likely no doc change needed).

## Tests to add

File: `tests/audit/rt033-restore-argv-hygiene.test.ts` (script police + functional fragment, style of `tests/audit/drill-restore.test.ts`).

1. `no URL in argv` — source assertion: `--dbname "$TARGET_DATABASE_URL"` no longer appears; `psql "$TARGET_DATABASE_URL"` gone; pg_restore/psql consume env-derived parts (assert `PGPASSWORD=`/`PGHOST=` exports exist and `--dbname` takes the bare DB name).
2. `URL parser handles the canonical shape` — extract the parsing fragment into a testable function or replicate it in the test: `postgresql://fayanms:pw@db.host:5433/fayanms` → PGHOST=db.host, PGPORT=5433, PGUSER=fayanms, PGPASSWORD=pw, PGDATABASE=fayanms.
3. `malformed URL refused` — negative case: URL without `://` or without credentials → script exits nonzero BEFORE any restore (extend guard asserted).
4. `existing gates unchanged` — approval flag / isolated-target / age-identity checks (lines 8-17) still present and ordered before any connection attempt.
5. `no pgpass file left behind` — if a temp pgpass approach is used, the cleanup trap removes it (functional fragment test).

## Acceptance criteria

- [ ] Credentials never appear in `pg_restore`/`psql` argv (env or service-file transport only).
- [ ] URL parsing is validated and fail-loud on malformed input.
- [ ] Drill behavior (probe, gates, cleanup) unchanged.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt033-restore-argv-hygiene.test.ts   # new suite green
bun test tests/audit/drill-restore.test.ts                 # DR peers green
bun test tests/                                            # no regressions
node_modules/typescript/bin/tsc --noEmit                   # exit 0
bun run lint                                               # 0 errors
# Manual: run the drill against a scratch target and confirm `ps` never shows the URL.
```

## Rollout & rollback notes

Host-script-only; DR runbook contract (env var name) unchanged. Rollback = revert. Flag for reviewers: bash URL parsing is the riskiest line in the change — the shape-guard test (3) is the safety net; do not "simplify" the guard away.
