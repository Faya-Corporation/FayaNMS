# Repository governance runbook

## Required main-branch controls

**Enforced now** (API truth, read back by `bun scripts/gov-verify.ts` — the F-025 narrowed contract, 2026-10-02):

- required status checks: gate, e2e, browser, scan (exactly the FOUR ci.yml jobs — the R66 shape);
- branch up-to-date before merge (strict);
- no force-push;
- no branch deletion.

The ARM64 certification workflow (container.yml) is `disabled_manually` — its context is deliberately NOT in the required set. When the workflow is re-enabled (together with RT-017), add its check context back to the required set.

**Owner-pending hardening** (reported as [GAP] by the read-back; F-025 option (a) remains open):

- at least one appropriate approval and CODEOWNERS review;
- conversation resolution;
- linear history;
- enforce admins;
- rulesets on main (plan-gated on this private repository — see the R67 plan blocker).

Configure through GitHub owner/admin settings.

The repository-side CODEOWNERS and workflow permissions are not enforcement by themselves.

## Verification

After configuration, read back the live branch/ruleset state and record:

- protected/ruleset enabled;
- required check contexts exactly match workflow job names;
- force-push/deletion disabled;
- approval count;
- bypass actors;
- staging environment reviewers.

If the GitHub plan cannot enforce the required private-repository ruleset, status remains BLOCKED — EXTERNAL. Do not change the documentation to claim active enforcement. The F-025 narrowed contract keeps this honesty: the read-back reports owner-pending controls as [GAP] lines and never claims them enforced; only the hard invariants (the enforced set above) drive the exit code.

## Credential action

Revoke/rotate the previously exposed PAT outside Git and use only least-privilege credentials for any host/operator operation.
