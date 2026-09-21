#!/usr/bin/env bash
set -euo pipefail

ROOT=${FAYANMS_ROOT:-/opt/fayanms}
ENV_FILE=${FAYANMS_ENV_FILE:-$ROOT/.env}
COMPOSE_FILE=${FAYANMS_COMPOSE_FILE:-$ROOT/compose.yml}

[[ -r "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${FAYANMS_TLS_DOMAIN:?FAYANMS_TLS_DOMAIN is required}"
cd "$ROOT"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running app worker postgres caddy >/dev/null

curl --fail --silent --show-error --max-time 15 "https://${FAYANMS_TLS_DOMAIN}/" >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres pg_isready -U fayanms -d fayanms >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T app bun -e 'const r = await fetch("http://127.0.0.1:3000/"); process.exit(r.ok ? 0 : 1)'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T worker bun -e 'const r = await fetch("http://127.0.0.1:3030/health"); process.exit(r.ok ? 0 : 1)'

echo "FayaNMS staging health gate passed."
