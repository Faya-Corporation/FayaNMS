#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE=${1:-}
TARGET_DATABASE_URL=${RESTORE_TARGET_DATABASE_URL:-}
AGE_IDENTITY_FILE=${FAYANMS_RESTORE_AGE_IDENTITY_FILE:-}

if [[ ! "$BACKUP_FILE" =~ \.sql\.age$ ]]; then
  echo "Usage: RESTORE_TARGET_DATABASE_URL=... FAYANMS_RESTORE_AGE_IDENTITY_FILE=/secure/key.age $0 backup.sql.age" >&2
  exit 2
fi
[[ -r "$BACKUP_FILE" ]] || { echo "Backup does not exist." >&2; exit 1; }
[[ -n "$TARGET_DATABASE_URL" ]] || { echo "RESTORE_TARGET_DATABASE_URL is required." >&2; exit 1; }
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo "Restore identity file is required." >&2; exit 1; }
[[ ${RESTORE_DRILL_APPROVED:-0} == 1 ]] || { echo "Set RESTORE_DRILL_APPROVED=1 for an isolated target only." >&2; exit 2; }
command -v age >/dev/null || { echo "age is required." >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required." >&2; exit 1; }

# RT-033 (F-063): the connection is established through libpq environment
# variables — the URL (and its credentials) NEVER appear in pg_restore/psql
# argv, so host `ps`/audit logs cannot capture them during a drill. Parsing
# is fail-loud on anything but the canonical shape (see pg-url.sh) and runs
# before any restore step.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-url.sh
source "$script_dir/pg-url.sh"
parse_pg_url "$TARGET_DATABASE_URL"

tmp=$(mktemp --suffix=.dump)
cleanup(){
  rm -f "$tmp"
  # The connection env vars die with the process anyway; unsetting here
  # keeps the password from leaking into anything the trap might call.
  unset PGPASSWORD PGHOST PGPORT PGUSER PGDATABASE
}
trap cleanup EXIT
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$tmp" "$BACKUP_FILE"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$PGDATABASE" "$tmp"
psql --dbname="$PGDATABASE" -v ON_ERROR_STOP=1 -c 'select 1 as restore_probe;'
echo "Restore drill passed against the explicitly supplied isolated target."
