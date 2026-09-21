#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?IMAGE must name the built FayaNMS image}"

NETWORK="fayanms-arm64-smoke"
POSTGRES="fayanms-arm64-smoke-postgres"
APP="fayanms-arm64-smoke-app"
POSTGRES_IMAGE="postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
DB_URL="postgresql://fayanms:fayanms-smoke@postgres:5432/fayanms"
RUN_SECRET="6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03"

cleanup() {
  docker rm -f "$APP" "$POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_USER=fayanms \
  -e POSTGRES_DB=fayanms \
  -e POSTGRES_PASSWORD=fayanms-smoke \
  "$POSTGRES_IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$POSTGRES" pg_isready -U fayanms -d fayanms >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$POSTGRES" pg_isready -U fayanms -d fayanms >/dev/null

docker run -d --name "$APP" --network "$NETWORK" -p 127.0.0.1:34000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="$DB_URL" \
  -e NEXTAUTH_URL=https://fayanms.invalid \
  -e NEXTAUTH_SECRET="$RUN_SECRET" \
  -e FAYANMS_SERVICE_SECRET="$RUN_SECRET" \
  -e FAYANMS_CONFIG_ENC_KEY="$RUN_SECRET" \
  -e FAYANMS_CONFIG_ENC_KEY_ID=ci-smoke \
  -e FAYANMS_DEMO_MODE= \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:34000/ >/dev/null; then
    echo "ARM64 application runtime smoke passed"
    exit 0
  fi
  sleep 2
done

docker logs "$APP" >&2
echo "ARM64 application runtime smoke failed" >&2
exit 1
