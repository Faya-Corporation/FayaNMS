#!/bin/bash
# Schema sync for the packaged-deployment flow — Phase 21 (PostgreSQL) contract.
#
# HISTORY: this helper used to copy a SQLite file into the build artifact and
# run `prisma db push` against that file URL. Phase 21 slice 1 (2026-09-13)
# retired the SQLite provider: production persistence is PostgreSQL, the
# startup security policy rejects non-postgres URLs, and there is no database
# file to package anymore.
#
# New contract:
#   - DATABASE_URL unset  → packaging continues; schema sync is DEFERRED to
#     deploy/start time (the build host must not require a reachable DB).
#   - DATABASE_URL postgres(ql):// → sync the schema now against that server.
#   - DATABASE_URL anything else (e.g. a leftover file: URL) → hard fail;
#     the startup security policy would refuse it anyway.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"

case "${DATABASE_URL:-}" in
    "")
        echo "ℹ️  DATABASE_URL 未设置 — 跳过打包期 schema 同步（部署/启动时执行 prisma db push）"
        exit 0
        ;;
    postgres://* | postgresql://*)
        echo "🗄️  对目标 PostgreSQL 同步 schema..."
        cd "$PROJECT_DIR"
        bun run db:push
        echo "✅ schema 已同步到目标 PostgreSQL"
        ;;
    *)
        echo "❌ DATABASE_URL 必须是 postgresql:// URL（Phase 21 已退役 SQLite provider），当前值被拒绝" >&2
        exit 1
        ;;
esac
