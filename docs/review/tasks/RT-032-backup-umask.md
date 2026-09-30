# RT-032 — backup.sh: plaintext dump must never be group/other-readable (umask 077)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-062 | A5-10 | P3 | S | Low — script-only hardening; no behavior change on success paths |

## Problem & evidence

`deploy/oci/backup.sh:21-30`:
```bash
plain="$BACKUP_DIR/fayanms-$stamp.sql"
...
docker compose ... pg_dump ... >"$plain"
age --recipient "$AGE_RECIPIENT" --output "$encrypted" "$plain"
rm -f "$plain"
```
A plaintext full-DB dump sits on disk in `$BACKUP_DIR` until age finishes, created with the invoking shell's default umask (typically 022 → mode 0644 = world-readable) rather than 0600. The fail-closed gates around it (age recipient required, plaintext refused — lines 11-12) are good; the file mode is the residual.

## Impact

Brief window where the entire database content is readable by any local user/process on the OCI host.

## Root cause

No umask pin and no explicit chmod on the plaintext file.

## Required change

`deploy/oci/backup.sh`:
1. Add `umask 077` immediately after `set -euo pipefail` (line 2) — covers the dump, the `.age` output, and the `.sha256` sidecar (currently `chmod 0640` on line 31; with umask 077 that chmod still applies explicitly — keep it, or relax to 0600 for consistency; choose: keep line 31 as-is but ALSO change it to `chmod 0600 "$encrypted"` so every artifact the script produces is owner-only. Document the choice in a comment).
2. Defense-in-depth (small, same PR): write the dump through a `mktemp` file inside the 0750 dir — actually `install -d -m 0750` (line 19) already constrains the DIRECTORY; with umask 077 the file is 0600. The mktemp alternative is unnecessary once umask is pinned — skip it (note in PR why).
3. Verify no other artifact escapes the umask: `sha256sum "$encrypted" >"$encrypted.sha256"` (line 34) — with umask 077 the sidecar is 0600; the checksum file contains no secret, so that is fine (mention it).

## Tests to add

File: `tests/audit/rt032-backup-umask.test.ts` (script police, style of `tests/audit/drill-restore.test.ts`).

1. `script pins umask 077` — source assertion: `umask 077` present before any file creation in `deploy/oci/backup.sh`.
2. `every produced artifact is owner-only` — static check: no `chmod` looser than 0600 remains (line 31 becomes 0600; no 0644 anywhere in the script).
3. `behavioral smoke (local)` — run the mode-relevant fragment in a sandbox temp dir: `umask 077; : > out.sql; stat -c %a out.sql` → `600` (bash-level assertion inside the test via Bun's `Bun.spawnSync`), skipped cleanly where bash is unavailable.
4. `gates unchanged` — age-recipient-required and plaintext-refusal lines (11-12) still present (regression guard on the fail-closed behavior).

## Acceptance criteria

- [ ] The plaintext dump, encrypted output, and sidecar are owner-only (0600) regardless of the operator's umask.
- [ ] Existing fail-closed behavior (recipient gate, no-plaintext) unchanged.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt032-backup-umask.test.ts   # new suite green
bun test tests/audit/drill-restore.test.ts         # DR peers green
bun test tests/                                    # no regressions
node_modules/typescript/bin/tsc --noEmit           # exit 0
bun run lint                                       # 0 errors
```

## Rollout & rollback notes

Host-script-only; takes effect on the next backup run. Rollback = revert. No restore-path impact (age decryption is mode-agnostic; restore-drill reads via identity file).


## Status

Fixed (08d981e)
