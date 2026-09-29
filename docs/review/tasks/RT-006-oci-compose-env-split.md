# RT-006 — OCI compose: per-service env files (least privilege, SEC-ENV-001 zone split)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-007 | A5-01 | P1 | M | Medium — deploy-facing config change; a mistake can break staging boot (missing var), so the RT includes an explicit operator migration step |

## Problem & evidence

`deploy/oci/compose.yml` mounts the monolithic host `.env` into every service via `env_file: .env`:
- line 7 (`postgres`), line 38 (`migrate`), line 61 (`app`), line 102 (`worker`), line 138 (`caddy`).

The host `.env` (`deploy/oci/env.example`) intentionally holds ALL secrets (NEXTAUTH_SECRET, FAYANMS_CONFIG_ENC_KEY KEK, POSTGRES_PASSWORD, DATABASE_URL, worker keypairs, vault refs). With `env_file: .env` everywhere:
- the **worker** receives the KEK + session secret + DB password (its own boot guard `identity-boot.ts` / `warnWorkerSecretScope` only WARNs today, "refuses after the deprecation window" — so this also breaks at the end of that window);
- **postgres** and **caddy** receive every app secret (a caddy/pg compromise yields the config-encryption KEK);
- violates the repo's own SEC-ENV-001 zone split already implemented in the root `compose.yml:22-37` and documented in `docs/deploy/env.app.production.example` / `env.worker.production.example`.

## Impact

Container compromise of the least-privileged services (caddy, postgres) or the worker exposes the app's crown-jewel secrets (KEK = every config-snapshot backup decryptable; NEXTAUTH_SECRET = session forgery). Boot-time policy will refuse out-of-zone variables after the deprecation window, breaking deploys.

## Root cause

The OCI stack predates the SEC-ENV-001 split and was never migrated; `deploy/oci/env.example` still documents the monolithic layout.

## Required change

1. **`deploy/oci/compose.yml`** — remove `env_file: .env` from `postgres` (line 7) and `caddy` (line 138) entirely (both already get what they need via `environment:` interpolation — postgres: lines 8-11; caddy: line 140). For `migrate` (line 38), `app` (line 61), `worker` (line 102) replace with per-service files:
   - `app` → `env_file: .env.app`
   - `worker` → `env_file: .env.worker`
   - `migrate` → NO env_file; it already receives `DATABASE_URL` via `environment:` (line 41) and needs nothing else — delete the `env_file` line (keep `NODE_ENV`).
   - Keep the existing `${VAR:?...}` interpolation lines untouched — compose interpolation reads the HOST-side `--env-file` (.env), which is exactly the documented root-compose pattern (`compose.yml:22-37`).
2. **`deploy/oci/env.example`** — rewrite to the two-file layout with the same host-side interpolation keys it has today, plus clear split comments:
   - Host-side file stays `/opt/fayanms/.env` (interpolation only: image refs, ports, domain, `POSTGRES_PASSWORD`, `DATABASE_URL`, `NEXTAUTH_URL`, `NEXT_PUBLIC_SITE_URL`, `FAYANMS_TLS_DOMAIN`, `GRAFANA_ADMIN_PASSWORD` if monitoring enabled).
   - New `.env.app` block: NEXTAUTH_SECRET, FAYANMS_CONFIG_ENC_KEY(+_ID), service CONTROL keypair (`FAYANMS_SERVICE_PRIVATE_KEY`/`FAYANMS_SERVICE_PUBLIC_KEYS`), legacy `FAYANMS_SERVICE_SECRET`(optional), rate/login knobs — copy the zone contract header from `docs/deploy/env.app.production.example:7-18`.
   - New `.env.worker` block: WORKER keypair + CONTROL public keys, `FAYANMS_VAULT_*`, `FAYANMS_VAULT_PROVIDER`, `FAYANMS_WEBAPI_CA_PEM` — copy the zone contract from `docs/deploy/env.worker.production.example:7-19`.
   - `FAYANMS_METRICS_TOKEN` belongs in `.env.app` (the app's /api/metrics reads it) AND `.env.worker` (worker /api/metrics) — document it in both.
   - Add the migration command block: `cp` snippets + `chmod 600 /opt/fayanms/.env*`.
3. **`deploy/oci/deploy.sh`** (lines ~41-43 reference the env file): verify it only needs the host-side `.env` for interpolation (it does — `--env-file "$ENV_FILE"`); add a fail-fast preflight: `[ -r "$ROOT/.env.app" ] && [ -r "$ROOT/.env.worker" ]` with a pointer to env.example, so a stale host layout refuses BEFORE `docker compose up` half-boots.
4. **`deploy/oci/bootstrap.sh`** — extend its `.env` mode-600 enforcement to `.env.app` / `.env.worker`.
5. **Docs** — one-line update in the deployment runbook (`docs/runbooks/deployment.md`) if it documents the OCI env layout; state that root-owned split files are the required layout.

## Tests to add

File: `tests/audit/oci-compose-env-split.test.ts` (source/YAML-policed, style of `tests/audit/deploy-hardening.test.ts` / `tests/audit/monitoring-compose.test.ts`).

1. `oci compose no longer mounts the monolithic env file` — parse `deploy/oci/compose.yml`; assert NO service has `env_file: .env`; assert `app` → `.env.app`, `worker` → `.env.worker`, `postgres`/`caddy`/`migrate` have no `env_file`.
2. `zone contract holds` — assert the app-zone example keys (NEXTAUTH_SECRET, FAYANMS_CONFIG_ENC_KEY) never appear in the worker-zone block of `deploy/oci/env.example`, and vault keys never appear in the app block (static text assertions on the example file).
3. `interpolation contracts preserved` — assert `${DATABASE_URL:?...}`, `${NEXTAUTH_URL:?...}`, `${POSTGRES_PASSWORD:?...}` required-var interpolations remain in compose (services cannot silently boot with empty secrets).
4. `deploy preflight refuses missing split files` — negative case: run the preflight snippet (or source-assert it exists) with missing `.env.worker` → nonzero exit message.
5. `bootstrap enforces 600 on all three env files`.

## Acceptance criteria

- [ ] No container receives another zone's secrets (worker: no NEXTAUTH_SECRET/KEK/DATABASE_URL; caddy/postgres: no env_file at all).
- [ ] `docker compose --env-file .env config` renders complete per-service environments from the three files (operator checklist item).
- [ ] `deploy.sh` fails fast with a clear message when the split files are missing.
- [ ] env.example documents the migration from the monolithic layout.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass (repo-wide gates unaffected).

## Verification

```bash
bun test tests/audit/oci-compose-env-split.test.ts   # new suite green
bun test tests/audit/deploy-hardening.test.ts         # existing deploy tests still green
bun test tests/                                       # no regressions
node_modules/typescript/bin/tsc --noEmit              # exit 0
bun run lint                                          # 0 errors
# Operator-side (staging) smoke after merge:
docker compose --env-file .env -f deploy/oci/compose.yml config >/dev/null && echo OK
```

## Rollout & rollback notes

Requires a one-time operator action on the host (create `.env.app`/`.env.worker` from the examples, keep `.env` host-side) BEFORE the next deploy; deploy.sh's new preflight enforces the ordering. Rollback = revert compose.yml to `env_file: .env` (old host layout still works until the boot-policy deprecation window closes — that window is exactly why this RT is P1).
