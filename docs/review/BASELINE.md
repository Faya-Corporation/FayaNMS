# Baseline — GLM/full-audit-and-fix (from main @ 38fbdfb)

Recorded: 2026-09-29 (UTC). All commands run in the audit sandbox, repo root `/home/z/faya-nms`.

## Environment

| Tool | Version |
|---|---|
| bun | 1.3.14 |
| node | v24.21.0 |
| typescript (repo-pinned) | run via `node_modules/typescript/bin/tsc` |

## Commands and results (exact)

1. `bun install --frozen-lockfile` → OK, "Checked 590 installs across 680 packages (no changes)"
2. `(cd mini-services/worker && bun install --frozen-lockfile)` → OK (no changes)
3. `bun run lint` (eslint .) → **PASS** (exit 0)
4. `node_modules/typescript/bin/tsc --noEmit` → **PASS** (0 errors, exit 0)
5. `NEXTAUTH_URL=http://localhost:3000 NEXTAUTH_SECRET=$CIK FAYANMS_SERVICE_SECRET=$CIK FAYANMS_CONFIG_ENC_KEY=$CIK bun test tests/` (where `$CIK` is the public demo key from `.github/workflows/ci.yml:114-117` — not a real secret) →
   - **1340 pass / 18 skip / 2 fail** across 1360 tests, 117 files
   - The 2 failures are the pre-existing, environment-dependent `R61 P0-1: credential-free SSH first-contact capture` tests, which require a local `sshd`. They fail identically on `main` without sshd (documented in repo history); NOT caused by this branch.
6. `NEXT_PUBLIC_SITE_URL=https://fayanms.invalid bun run build:gate` → PASS (see verification below; log `/tmp/build.log`).

## Runtime prerequisites (local app run)

- Dev database: PostgreSQL at `localhost:5433` (per `package.json` dev script and `.env.example`). The audit sandbox initially has **no PostgreSQL server installed** (`pg_isready`, `postgres`, `initdb`, `docker`, `podman` all absent; uid 1001, passwordless sudo available). An install attempt is logged in STATE.md; if it fails, UI verification is limited to unauthenticated surfaces and static analysis, per the audit contract.
- SSH first-contact tests need a local `sshd` (not installed in sandbox). Recorded as an environment limitation, not a product defect.

## Known-good reference points

- CI on `main` @ 38fbdfb: gate/e2e/browser/scan all green (run 36609478829); container certification run 36610452209 green (workflow since disabled at repo level by owner request — unrelated to this audit).
- Branch protection on `main`: required checks `gate,e2e,browser,scan`, strict. This branch never pushes to `main`.

## Rule compliance note

No tests, linters, or type checks were disabled, skipped, or weakened for this audit. Baseline failures are environment-dependent (`sshd` absent) and reproducible on `main`.
