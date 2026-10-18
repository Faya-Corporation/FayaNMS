#!/bin/sh
# GA-6 (P0-R03) — scheduled encrypted-backup sidecar entrypoint.
# FNM-2026-101/103 (2026-10-18 re-audit) — pipeline-honesty rewrite:
#   BOTH pipeline exit statuses are collected (POSIX sh pipelines report
#   only the LAST command; `set -e` does not supply pipefail), output is
#   written to a partial file and promoted ATOMICALLY only after both
#   statuses are 0 and the artifact is non-trivially sized, and every
#   attempt updates a machine-readable health state file so alerting can
#   fire on consecutive failures without scraping logs.
#
# Contract (mirrors deploy/oci/backup.sh — the host-cron path):
#   - FAIL-CLOSED: refuses to start without FAYANMS_BACKUP_AGE_RECIPIENT —
#     plaintext database backups are never acceptable;
#   - umask 077: every artifact is owner-only even if it ever touched disk;
#   - custom-format pg_dump over the internal backend network (--format=custom,
#     --no-owner, --no-acl — identical flags to backup.sh), streamed to age;
#     the plaintext dump exists ONLY inside the pipe — never on disk;
#   - checksum sidecar (sha256) per promoted backup, retention identical
#     to backup.sh; partial files are never promoted and never counted;
#   - deterministic schedule: sleep-loop (no cron dependency) — first run
#     starts immediately, then every FAYANMS_BACKUP_INTERVAL_SECONDS
#     (default 6h = 21600s).
#
# Content-validation honesty note (FNM-2026-101 acceptance): this sidecar
# holds ONLY the age RECIPIENT (public key) by design — the decrypting
# identity never lives in the backup container — so a byte-level
# `pg_restore --list` validation cannot run here. The in-container
# validation is therefore: both exit statuses + non-trivial artifact size.
# The authoritative content validation is the restore drill
# (deploy/oci/restore-drill.sh: age -d + pg_restore --list + restore)
# run against an isolated target — see docs/runbooks/disaster-recovery.md.
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

# Minimum plausible size for a custom-format dump (header + catalog data).
# A "successful" age encryption of an EMPTY pg_dump stream is the exact
# false-success shape FNM-2026-101 describes; 512 bytes is far below any
# real schema-bearing dump yet above the empty-stream artifact.
MIN_ARTIFACT_BYTES=512

# Machine-readable health state (FNM-2026-103 acceptance): alerting reads
# THIS file — not log scrapes. last_result / consecutive_failures /
# last_stamp / last_exit_detail. 0600 (umask), on the backups volume.
HEALTH_STATE="$BACKUP_DIR/backup-health.state"
CONSECUTIVE_FAILURES=0

record_success() {
  CONSECUTIVE_FAILURES=0
  {
    echo "last_result=SUCCESS"
    echo "consecutive_failures=0"
    echo "last_stamp=$1"
    echo "last_exit_detail=pg_dump=0 age=0"
  } > "$HEALTH_STATE"
  chmod 0600 "$HEALTH_STATE"
}

record_failure() {
  CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
  {
    echo "last_result=FAILED"
    echo "consecutive_failures=$CONSECUTIVE_FAILURES"
    echo "last_stamp=$1"
    echo "last_exit_detail=$2"
  } > "$HEALTH_STATE"
  chmod 0600 "$HEALTH_STATE"
}

echo "[backup] scheduled encrypted backups every ${INTERVAL}s (retention ${RETENTION_DAYS}d)"

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  partial="$BACKUP_DIR/.partial-fayanms-$stamp.sql.age"
  final="$BACKUP_DIR/fayanms-$stamp.sql.age"

  # FNM-2026-101 — collect BOTH pipeline statuses. The left side runs in a
  # subshell with -e disabled that ALWAYS records pg_dump's exit status to
  # a file (127 sentinel if the file never appears — subshell killed or
  # pg_dump not executable). The right side (age) is judged by the
  # pipeline's own status, captured immediately after.
  # The plaintext dump still exists ONLY inside the pipe.
  ( set +e; pg_dump --format=custom --no-owner --no-acl \
        -h postgres -U fayanms -d fayanms; \
    echo $? > "$BACKUP_DIR/.pgstatus-$stamp" ) \
    | age --recipient "$FAYANMS_BACKUP_AGE_RECIPIENT" --output "$partial"
  age_status=$?
  pg_status="$(cat "$BACKUP_DIR/.pgstatus-$stamp" 2>/dev/null || echo 127)"
  rm -f "$BACKUP_DIR/.pgstatus-$stamp"

  artifact_bytes="$(wc -c < "$partial" 2>/dev/null || echo 0)"

  if [ "$pg_status" -eq 0 ] && [ "$age_status" -eq 0 ] && [ "$artifact_bytes" -ge "$MIN_ARTIFACT_BYTES" ]; then
    # Promote ATOMICALLY (same-directory rename — never a partial under
    # the final name) and only then attach the checksum sidecar.
    mv -f "$partial" "$final"
    chmod 0600 "$final"
    sha256sum "$final" > "$final.sha256"
    chmod 0600 "$final.sha256"
    record_success "$stamp"
    echo "[backup] encrypted backup written: fayanms-$stamp.sql.age ($artifact_bytes bytes)"
  else
    rm -f "$partial"
    record_failure "$stamp" "pg_dump=$pg_status age=$age_status bytes=$artifact_bytes"
    echo "[backup] FAILED at $stamp (pg_dump=$pg_status age=$age_status bytes=$artifact_bytes consecutive=$CONSECUTIVE_FAILURES) — will retry next interval" >&2
  fi

  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age.sha256' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  # Stale partials from a crashed run (kill -9 between write and sweep):
  # only partial files older than a day are removed, so a concurrent-run
  # race stays impossible (this loop is the sole writer).
  find "$BACKUP_DIR" -type f -name '.partial-fayanms-*.sql.age' -mtime +0 -delete 2>/dev/null || true

  sleep "$INTERVAL"
done
