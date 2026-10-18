# FayaNMS PostgreSQL backup and disaster recovery

Configuration snapshots are not a substitute for backing up FayaNMS application state. This runbook covers the database and its audit/change history.

## Targets

Set and approve explicit RPO/RTO values before production. The repository defaults are not a production claim.

| Item | Required evidence |
|---|---|
| Backup | encrypted custom-format pg_dump exists and checksum matches |
| Off-host copy | object storage or approved external target contains the encrypted file |
| Restore | restore-drill succeeds against an isolated database |
| Application | app boots against the restored schema and migration history |
| Timing | actual backup and restore durations recorded |
| Retention | lifecycle policy and deletion evidence recorded |

## Backup

Install age and configure an age recipient outside Git. Two equivalent execution paths exist — pick ONE per host and verify whichever is used:

~~~bash
# Host-cron path (runs on the host via docker compose exec):
sudo FAYANMS_BACKUP_AGE_RECIPIENT='age1...' /opt/fayanms/backup.sh

# Compose sidecar path (GA-6, P0-R03): the `backup` service in
# deploy/oci/compose.yml runs the same contract on a schedule
# (FAYANMS_BACKUP_INTERVAL_SECONDS, default 6h) with the plaintext dump
# confined to the pg_dump→age pipe — it refuses to start without an age
# recipient. Build + pin the image first:
#   docker build -t fayanms/backup-sidecar deploy/oci/backup-sidecar
#   docker push → set FAYANMS_BACKUP_IMAGE=<ghcr ref @sha256:...>
~~~

Both paths write `fayanms-<timestamp>.sql.age` plus a `.sha256` sidecar into the backups location, and both apply the same retention policy. Upload to approved off-host storage only after checksum verification. Do not log the recipient private key or database URL.

## Point-in-time recovery (WAL archiving — GA-6, P0-R03)

The compose `postgres` service runs with `wal_level=replica`, `archive_mode=on`, and an `archive_command` that copies every completed WAL segment into the `fayanms-wal` volume (`test ! -f /wal-archive/%f && cp %p /wal-archive/%f` — idempotent, refuses to overwrite). The one-shot `wal-init` service (provision profile) pre-creates the archive directory with postgres ownership; run it once before the first archiving start:

~~~bash
docker compose --env-file .env --profile provision up wal-init
docker compose --env-file .env up -d postgres
# Verify archiving is live (the volume fills with 16MB segments):
docker compose --env-file .env exec postgres ls /wal-archive | head
~~~

**The physical base is now SHIPPED (FNM-2026-107, 2026-10-18 re-audit):** the
backup sidecar produces encrypted `pg_basebackup` tar archives —
`fayanms-base-<timestamp>.tar.age` (+ `.sha256`) — on their own cadence
(`FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS`, default 24h, `0` disables but
then PITR has no chain and the operator must document the alternative).
This closes the gap where WAL archiving existed without a compatible
physical base: a logical `pg_dump` cannot seed WAL replay.

**Restore to a point in time** (disposable target, never production):

~~~bash
# 1. Copy the WAL archive (fayanms-wal volume) and the chosen
#    fayanms-base-<stamp>.tar.age to the isolated target host.
# 2. Decrypt the physical base:
#    age --decrypt --identity /secure/restore-key.age \
#        --output base.tar fayanms-base-<stamp>.tar.age
#    tar -tf base.tar          # content validation (the sidecar only
#                              # sees ciphertext; THIS is the validator)
# 3. Extract into an EMPTY PGDATA (mode 0700, owned by the postgres user):
#    tar -xf base.tar -C /var/lib/postgresql/data --strip-components=0
#    # the tar contains the server files at its root (PG16 tar layout);
#    # remove any stale recovery knobs, then configure recovery:
#    cat >> /var/lib/postgresql/data/postgresql.conf <<'RC'
#    restore_command = 'cp /wal-archive/%f %p'
#    recovery_target_time = '<the instant you must return to>'
#    recovery_target_action = 'promote'
#    RC
#    touch /var/lib/postgresql/data/recovery.signal
# 4. Start the target; PostgreSQL replays archived WAL up to the target
#    and promotes. Verify exactly as a restore drill: migration status,
#    row counts, audit-chain verification, application boot, elapsed
#    time — record all (this IS the drill evidence for RPO/RTO).
~~~

The archived WAL bounds data loss to the segment granularity BETWEEN base backups — RPO is therefore `min(physical base-backup interval, WAL archive completeness)`, and BOTH the WAL volume and the newest `fayanms-base-*.tar.age` must be included in the off-host copy policy. The logical `fayanms-<stamp>.sql.age` artifacts remain the conventional-restore path (`restore-drill.sh`).

## Restore drill

Provision a disposable PostgreSQL target that is not production, then run:

~~~bash
sudo RESTORE_DRILL_APPROVED=1   RESTORE_TARGET_DATABASE_URL='postgresql://...'   FAYANMS_RESTORE_AGE_IDENTITY_FILE=/secure/restore-key.age   /opt/fayanms/restore-drill.sh /opt/fayanms/backups/fayanms-<timestamp>.sql.age
~~~

Record schema migration status, representative row counts, audit-chain verification, application boot, and elapsed time. Never point this command at production unless a separately approved disaster event requires it.

## External blockers

Off-host object storage, age key custody, the real restore target, and final RPO/RTO approval require OCI/operator access — those remain BLOCKED — EXTERNAL. Scheduled execution is NO LONGER an external blocker: the compose `backup` sidecar (or host cron with backup.sh) provides it in-repo, and WAL archiving/PITR configuration ships in compose. Until off-host custody and a real drill on the actual target are demonstrated, database DR overall remains BLOCKED — EXTERNAL.
