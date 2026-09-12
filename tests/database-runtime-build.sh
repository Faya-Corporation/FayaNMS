#!/bin/bash
# Phase 21 slice 2 contract for .zscripts/database-runtime-build.sh:
#   1. DATABASE_URL unset            → packaging continues, db:deploy NEVER runs
#   2. DATABASE_URL postgres(ql)://  → `bun run db:deploy` (prisma migrate
#                                      deploy) runs against that URL
#   3. DATABASE_URL anything else    → hard fail, db:deploy never runs
# (History: the pre-Phase-21 SQLite behavior — copy db/custom.db into the
# artifact and push a file: URL — was retired with the SQLite provider on
# 2026-09-13; db push was replaced by the migration-history apply on the same
# day, slice 2.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$1" != "run" ] || [ "$2" != "db:deploy" ]; then
    echo "unexpected bun invocation: $*" >&2
    exit 1
fi

printf '%s\n' "${DATABASE_URL:-}" >>"${DB_DEPLOY_CALLS:?}"
EOF
chmod +x "$FAKE_BIN/bun"

export PATH="$FAKE_BIN:$PATH"
export DB_DEPLOY_CALLS="$TEST_ROOT/db-deploy-calls"

PROJECT_DIR="$TEST_ROOT/project"
mkdir -p "$PROJECT_DIR"

# ── 1. no DATABASE_URL → deferred, packaging continues, zero deploy calls ──
(
    export -n DATABASE_URL 2>/dev/null || true
    unset DATABASE_URL
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null
)
test ! -s "$DB_DEPLOY_CALLS"

# ── 2. postgres URL → exactly one db:deploy against that URL ──
PG_URL="postgresql://fayanms:pw@db.internal:5432/fayanms"
PROJECT_DIR="$TEST_ROOT/project" DATABASE_URL="$PG_URL" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null
test "$(wc -l <"$DB_DEPLOY_CALLS" | tr -d ' ')" = "1"
grep -Fx "$PG_URL" "$DB_DEPLOY_CALLS"

# ── 3. legacy file: URL → hard fail, no deploy attempted ──
if PROJECT_DIR="$TEST_ROOT/project" DATABASE_URL="file:/tmp/x.db" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null 2>&1; then
    echo "file: URL was accepted — Phase 21 contract violated" >&2
    exit 1
fi
test "$(wc -l <"$DB_DEPLOY_CALLS" | tr -d ' ')" = "1" # unchanged by the failed run

echo "database runtime build tests passed (Phase 21 migration-history contract)"
