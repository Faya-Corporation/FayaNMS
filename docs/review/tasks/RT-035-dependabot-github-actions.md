# RT-035 — dependabot.yml: add the github-actions ecosystem

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-065 | A5-13 | P3 | S | Low — config addition; PR volume is the only side effect |

## Problem & evidence

`.github/dependabot.yml:24-100` (as of audit: the file carries two `package-ecosystem: "bun"` entries only — lines 35+ for `/` and `mini-services/worker`). No `github-actions` ecosystem entry exists.

All third-party actions ARE SHA-pinned (good), but nothing proposes pin updates: SHAs rot silently — e.g. checkout v5, trivy-action 0.36.0, and `returntocorp/semgrep-action` v1 (that upstream repo is ARCHIVED).

## Impact

Workflow action pins age without automation; an archived action (semgrep-action) is a slow-burning supply-chain risk.

## Root cause

Dependabot config written for the two bun manifests only; actions ecosystem never added.

## Required change

1. **`.github/dependabot.yml`** — append a third updates entry:
   ```yaml
   - package-ecosystem: "github-actions"
     directory: "/"
     schedule:
       interval: "weekly"
       day: "monday"
       time: "06:00"
   ```
   (match the existing entries' schedule style and add a comment block explaining scope: "keeps the SHA pins of third-party actions fresh; groups non-security bumps individually; security updates grouped" — mirror the file's existing comment discipline, lines 1-29).
2. Add `groups:`/`open-pull-requests-limit:` consistent with the bun entries if they use them (read the file's existing entries and mirror; keep the diff minimal).
3. Archived-action note (comment only, no workflow change in this RT): add one comment line in dependabot.yml OR the PR body: `returntocorp/semgrep-action` is archived upstream — migration to the `semgrep/semgrep` CLI (like the other pinned binaries) is a separate follow-up (BACKLOG note under A5-13; do NOT change ci.yml's scan job here).
4. `tests/audit/r57-dependabot-config.test.ts` pins the YAML shape (the file header says so, line 29) — read it FIRST; extend it to expect 3 updates entries (the contract is changing deliberately per this RT).

## Tests to add

File: extend `tests/audit/r57-dependabot-config.test.ts` OR new `tests/audit/rt035-dependabot-actions.test.ts` (do whichever keeps the r57 file's intent intact; prefer extending r57 since it already parses this exact file).

1. `github-actions ecosystem present` — parsed YAML contains an updates entry with `package-ecosystem: "github-actions"`, `directory: "/"`, weekly schedule.
2. `existing bun entries untouched` — the two bun entries survive unchanged (regression guard).
3. `schedule/cadence consistent` — the new entry's interval/day/time match the house style (weekly/monday/06:00).
4. Negative case: `no duplicate ecosystem+directory pairs` — the file must not contain two entries for the same (ecosystem, directory).

## Acceptance criteria

- [ ] dependabot.yml carries three ecosystems (bun ×2, github-actions ×1) and still parses.
- [ ] r57 contract test updated and green.
- [ ] Archived-semgrep-action follow-up noted (comment or PR body); NO workflow changes in this RT.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/r57-dependabot-config.test.ts     # updated contract green (or rt035 suite)
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
```

## Rollout & rollback notes

Config-only; Dependabot PRs appear per the existing ACTIVATION CAVEAT (owner CI capacity, file lines 24-29). Rollback = remove the entry. Expect ~1 PR/week of action-bump noise once active — that is the point; group rules keep it reviewable.
