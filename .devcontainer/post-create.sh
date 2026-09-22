#!/usr/bin/env bash
set -euo pipefail

cd /workspaces/FayaNMS

: "${DATABASE_URL:?DATABASE_URL must be supplied by the Codespaces compose service}"
case "${DATABASE_URL}" in
  postgres://*|postgresql://*) ;;
  *) echo "Refusing non-PostgreSQL Codespaces DATABASE_URL" >&2; exit 1 ;;
esac

echo "Waiting for PostgreSQL..."
until pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1; do
  sleep 2
done

echo "Installing application dependencies..."
bun install --frozen-lockfile

if [ -f mini-services/worker/package.json ]; then
  echo "Installing worker dependencies..."
  (cd mini-services/worker && bun install --frozen-lockfile)
fi

echo "Generating Prisma client..."
bun run db:generate

echo "Applying committed migrations (non-destructive)..."
bun run db:deploy

echo "Codespaces bootstrap complete."
echo "Start the web app with: bun run dev"
echo "Start the worker with: bun mini-services/worker/index.ts"
