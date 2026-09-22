# OCI deployment runbook

1. Confirm the source SHA has green gate, e2e, browser, scan, ARM64, and container-image evidence.
2. Confirm the protected staging approval is present.
3. Confirm /opt/fayanms/.env is mode 600 and all three image references end with the same full SHA.
4. Confirm backup status and migration compatibility.
5. Run /opt/fayanms/deploy.sh <full-commit-sha>.
6. Run /opt/fayanms/health-check.sh.
7. Record image digests, migration version, health output, timestamp, CI run, and smoke evidence without secrets.

The script fails closed on mutable/mismatched image tags, missing secrets, missing migration image, or failed health. It does not use db push or rebuild source on the staging host.
