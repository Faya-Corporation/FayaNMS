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
# FNM-2026-102 (2026-10-18 re-audit): the backup sidecar image is part of
# every certified release — refuse an under-specified environment here,
# before compose config -q gets a chance to fail with a bare interpolation
# error.
: "${FAYANMS_BACKUP_IMAGE:?FAYANMS_BACKUP_IMAGE is required (the certified fayanms-backup image, tag sha-<commit>)}"
: "${FAYANMS_BACKUP_AGE_RECIPIENT:?FAYANMS_BACKUP_AGE_RECIPIENT is required — the sidecar refuses plaintext backups}"

for image in "$FAYANMS_IMAGE" "$FAYANMS_WORKER_IMAGE" "$FAYANMS_MIGRATOR_IMAGE" "$FAYANMS_BACKUP_IMAGE"; do
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
# FNM-2026-103 (2026-10-18 re-audit): one-shot volume initialization is part
# of the AUTOMATED path now — a fresh named volume is root-owned; postgres
# (uid 70) could not write WAL archives and the sidecar could not write
# /backups. Both one-shots are idempotent, so running them on every deploy
# is safe; on the first fresh-volume boot they are MANDATORY.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile provision run --rm wal-init
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile provision run --rm backup-init
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull app worker migrate backup
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres backup worker app caddy
"$HEALTH_SCRIPT"

# FNM-2026-103 acceptance: the deploy gate FAILS if WAL archiving is
# misconfigured or the backup sidecar is not actually running — compose
# file presence alone is not evidence the recovery services operate.
archiver_check="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U fayanms -d fayanms -tAc \
  "SELECT coalesce(archived_count,0), coalesce(failed_count,0) FROM pg_stat_archiver")" || {
  echo "pg_stat_archiver unavailable — WAL archiving is not operating" >&2
  exit 1
}
archived="${archiver_check%%|*}"; archived="${archived%% *}"
failed="${archiver_check##*|}"; failed="${failed##* }"
# failed_count > 0 is ALWAYS fatal. archived_count = 0 on a brand-new boot
# can be legitimate (no segment has filled yet) — recorded, not fatal here;
# health-check.sh keeps enforcing it once the first backup interval passes.
if [[ "$failed" != "0" ]]; then
  echo "pg_stat_archiver failed_count=$failed — WAL archiving is FAILING; refusing to call this deployment healthy" >&2
  exit 1
fi
echo "pg_stat_archiver: archived=$archived failed=0"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running backup >/dev/null || {
  echo "backup sidecar is not running — scheduled backups would be silently absent" >&2
  exit 1
}

printf 'deployed_sha=%s\n' "$VERSION" >"$STATE_DIR/last-deploy"
printf 'deployed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$STATE_DIR/last-deploy"
chmod 0640 "$STATE_DIR/last-deploy"
echo "Deployment completed for $VERSION."
