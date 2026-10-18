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

# FNM-2026-103 (2026-10-18 re-audit): the recovery services are part of the
# health gate — compose-file presence alone is not evidence they operate.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running backup >/dev/null
archiver_check="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U fayanms -d fayanms -tAc \
  "SELECT coalesce(archived_count,0), coalesce(failed_count,0) FROM pg_stat_archiver")"
failed_count="${archiver_check##*|}"; failed_count="${failed_count##* }"
[[ "$failed_count" == "0" ]] || { echo "pg_stat_archiver failed_count=$failed_count — WAL archiving is FAILING" >&2; exit 1; }
echo "pg_stat_archiver: $archiver_check (archived|failed)"

curl --fail --silent --show-error --max-time 15 "https://${FAYANMS_TLS_DOMAIN}/" >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres pg_isready -U fayanms -d fayanms >/dev/null
# RT-028: the app gate uses the READINESS route (/api/health — DB-backed),
# not the marketing root page; r.ok is false on the 503, failing the gate.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T app bun -e 'const r = await fetch("http://127.0.0.1:3000/api/health"); process.exit(r.ok ? 0 : 1)'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T worker bun -e 'const r = await fetch("http://127.0.0.1:3030/health"); process.exit(r.ok ? 0 : 1)'

echo "FayaNMS staging health gate passed."
