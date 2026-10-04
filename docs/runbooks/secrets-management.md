# Cloud secret-management runbook

## Rules

- No PAT, OCI API key, SSH private key, database password, SNMP community, device password, webhook secret, encryption key, or production backup belongs in Git.
- The rule above targets REAL credentials. The demo personas embed invented, banner-labeled placeholder values (e.g. the FayaRO / FayaR0c / faya-readonly SNMP communities and the fake password hashes in the simulator adapters, ZTP templates and LIVE_SSH certification harnesses — each file carries a `⚠ DEMO DATA` banner). They are not real secrets; a grep-guard test (`tests/audit/open-findings-batch-19.test.ts`, F-045) fails if a community-looking string appears in runtime code outside those documented files.
- The OCI host .env is mode 600 and is not copied into logs, support bundles, images, or issue comments.
- Device credentials remain worker-side and are referenced by secretRef.
- GHCR pull credentials are package-read only.
- GitHub Actions uses GITHUB_TOKEN with the smallest job permissions; long-lived repository-admin PATs are prohibited.
- Rotate any credential that was pasted into chat or a public/private repository, even if the message later disappears.

## Host secret layout

Store service secrets in /opt/fayanms/.env, owned by root or the dedicated service account and mode 600. Use a secure secret manager or encrypted operator transfer for the source material. Keep separate values for staging and production.

## Rotation

1. Create the replacement in the approved secret manager.
2. Validate the new value shape without printing it.
3. Update the host environment during a maintenance window.
4. Restart only the affected service.
5. Run deploy/health and authentication/change smoke tests.
6. Revoke the old value.
7. Record the rotation ID and evidence without the value.

## External owner action

The audit reports a previously exposed GitHub PAT. Revoke it and create a least-privilege replacement outside this repository. This item is BLOCKED — EXTERNAL until the owner confirms revocation.
