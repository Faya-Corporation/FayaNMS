#!/usr/bin/env bash
set -euo pipefail

ROOT=${FAYANMS_ROOT:-/opt/fayanms}
ENV_FILE=${FAYANMS_ENV_FILE:-$ROOT/.env}
COMPOSE_FILE=${FAYANMS_COMPOSE_FILE:-$ROOT/compose.yml}
STATE_DIR=${FAYANMS_STATE_DIR:-$ROOT/state}
HEALTH_SCRIPT=${FAYANMS_HEALTH_SCRIPT:-$ROOT/health-check.sh}

if [[ ${FAYANMS_ROLLBACK_APPROVED:-0} != 1 ]]; then
  echo "Set FAYANMS_ROLLBACK_APPROVED=1 after confirming schema compatibility and backup state." >&2
  exit 2
fi
[[ -f "$STATE_DIR/previous.env" ]] || { echo "No previous deployment state exists." >&2; exit 1; }
[[ -x "$HEALTH_SCRIPT" ]] || { echo "Missing executable health-check.sh" >&2; exit 1; }

cp --preserve=mode "$STATE_DIR/previous.env" "$ENV_FILE"
cd "$ROOT"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull app worker migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres worker app caddy
"$HEALTH_SCRIPT"

printf 'rollback_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATE_DIR/last-rollback"
chmod 0640 "$STATE_DIR/last-rollback"
echo "Rollback completed. PostgreSQL volume was preserved."
