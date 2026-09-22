#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME=${FAYANMS_LAB_NETWORK:-fayanms-lab}
SUBNET=${FAYANMS_LAB_SUBNET:-172.31.240.0/24}

command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Lab network already exists: $NETWORK_NAME"
  exit 0
fi

# The lab network is internal-only. It has no host-published protocol ports.
docker network create --internal --driver bridge --subnet "$SUBNET" "$NETWORK_NAME" >/dev/null
echo "Created isolated internal lab network $NETWORK_NAME ($SUBNET)."
