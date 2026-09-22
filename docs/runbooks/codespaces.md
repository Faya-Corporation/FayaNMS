# FayaNMS Codespaces Runbook

## Purpose

This runbook defines the reproducible development environment for FayaNMS. It uses a dedicated PostgreSQL 16 service with non-production credentials and never imports production data or device secrets.

## Create a Codespace

1. Open the FayaNMS repository in GitHub.
2. Create a Codespace from branch codex/fayanms-cloud-platform or the target development branch.
3. Wait for the devcontainer build and the post-create bootstrap to finish.
4. Confirm the terminal is in /workspaces/FayaNMS.

The devcontainer uses Bun 1.3.14, Git, GitHub CLI, Prisma/PostgreSQL clients, SSH client tools, jq, curl, and safe network diagnostics.

## Verify bootstrap

~~~bash
bun --version
bun run db:generate
bunx prisma migrate status
pg_isready -d "$DATABASE_URL"
~~~

The bootstrap runs bun install --frozen-lockfile, installs the worker lockfile, generates Prisma client, and applies committed migrations with prisma migrate deploy. It never runs reset, db push --accept-data-loss, or a production seed.

## Run the application

~~~bash
bun run dev
~~~

The web application is forwarded on port 3000. The worker can be started separately:

~~~bash
bun mini-services/worker/index.ts
~~~

The worker's local HTTP surface is port 3030 and is not a production ingress.

## Database access

The Codespaces database is available inside the compose network as postgres:5432 and from the forwarded workspace as localhost:5433.

~~~bash
psql "$DATABASE_URL"
bunx prisma studio
~~~

The database volume is named fayanms-codespaces-pgdata. It is development-only. Do not copy it to staging or production.

## Environment variables

Use a local untracked .env file only when a feature requires additional values. Keep the values non-production and use .env.example as the shape reference. Never place device passwords, SNMP communities, VPN keys, cloud credentials, GitHub PATs, or production database URLs in Codespaces files.

The Codespaces compose service supplies safe development defaults for DATABASE_URL, NextAuth, service identity, and configuration encryption. Replace them only with additional throwaway development values.

## Rebuild and recovery

Use the Command Palette action Dev Containers: Rebuild and Reopen in Container after changing the devcontainer files.

If dependencies are stale:

~~~bash
rm -rf node_modules mini-services/worker/node_modules
bun install --frozen-lockfile
(cd mini-services/worker && bun install --frozen-lockfile)
bun run db:generate
bun run db:deploy
~~~

Do not delete the PostgreSQL volume as a first response. If the local schema is intentionally disposable, stop the Codespace compose stack and remove only the fayanms-codespaces-pgdata volume through the Docker/Dev Containers UI, then rebuild. Never run a destructive reset against staging or production.

## Troubleshooting

- PostgreSQL is unhealthy: inspect the postgres service logs and confirm port 5433 is not occupied.
- Prisma cannot connect: confirm DATABASE_URL points to postgres:5432 inside the workspace container, not a production URL.
- Worker dependencies fail: run the worker install from mini-services/worker and preserve its lockfile.
- Port 3000 is busy: stop the previous dev process and restart; do not expose the app directly to the public internet.
- Browser tests need CI-equivalent setup: use the repository browser runbook and never point them at a production device network.
