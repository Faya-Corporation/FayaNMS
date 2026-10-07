# FayaNMS — Operations (Linux · Windows · Docker)

One operator surface for every environment. Fresh clone → running system in
four commands, on any OS, with or without Docker.

| Platform | Entry point | Notes |
|---|---|---|
| Linux / macOS | `ops/ops.sh` | bash; embedded PostgreSQL (Zonky 16.4.0, no root) auto-provisions |
| Windows | `ops\ops.bat` | dispatches to `ops/ops.ps1` (pwsh preferred, PowerShell 5.1 fallback); PostgreSQL via Docker |
| Docker (any OS) | `db:up:docker` + `docker:*` | dev DB via `ops/docker-compose.dev.yml`; full stack via `deploy/oci/compose.yml` |

## Fresh installation

### Linux / macOS

```bash
bash ops/ops.sh install        # root + worker deps, Prisma client
bash ops/ops.sh db:up          # embedded PostgreSQL 16.4 on 127.0.0.1:5433
bash ops/ops.sh migrate        # replay the committed migration history
bash ops/ops.sh seed           # idempotent demo seed
bash ops/ops.sh dev            # app :3000 + worker :3030 (Ctrl-C stops both)
```

### Windows

```bat
ops\ops.bat install
ops\ops.bat db:up:docker       :: embedded PG is Linux-only — Docker covers Windows
ops\ops.bat migrate
ops\ops.bat seed
ops\ops.bat dev
```

### Docker (dev database only, any OS)

```bash
bash ops/ops.sh db:up:docker   # same 127.0.0.1:5433 endpoint + URL as embedded
```

### Docker (full production-grade stack)

The full stack uses `deploy/oci/compose.yml` (immutable-image refs, env-file
split per SEC-ENV-001, WAL archiving, backup sidecar). It needs the three
operator env files created once from a secure channel:

```bash
cp deploy/oci/env.example deploy/oci/.env        # then edit secrets
cp deploy/oci/env.example deploy/oci/.env.app    # app-zone subset
cp deploy/oci/env.example deploy/oci/.env.worker # worker-zone subset
bash ops/ops.sh docker:build                     # optional: local fayanms-local:* images
bash ops/ops.sh docker:up                        # validates env files, then compose up
bash ops/ops.sh health
```

## Command surface

Identical on both platforms (pinned by `tests/audit/ga9-ops-scripts.test.ts`):

| Command | What it does |
|---|---|
| `help` | list every command |
| `doctor` | validate prerequisites (bun / docker / curl / pg / node_modules / .env) |
| `install` | root + worker `bun install`, `prisma generate` |
| `db:up` | embedded PostgreSQL 16.4 dev cluster on :5433 (Linux; auto-provisions) |
| `db:up:docker` | dev PostgreSQL via Docker (any OS; same endpoint + URL) |
| `db:down` | stop dev DB (native and/or docker) |
| `migrate` | `prisma migrate deploy` |
| `seed` | idempotent demo seed |
| `db:reset` | drop + re-migrate + re-seed |
| `dev` | app :3000 + worker :3030 in dev mode (single Ctrl-C stops both) |
| `build` | production standalone build |
| `start` | run the standalone production server |
| `test` / `lint` / `typecheck` | the repo's own gates |
| `keys:service` | EdDSA service keypair for the app/worker plane |
| `health` | probe app `/api/health` + worker `/health` |
| `docker:build` | build app/worker/migrator images locally (`fayanms-local:*`) |
| `docker:up` / `docker:down` / `docker:logs` | operate the production-grade compose stack |
| `backup` / `restore-drill` | DR tooling (bash; Windows → WSL/Git Bash) |
| `release:evidence` | release-evidence manifest for the current HEAD |

## Honest boundaries

- The embedded PostgreSQL ships **Linux binaries only** — Windows routes
  `db:up` to `db:up:docker` automatically.
- `backup` / `restore-drill` wrap the bash DR tooling in `deploy/oci/` —
  on Windows run them through WSL or Git Bash (the PowerShell entry says so
  and exits instead of faking it).
- Dev credentials (`fayanms/fayanms`, trust auth) are local-only and
  bound to `127.0.0.1`. Production credentials come exclusively from the
  operator's env files (`SEC-ENV-001`) — nothing here generates or embeds
  secrets (test-pinned).
- The full Docker stack is the **standard single-host profile** (no infra
  HA) — the GA-READINESS posture for HA profiles is an owner decision
  (`docs/release/GA-READINESS.md`).
