#!/bin/bash
# Phase 21 (PostgreSQL) contract for .zscripts/database-runtime-build.sh:
#   1. DATABASE_URL unset            → packaging continues, db:push NEVER runs
#   2. DATABASE_URL postgres(ql)://  → `bun run db:push` runs against that URL
#   3. DATABASE_URL anything else    → hard fail, db:push never runs
# (The pre-Phase-21 SQLite behavior — copy db/custom.db into the artifact and
# push a file: URL — was retired with the SQLite provider on 2026-09-13.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$1" != "run" ] || [ "$2" != "db:push" ]; then
    echo "unexpected bun invocation: $*" >&2
    exit 1
fi

printf '%s\n' "${DATABASE_URL:-}" >>"${DB_PUSH_CALLS:?}"
EOF
chmod +x "$FAKE_BIN/bun"

export PATH="$FAKE_BIN:$PATH"
export DB_PUSH_CALLS="$TEST_ROOT/db-push-calls"

PROJECT_DIR="$TEST_ROOT/project"
mkdir -p "$PROJECT_DIR"

# ── 1. no DATABASE_URL → deferred, packaging continues, zero push calls ──
(
    export -n DATABASE_URL 2>/dev/null || true
    unset DATABASE_URL
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null
)
test ! -s "$DB_PUSH_CALLS"

# ── 2. postgres URL → exactly one db:push against that URL ──
PG_URL="postgresql://fayanms:pw@db.internal:5432/fayanms"
PROJECT_DIR="$TEST_ROOT/project" DATABASE_URL="$PG_URL" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null
test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "1"
grep -Fx "$PG_URL" "$DB_PUSH_CALLS"

# ── 3. legacy file: URL → hard fail, no push attempted ──
if PROJECT_DIR="$TEST_ROOT/project" DATABASE_URL="file:/tmp/x.db" \
    bash "$SCRIPT_DIR/database-runtime-build.sh" >/dev/null 2>&1; then
    echo "file: URL was accepted — Phase 21 contract violated" >&2
    exit 1
fi
test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "1" # unchanged by the failed run

echo "database runtime build tests passed (Phase 21 PostgreSQL contract)"
