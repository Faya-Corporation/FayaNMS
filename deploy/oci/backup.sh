#!/usr/bin/env bash
set -euo pipefail

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
chmod 0640 "$encrypted"

find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age' -mtime +"$RETENTION_DAYS" -delete
sha256sum "$encrypted" >"$encrypted.sha256"
echo "Encrypted backup written: $encrypted"
