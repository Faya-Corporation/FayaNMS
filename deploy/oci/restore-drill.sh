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

tmp=$(mktemp --suffix=.dump)
cleanup(){ rm -f "$tmp"; }
trap cleanup EXIT
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$tmp" "$BACKUP_FILE"
pg_restore --exit-on-error --no-owner --no-acl --dbname "$TARGET_DATABASE_URL" "$tmp"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select 1 as restore_probe;'
echo "Restore drill passed against the explicitly supplied isolated target."
