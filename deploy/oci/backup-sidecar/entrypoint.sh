#!/bin/sh
# GA-6 (P0-R03) — scheduled encrypted-backup sidecar entrypoint.
#
# Contract (mirrors deploy/oci/backup.sh — the host-cron path):
#   - FAIL-CLOSED: refuses to start without FAYANMS_BACKUP_AGE_RECIPIENT —
#     plaintext database backups are never acceptable;
#   - umask 077: every artifact (none here persist outside /backups) would
#     be owner-only even if the dump window ever touched the filesystem;
#   - custom-format pg_dump over the internal backend network (--format=custom,
#     --no-owner, --no-acl — identical flags to backup.sh), streamed to age;
#     the plaintext dump exists ONLY inside the pipe — never on disk;
#   - checksum sidecar (sha256) per backup, retention identical to backup.sh;
#   - deterministic schedule: sleep-loop (no cron dependency) — first run
#     starts immediately, then every FAYANMS_BACKUP_INTERVAL_SECONDS
#     (default 6h = 21600s).
#
# Environment (interpolated by compose from the host-side .env):
#   PGPASSWORD                        — the database credential
#   FAYANMS_BACKUP_AGE_RECIPIENT      — age public key (required)
#   FAYANMS_BACKUP_INTERVAL_SECONDS   — schedule (default 21600)
#   FAYANMS_BACKUP_RETENTION_DAYS     — retention (default 30)
set -eu

: "${FAYANMS_BACKUP_AGE_RECIPIENT:?FAYANMS_BACKUP_AGE_RECIPIENT is required — refuse-plaintext is non-negotiable}"
command -v age >/dev/null 2>&1 || { echo "[backup] age not found in image" >&2; exit 1; }
command -v pg_dump >/dev/null 2>&1 || { echo "[backup] pg_dump not found in image" >&2; exit 1; }

INTERVAL="${FAYANMS_BACKUP_INTERVAL_SECONDS:-21600}"
RETENTION_DAYS="${FAYANMS_BACKUP_RETENTION_DAYS:-30}"
case "$INTERVAL" in
  ''|*[!0-9]*) echo "[backup] FAYANMS_BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1 ;;
esac
[ "$INTERVAL" -ge 300 ] || { echo "[backup] refusing intervals under 300s (accidental hot-loop guard)" >&2; exit 1; }

umask 077
BACKUP_DIR=/backups
mkdir -p "$BACKUP_DIR"

echo "[backup] scheduled encrypted backups every ${INTERVAL}s (retention ${RETENTION_DAYS}d)"

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  # The plaintext dump exists ONLY inside the pipe (pg_dump stdout → age).
  # pg_dump connects over the compose backend network as the fayanms user.
  if pg_dump --format=custom --no-owner --no-acl -h postgres -U fayanms -d fayanms \
      | age --recipient "$FAYANMS_BACKUP_AGE_RECIPIENT" \
            --output "$BACKUP_DIR/fayanms-$stamp.sql.age"; then
    chmod 0600 "$BACKUP_DIR/fayanms-$stamp.sql.age"
    sha256sum "$BACKUP_DIR/fayanms-$stamp.sql.age" > "$BACKUP_DIR/fayanms-$stamp.sql.age.sha256"
    chmod 0600 "$BACKUP_DIR/fayanms-$stamp.sql.age.sha256"
    echo "[backup] encrypted backup written: fayanms-$stamp.sql.age"
  else
    # A failed backup must be VISIBLE (operator alerting keys off the
    # container's non-zero log signal), but it must never stop the
    # schedule — the next interval retries.
    echo "[backup] FAILED at $stamp — will retry next interval" >&2
  fi

  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age.sha256' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

  sleep "$INTERVAL"
done
