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

# RT-006 (SEC-ENV-001): the host keeps THREE env files — the host-side
# interpolation .env plus the app-zone .env.app and worker-zone .env.worker
# runtime files. All must exist and be mode 600.
for env_file in /opt/fayanms/.env /opt/fayanms/.env.app /opt/fayanms/.env.worker; do
  if [[ ! -f "$env_file" ]]; then
    echo "Create $env_file from deploy/oci/env.example using a secure channel." >&2
    exit 1
  fi
  mode=$(stat -c '%a' "$env_file")
  if [[ "$mode" != "600" ]]; then
    echo "$env_file must be mode 600; current mode is $mode." >&2
    exit 1
  fi
done

hostnamectl set-hostname fayanms-staging-01
timedatectl set-timezone UTC
systemctl enable --now systemd-timesyncd 2>/dev/null || true

echo "Host filesystem and prerequisite checks passed."
