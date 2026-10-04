#!/usr/bin/env bash
set -euo pipefail

required=(
  .devcontainer/devcontainer.json
  .devcontainer/docker-compose.yml
  .devcontainer/post-create.sh
  docs/runbooks/codespaces.md
  docs/runbooks/ci-cd.md
  docs/runbooks/secrets-management.md
  deploy/oci/compose.yml
  deploy/oci/env.example
  deploy/oci/Caddyfile
  deploy/oci/bootstrap.sh
  deploy/oci/deploy.sh
  deploy/oci/rollback.sh
  deploy/oci/health-check.sh
  deploy/oci/backup.sh
  deploy/oci/restore-drill.sh
  .github/workflows/container.yml
  .github/workflows/deploy-staging.yml
  monitoring/prometheus.yml
  monitoring/otel-collector.yml
)

for path in "${required[@]}"; do
  test -f "$path" || { echo "missing required cloud file: $path" >&2; exit 1; }
done

# NOTE (2026-10-03): this check previously piped into `rg`, which the CI
# runner image does not always carry — a missing binary exited 127 inside the
# if-condition and SILENTLY SKIPPED the secret-shaped-file gate (observed on
# the 2026-10-03 gate run of PR #56). Plain grep -E has identical semantics
# for these anchored regexes over git ls-files output and exists everywhere.
if git ls-files | grep -E '(^|/)(\.env|\.env\..*|.*\.pem|.*\.key)$' | grep -vE '(^|/)\.env\.example$|^mini-services/worker/harness/tls/.*\.pem$'; then
  echo "tracked secret-shaped file detected" >&2
  exit 1
fi

if git grep -n -E 'BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY' -- ':!docs/runbooks/*' ':!docs/audits/*'; then
  echo "private-key material detected in tracked content" >&2
  exit 1
fi

for script in .devcontainer/post-create.sh deploy/oci/*.sh deploy/lab/*.sh scripts/ci/arm64-runtime-smoke.sh; do
  bash -n "$script"
done

grep -q 'contents: read' .github/workflows/container.yml
grep -q 'packages: write' .github/workflows/container.yml
grep -q 'workflow_run' .github/workflows/deploy-staging.yml

echo "cloud layout and secret boundary validation passed"
