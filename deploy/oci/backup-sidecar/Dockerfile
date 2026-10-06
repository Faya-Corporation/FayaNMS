# GA-6 (P0-R03, 2026-10-06 re-audit) — scheduled encrypted-backup sidecar.
#
# Builds the FAYANMS_BACKUP_IMAGE referenced by deploy/oci/compose.yml:
# the SAME digest-pinned postgres:16-alpine as the database service (so
# pg_dump is byte-compatible with the server) plus `age` for the
# refuse-plaintext encryption contract shared with deploy/oci/backup.sh.
#
# Supply-chain note: the base is digest-pinned identically to the compose
# postgres service; `age` is installed from the Alpine package index at
# build time. Pin the built image by its digest (FAYANMS_BACKUP_IMAGE
# must be an immutable GHCR reference — the compose file refuses tags).
FROM postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685

RUN apk add --no-cache age

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0550 /usr/local/bin/entrypoint.sh

# The container runs read-only with a /tmp tmpfs (compose house rules);
# backups stream to /backups (named volume, mounted by compose).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
