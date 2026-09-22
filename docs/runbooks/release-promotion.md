# Release promotion runbook

Create and retain the candidate's machine-readable evidence bundle using [`release-evidence.md`](release-evidence.md) before promotion.

## Development to staging

~~~text
feature branch
  -> pull request
  -> gate + e2e + browser + scan + ARM64
  -> review and merge
  -> exact main SHA CI
  -> app/worker/migrator GHCR images tagged with that SHA
  -> protected staging approval
  -> deploy.sh <full-sha>
  -> health-check.sh
  -> smoke and backup evidence
~~~

The staging host must pull the published image tag for the exact tested SHA. It must not rebuild from source or use latest/staging as the deployment reference.

## Production decision

Production requires a separate approval record with:

- exact source SHA and all image digests;
- green required checks;
- backup/PITR verification;
- staging burn-in;
- hardware/protocol certification;
- security/IAM/SoD evidence;
- rollback decision and compatible migration plan;
- owner change authorization.

FayaNMS remains BLOCKED for enterprise production until the authoritative reports' P0/P1 evidence is complete. This infrastructure work does not change that product decision.
