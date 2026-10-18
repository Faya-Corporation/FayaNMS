#!/bin/sh
# GA-6 (P0-R03) — scheduled encrypted-backup sidecar entrypoint.
# FNM-2026-101/103 (2026-10-18 re-audit) — pipeline-honesty rewrite:
#   BOTH pipeline exit statuses are collected (POSIX sh pipelines report
#   only the LAST command; `set -e` does not supply pipefail), output is
#   written to a partial file and promoted ATOMICALLY only after both
#   statuses are 0 and the artifact is non-trivially sized, and every
#   attempt updates a machine-readable health state file so alerting can
#   fire on consecutive failures without scraping logs.
# FNM-2026-107 (2026-10-18 re-audit) — PHYSICAL base backups: the sidecar
#   now also produces `pg_basebackup` tar archives on their own cadence
#   (default 24h), encrypted with the same age recipient. WAL replay /
#   PITR needs a PHYSICAL base — a logical pg_dump cannot seed it — so the
#   shipped recovery chain is now complete: physical base (this file) +
#   archived WAL (fayanms-wal volume) + the restore drill.
#
# Contract (mirrors deploy/oci/backup.sh — the host-cron path):
#   - FAIL-CLOSED: refuses to start without FAYANMS_BACKUP_AGE_RECIPIENT —
#     plaintext database backups are never acceptable;
#   - umask 077: every artifact is owner-only even if it ever touched disk;
#   - custom-format pg_dump over the internal backend network (--format=custom,
#     --no-owner, --no-acl — identical flags to backup.sh), streamed to age;
#     the plaintext dump exists ONLY inside the pipe — never on disk;
#   - pg_basebackup --format=tar --wal-method=fetch streamed to age the same
#     way (fetch because pg_basebackup REFUSES streaming WAL in tar mode to
#     stdout; fetch embeds the WAL in the base tar — correct for restore,
#     and the retry-next-interval loop absorbs a rare WAL-recycle failure);
#   - checksum sidecar (sha256) per promoted artifact; partial files are
#     never promoted and never counted;
#   - deterministic schedule: sleep-loop (no cron dependency) — first run
#     starts immediately, then every FAYANMS_BACKUP_INTERVAL_SECONDS
#     (default 6h = 21600s); physical bases every
#     FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS (default 24h = 86400s,
#     0 = disabled, floor 3600s).
#
# Content-validation honesty note (FNM-2026-101 acceptance): this sidecar
# holds ONLY the age RECIPIENT (public key) by design — the decrypting
# identity never lives in the backup container — so byte-level validation
# (`pg_restore --list` for logical artifacts; tar listing for physical
# bases) cannot run here. The in-container validation is therefore: both
# exit statuses + non-trivial artifact size. The authoritative content
# validation is the restore drill (deploy/oci/restore-drill.sh — logical)
# and the documented physical restore procedure
# (docs/runbooks/disaster-recovery.md) against an isolated target.
#
# Environment (interpolated by compose from the host-side .env):
#   PGPASSWORD                                — the database credential
#   FAYANMS_BACKUP_AGE_RECIPIENT              — age public key (required)
#   FAYANMS_BACKUP_INTERVAL_SECONDS           — logical schedule (default 21600)
#   FAYANMS_BACKUP_RETENTION_DAYS             — logical retention (default 30)
#   FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS  — physical schedule (default 86400, 0 = off)
#   FAYANMS_BACKUP_BASE_RETENTION_DAYS        — physical retention (default 7)
set -eu

: "${FAYANMS_BACKUP_AGE_RECIPIENT:?FAYANMS_BACKUP_AGE_RECIPIENT is required — refuse-plaintext is non-negotiable}"
command -v age >/dev/null 2>&1 || { echo "[backup] age not found in image" >&2; exit 1; }
command -v pg_dump >/dev/null 2>&1 || { echo "[backup] pg_dump not found in image" >&2; exit 1; }
command -v pg_basebackup >/dev/null 2>&1 || { echo "[backup] pg_basebackup not found in image" >&2; exit 1; }

INTERVAL="${FAYANMS_BACKUP_INTERVAL_SECONDS:-21600}"
RETENTION_DAYS="${FAYANMS_BACKUP_RETENTION_DAYS:-30}"
case "$INTERVAL" in
  ''|*[!0-9]*) echo "[backup] FAYANMS_BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1 ;;
