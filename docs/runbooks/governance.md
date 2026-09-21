# Repository governance runbook

## Required main-branch controls

Configure through GitHub owner/admin settings:

- pull requests required;
- at least one appropriate approval and CODEOWNERS review;
- required checks: gate, e2e, browser, scan, and the ARM64 certification workflow;
- conversation resolution;
- no force-push;
- no branch deletion;
- narrow break-glass bypass with audit;
- staging environment approval before deployment.

The repository-side CODEOWNERS and workflow permissions are not enforcement by themselves.

## Verification

After configuration, read back the live branch/ruleset state and record:

- protected/ruleset enabled;
- required check contexts exactly match workflow job names;
- force-push/deletion disabled;
- approval count;
- bypass actors;
- staging environment reviewers.

If the GitHub plan cannot enforce the required private-repository ruleset, status remains BLOCKED — EXTERNAL. Do not change the documentation to claim active enforcement.

## Credential action

Revoke/rotate the previously exposed PAT outside Git and use only least-privilege credentials for any host/operator operation.
