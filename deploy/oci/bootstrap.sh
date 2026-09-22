#!/usr/bin/env bash
set -euo pipefail

# Run as root on a fresh Ubuntu ARM64 OCI host. This script prepares the
# filesystem and validates prerequisites; it does not create cloud resources,
# fetch credentials, or open network ports.

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root or through sudo." >&2
  exit 1
fi

install -d -m 0750 -o root -g root /opt/fayanms
install -d -m 0750 -o root -g root /opt/fayanms/data
install -d -m 0750 -o root -g root /opt/fayanms/backups
install -d -m 0750 -o root -g root /opt/fayanms/logs
install -d -m 0750 -o root -g root /opt/fayanms/state

command -v docker >/dev/null || {
  echo "Docker Engine is missing. Install the owner-approved pinned Docker version first." >&2
  exit 1
}
docker compose version >/dev/null || {
  echo "Docker Compose plugin is missing." >&2
  exit 1
}
command -v curl >/dev/null || {
  echo "curl is required for health checks." >&2
  exit 1
}

if [[ ! -f /opt/fayanms/.env ]]; then
  echo "Create /opt/fayanms/.env from deploy/oci/env.example using a secure channel." >&2
  exit 1
fi
mode=$(stat -c '%a' /opt/fayanms/.env)
if [[ "$mode" != "600" ]]; then
  echo "/opt/fayanms/.env must be mode 600; current mode is $mode." >&2
  exit 1
fi

hostnamectl set-hostname fayanms-staging-01
timedatectl set-timezone UTC
systemctl enable --now systemd-timesyncd 2>/dev/null || true

echo "Host filesystem and prerequisite checks passed."
