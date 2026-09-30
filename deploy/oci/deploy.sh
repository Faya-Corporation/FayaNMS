#!/usr/bin/env bash
set -euo pipefail

VERSION=${1:-}
ROOT=${FAYANMS_ROOT:-/opt/fayanms}
ENV_FILE=${FAYANMS_ENV_FILE:-$ROOT/.env}
COMPOSE_FILE=${FAYANMS_COMPOSE_FILE:-$ROOT/compose.yml}
STATE_DIR=${FAYANMS_STATE_DIR:-$ROOT/state}
HEALTH_SCRIPT=${FAYANMS_HEALTH_SCRIPT:-$ROOT/health-check.sh}

if [[ ! "$VERSION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <full-commit-sha>" >&2
  exit 2
fi
[[ -r "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
# RT-006 (SEC-ENV-001): the stack no longer mounts a monolithic .env into the
# containers — app and worker read per-zone files (compose.yml env_file).
# Refuse a stale host layout BEFORE `docker compose up` can half-boot it.
for split_file in .env.app .env.worker; do
  [[ -r "$ROOT/$split_file" ]] || {
    echo "Missing $ROOT/$split_file — create it from deploy/oci/env.example (SEC-ENV-001 least-privilege env split) and chmod 600 it before deploying." >&2
    exit 1
  }
done
[[ -x "$HEALTH_SCRIPT" ]] || { echo "Missing executable health-check.sh" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${FAYANMS_IMAGE:?FAYANMS_IMAGE is required}"
: "${FAYANMS_WORKER_IMAGE:?FAYANMS_WORKER_IMAGE is required}"
: "${FAYANMS_MIGRATOR_IMAGE:?FAYANMS_MIGRATOR_IMAGE is required}"

for image in "$FAYANMS_IMAGE" "$FAYANMS_WORKER_IMAGE" "$FAYANMS_MIGRATOR_IMAGE"; do
  [[ "$image" == *":$VERSION" ]] || {
    echo "Refusing non-matching image reference: $image (expected tag $VERSION)" >&2
    exit 1
  }
done

install -d -m 0750 "$STATE_DIR"
if [[ -f "$STATE_DIR/current.env" ]]; then
  cp --preserve=mode "$STATE_DIR/current.env" "$STATE_DIR/previous.env"
fi
cp --preserve=mode "$ENV_FILE" "$STATE_DIR/current.env"

cd "$ROOT"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull app worker migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres worker app caddy
"$HEALTH_SCRIPT"

printf 'deployed_sha=%s\n' "$VERSION" >"$STATE_DIR/last-deploy"
printf 'deployed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$STATE_DIR/last-deploy"
chmod 0640 "$STATE_DIR/last-deploy"
echo "Deployment completed for $VERSION."
