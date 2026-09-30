#!/usr/bin/env bash
set -euo pipefail

# RT-032 (F-062): owner-only artifacts. The plaintext pg_dump window (dump
# written to disk before age encrypts it) must never be group/other-readable
# regardless of the invoking shell's umask — pin 077 so every file this
# script creates (the .sql dump, the .age output, the .sha256 sidecar — the
# sidecar holds no secret but is 0600 all the same) is born mode 0600.
umask 077

ROOT=${FAYANMS_ROOT:-/opt/fayanms}
ENV_FILE=${FAYANMS_ENV_FILE:-$ROOT/.env}
BACKUP_DIR=${FAYANMS_BACKUP_DIR:-$ROOT/backups}
RETENTION_DAYS=${FAYANMS_BACKUP_RETENTION_DAYS:-30}
AGE_RECIPIENT=${FAYANMS_BACKUP_AGE_RECIPIENT:-}

[[ -r "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
[[ -n "$AGE_RECIPIENT" ]] || { echo "FAYANMS_BACKUP_AGE_RECIPIENT is required; refusing plaintext backup." >&2; exit 1; }
command -v age >/dev/null || { echo "age is required for encrypted backups." >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
cd "$ROOT"
install -d -m 0750 "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
plain="$BACKUP_DIR/fayanms-$stamp.sql"
encrypted="$plain.age"

docker compose --env-file "$ENV_FILE" -f compose.yml exec -T postgres pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  -U fayanms -d fayanms >"$plain"
age --recipient "$AGE_RECIPIENT" --output "$encrypted" "$plain"
rm -f "$plain"
# Explicit 0600: with the umask above this is belt-and-braces — every
# artifact the script produces is owner-only, no group read.
chmod 0600 "$encrypted"

find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age' -mtime +"$RETENTION_DAYS" -delete
sha256sum "$encrypted" >"$encrypted.sha256"
echo "Encrypted backup written: $encrypted"
