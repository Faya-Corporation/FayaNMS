#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?IMAGE must name the built FayaNMS image}"

NETWORK="fayanms-arm64-smoke"
POSTGRES="fayanms-arm64-smoke-postgres"
APP="fayanms-arm64-smoke-app"
POSTGRES_IMAGE="postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
DB_PASSWORD="$(openssl rand -hex 24)"
DB_URL="postgresql://fayanms:${DB_PASSWORD}@postgres:5432/fayanms"
RUN_SECRET="$(openssl rand -hex 32)"
# GA-6: the production startup policy REFUSES boot without a metrics bearer
# token (the /api/metrics surface would answer unauthenticated) and without
# an honest proxy-hop declaration. This smoke IS a direct-published topology
# (the app port is bound to loopback only), so the honest declaration is
# FAYANMS_TRUST_PROXY_HOPS=0 — every caller shares one conservative bucket.
# Both values are fresh random per run — the deterministic CI fixture values
# are REFUSED by the same policy (P1-019).
METRICS_TOKEN="$(openssl rand -hex 32)"

cleanup() {
  docker rm -f "$APP" "$POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_USER=fayanms \
  -e POSTGRES_DB=fayanms \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
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
  -e FAYANMS_METRICS_TOKEN="$METRICS_TOKEN" \
  -e FAYANMS_TRUST_PROXY_HOPS=0 \
  -e FAYANMS_DEMO_MODE= \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:34000/ >/dev/null; then
    echo "ARM64 application runtime smoke passed"
    # GA-6: the metrics surface must NOT answer unauthenticated in a
    # production posture — a 401 here is part of the certified contract.
    if curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
         http://127.0.0.1:34000/api/metrics | grep -q '^401$'; then
      echo "metrics unauthenticated refusal verified (401 without bearer)"
      exit 0
    fi
    echo "metrics surface did NOT refuse an unauthenticated scrape" >&2
    exit 1
  fi
  sleep 2
done

docker logs "$APP" >&2
echo "ARM64 application runtime smoke failed" >&2
exit 1
