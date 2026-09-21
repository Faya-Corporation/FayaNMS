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

Install age and configure an age recipient outside Git. Run:

~~~bash
sudo FAYANMS_BACKUP_AGE_RECIPIENT='age1...' /opt/fayanms/backup.sh
~~~

The script refuses to create plaintext output, deletes the temporary plaintext dump, writes a checksum, and applies retention to encrypted files. Upload to approved off-host storage only after checksum verification. Do not log the recipient private key or database URL.

## Restore drill

Provision a disposable PostgreSQL target that is not production, then run:

~~~bash
sudo RESTORE_DRILL_APPROVED=1   RESTORE_TARGET_DATABASE_URL='postgresql://...'   FAYANMS_RESTORE_AGE_IDENTITY_FILE=/secure/restore-key.age   /opt/fayanms/restore-drill.sh /opt/fayanms/backups/fayanms-<timestamp>.sql.age
~~~

Record schema migration status, representative row counts, audit-chain verification, application boot, and elapsed time. Never point this command at production unless a separately approved disaster event requires it.

## External blockers

Off-host object storage, key custody, scheduled execution, final RPO/RTO, and a real restore target require OCI/operator access. Until those are demonstrated, database DR remains BLOCKED — EXTERNAL.