esac
[ "$INTERVAL" -ge 300 ] || { echo "[backup] refusing intervals under 300s (accidental hot-loop guard)" >&2; exit 1; }

PHYSICAL_INTERVAL="${FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS:-86400}"
BASE_RETENTION_DAYS="${FAYANMS_BACKUP_BASE_RETENTION_DAYS:-7}"
case "$PHYSICAL_INTERVAL" in
  ''|*[!0-9]*) echo "[backup] FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS must be a non-negative integer" >&2; exit 1 ;;
esac
# 0 disables physical bases (explicit operator choice); otherwise ≥1h.
[ "$PHYSICAL_INTERVAL" -eq 0 ] || [ "$PHYSICAL_INTERVAL" -ge 3600 ] || {
  echo "[backup] refusing physical intervals under 3600s (base backups are heavyweight; 0 disables)" >&2; exit 1;
}

umask 077
BACKUP_DIR=/backups
mkdir -p "$BACKUP_DIR"

# Minimum plausible sizes. A "successful" age encryption of an EMPTY
# stream is the exact false-success shape FNM-2026-101 describes.
MIN_ARTIFACT_BYTES=512        # custom-format logical dump floor
MIN_BASE_BYTES=1048576        # a physical base tar of any real cluster is MBs; 1 MiB floor

# Machine-readable health state (FNM-2026-103 acceptance): alerting reads
# THIS file — not log scrapes. Both planes (logical + physical) report
# their own last_result / consecutive_failures / last_stamp / detail.
HEALTH_STATE="$BACKUP_DIR/backup-health.state"
LOGICAL_FAILS=0
PHYS_FAILS=0
LAST_LOGICAL_RESULT="never"
LAST_LOGICAL_STAMP="-"
LAST_LOGICAL_DETAIL="-"
LAST_PHYS_RESULT="never"
LAST_PHYS_STAMP="-"
LAST_PHYS_DETAIL="-"

write_health_state() {
  {
    echo "logical_last_result=$LAST_LOGICAL_RESULT"
    echo "logical_consecutive_failures=$LOGICAL_FAILS"
    echo "logical_last_stamp=$LAST_LOGICAL_STAMP"
    echo "logical_last_exit_detail=$LAST_LOGICAL_DETAIL"
    echo "physical_last_result=$LAST_PHYS_RESULT"
    echo "physical_consecutive_failures=$PHYS_FAILS"
    echo "physical_last_stamp=$LAST_PHYS_STAMP"
    echo "physical_last_exit_detail=$LAST_PHYS_DETAIL"
  } > "$HEALTH_STATE"
  chmod 0600 "$HEALTH_STATE"
}

record_success() {
  LAST_LOGICAL_RESULT="SUCCESS"
  LOGICAL_FAILS=0
  LAST_LOGICAL_STAMP="$1"
  LAST_LOGICAL_DETAIL="pg_dump=0 age=0"
  write_health_state
  echo "[backup] encrypted backup written: fayanms-$1.sql.age ($2 bytes)"
}

record_failure() {
  LAST_LOGICAL_RESULT="FAILED"
  LOGICAL_FAILS=$((LOGICAL_FAILS + 1))
  LAST_LOGICAL_STAMP="$1"
  LAST_LOGICAL_DETAIL="$2"
  write_health_state
  echo "[backup] FAILED at $1 ($2 consecutive=$LOGICAL_FAILS) — will retry next interval" >&2
}

record_physical_success() {
  LAST_PHYS_RESULT="SUCCESS"
  PHYS_FAILS=0
  LAST_PHYS_STAMP="$1"
  LAST_PHYS_DETAIL="pg_basebackup=0 age=0"
  write_health_state
  echo "[backup] encrypted PHYSICAL base written: fayanms-base-$1.tar.age ($2 bytes)"
}

record_physical_failure() {
  LAST_PHYS_RESULT="FAILED"
  PHYS_FAILS=$((PHYS_FAILS + 1))
  LAST_PHYS_STAMP="$1"
  LAST_PHYS_DETAIL="$2"
  write_health_state
  echo "[backup] PHYSICAL base FAILED at $1 ($2 consecutive=$PHYS_FAILS) — will retry next interval" >&2
}

