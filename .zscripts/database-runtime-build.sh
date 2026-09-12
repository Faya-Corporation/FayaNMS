#!/bin/bash
# Schema sync for the packaged-deployment flow — Phase 21 (PostgreSQL) contract.
#
# HISTORY: this helper used to copy a SQLite file into the build artifact and
# run `prisma db push` against that file URL. Phase 21 slice 1 (2026-09-13)
# retired the SQLite provider. Phase 21 slice 2 (2026-09-13) moved provisioning
# onto the COMMITTED migration history: the production path is
# `prisma migrate deploy` (script `db:deploy`), while `db:push` survives only
# as a dev-only scratch tool.
#
# Contract:
#   - DATABASE_URL unset            → packaging continues; schema sync is
#     DEFERRED to deploy/start time (the build host must not require a
#     reachable database).
#   - DATABASE_URL postgres(ql)://  → apply the committed migration history
#     now (`bun run db:deploy`) against that server.
#   - DATABASE_URL anything else (e.g. a leftover file: URL) → hard fail;
#     the startup security policy would refuse it anyway.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"

case "${DATABASE_URL:-}" in
    "")
        echo "ℹ️  DATABASE_URL is not set — skipping build-time schema sync (applied at deploy time via prisma migrate deploy)"
        exit 0
        ;;
    postgres://* | postgresql://*)
        echo "🗄️  Applying the committed migration history to the target PostgreSQL..."
        cd "$PROJECT_DIR"
        bun run db:deploy
        echo "✅ Migration history applied to the target PostgreSQL"
        ;;
    *)
        echo "❌ DATABASE_URL must be a postgresql:// URL (Phase 21 retired the SQLite provider); the given value is rejected" >&2
        exit 1
        ;;
esac
