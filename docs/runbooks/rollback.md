# OCI rollback runbook

A rollback changes application/worker/migrator images but preserves the PostgreSQL volume. Before running it, confirm:

- the previous.env state exists;
- a current encrypted backup is verified;
- the previous migration is compatible with the current schema;
- the operator has approved the rollback.

Run:

~~~bash
sudo FAYANMS_ROLLBACK_APPROVED=1 /opt/fayanms/rollback.sh
sudo /opt/fayanms/health-check.sh
~~~

If schema compatibility is unknown, stop. Do not force a downgrade or delete the database volume. Open an incident and use the restore-drill/approved recovery process.