echo "[backup] scheduled encrypted backups every ${INTERVAL}s (retention ${RETENTION_DAYS}d)"
if [ "$PHYSICAL_INTERVAL" -eq 0 ]; then
  echo "[backup] physical base backups DISABLED (FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS=0) — PITR chain requires them; document the operator-provided alternative"
else
  echo "[backup] physical base backups every ${PHYSICAL_INTERVAL}s (retention ${BASE_RETENTION_DAYS}d)"
fi

next_physical_at=0  # first cycle runs a physical base immediately (when enabled)

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"

  #
  # ── Logical (custom-format dump) — every cycle ──────────────────────────
  #
  partial="$BACKUP_DIR/.partial-fayanms-$stamp.sql.age"
  final="$BACKUP_DIR/fayanms-$stamp.sql.age"

  # FNM-2026-101 — collect BOTH pipeline statuses. The left side runs in a
  # subshell with -e disabled that ALWAYS records pg_dump's exit status to
  # a file (127 sentinel if the file never appears). The right side (age)
  # is judged by the pipeline's own status, captured immediately after.
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
    record_success "$stamp" "$artifact_bytes"
  else
    rm -f "$partial"
    record_failure "$stamp" "pg_dump=$pg_status age=$age_status bytes=$artifact_bytes"
  fi

  #
  # ── Physical (pg_basebackup tar) — on its own cadence ───────────────────
  # FNM-2026-107: WAL replay / PITR needs a PHYSICAL base; a logical dump
  # cannot seed it. Same dual-status + partial + atomic-promotion contract.
  # --wal-method=fetch embeds the WAL in the base tar (pg_basebackup
  # refuses `stream` in tar mode to stdout); a rare WAL-recycle failure is
  # absorbed by the retry-next-interval loop and surfaced in health state.
  #
  if [ "$PHYSICAL_INTERVAL" -ne 0 ] && [ "$(date -u +%s)" -ge "$next_physical_at" ]; then
    pstamp="$(date -u +%Y%m%dT%H%M%SZ)"
    ppartial="$BACKUP_DIR/.partial-fayanms-base-$pstamp.tar.age"
    pfinal="$BACKUP_DIR/fayanms-base-$pstamp.tar.age"

    ( set +e; pg_basebackup --format=tar --wal-method=fetch --checkpoint=fast \
          --no-password -h postgres -U fayanms -D -; \
      echo $? > "$BACKUP_DIR/.pgstatus-base-$pstamp" ) \
      | age --recipient "$FAYANMS_BACKUP_AGE_RECIPIENT" --output "$ppartial"
    age_status=$?
    base_status="$(cat "$BACKUP_DIR/.pgstatus-base-$pstamp" 2>/dev/null || echo 127)"
    rm -f "$BACKUP_DIR/.pgstatus-base-$pstamp"

    base_bytes="$(wc -c < "$ppartial" 2>/dev/null || echo 0)"

    if [ "$base_status" -eq 0 ] && [ "$age_status" -eq 0 ] && [ "$base_bytes" -ge "$MIN_BASE_BYTES" ]; then
      mv -f "$ppartial" "$pfinal"
      chmod 0600 "$pfinal"
      sha256sum "$pfinal" > "$pfinal.sha256"
      chmod 0600 "$pfinal.sha256"
      record_physical_success "$pstamp" "$base_bytes"
    else
      rm -f "$ppartial"
      record_physical_failure "$pstamp" "pg_basebackup=$base_status age=$age_status bytes=$base_bytes"
    fi
    next_physical_at=$(( $(date -u +%s) + PHYSICAL_INTERVAL ))
  fi

  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name 'fayanms-*.sql.age.sha256' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name 'fayanms-base-*.tar.age' -mtime +"$BASE_RETENTION_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name 'fayanms-base-*.tar.age.sha256' -mtime +"$BASE_RETENTION_DAYS" -delete 2>/dev/null || true
  # Stale partials from a crashed run (kill -9 between write and sweep):
  # only partial files older than a day are removed, so a concurrent-run
  # race stays impossible (this loop is the sole writer).
  find "$BACKUP_DIR" -type f -name '.partial-fayanms-*.sql.age' -mtime +0 -delete 2>/dev/null || true
  find "$BACKUP_DIR" -type f -name '.partial-fayanms-base-*.tar.age' -mtime +0 -delete 2>/dev/null || true

  sleep "$INTERVAL"
done
