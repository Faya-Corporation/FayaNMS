#!/bin/bash
# FayaNMS sandbox helper — embedded PostgreSQL 16 control (dev database).
#
# Phase 21 slice 1 (2026-09-13): production persistence is PostgreSQL
# (prisma provider "postgresql"; compose ships a `postgres` service). The
# sandbox dev flow uses a PORTABLE PostgreSQL 16.4.0 (Zonky binaries, no
# root/apt needed) stored under db/pg-embed with its cluster in db/pgdata,
# listening on 127.0.0.1:5433 with TRUST auth (sandbox-local dev only —
# production auth is password-based inside the compose network).
#
# Usage: postgres.sh {ensure|start|stop|status|url}
#   ensure  — start the cluster if it is not running (dev.sh calls this)
#   url     — print the DATABASE_URL for the dev cluster

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_HOME="$PROJECT_DIR/db/pg-embed"
PGDATA="$PROJECT_DIR/db/pgdata"
PG_PORT=5433
PG_LOG="$PG_HOME/pg.log"
DATABASE_URL="postgresql://fayanms:fayanms@localhost:${PG_PORT}/fayanms"

if [ ! -x "$PG_HOME/bin/pg_ctl" ]; then
    echo "❌ Portable PostgreSQL not found at $PG_HOME/bin." >&2
    echo "   Re-provision it (see worklog R14 / Phase 21 slice 1):" >&2
    echo "   download embedded-postgres-binaries-linux-amd64-16.4.0.jar from" >&2
    echo "   Maven Central, extract the inner .txz into db/pg-embed." >&2
    exit 1
fi

export LD_LIBRARY_PATH="$PG_HOME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

is_running() {
    "$PG_HOME/bin/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

case "${1:-}" in
    start)
        if is_running; then
            echo "✅ PostgreSQL already running on :$PG_PORT"
        else
            "$PG_HOME/bin/pg_ctl" -D "$PGDATA" \
                -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k /tmp" \
                -l "$PG_LOG" -w start
            echo "✅ PostgreSQL started on 127.0.0.1:$PG_PORT (trust auth — dev only)"
        fi
        ;;
    ensure)
        if is_running; then
            echo "✅ PostgreSQL already running on :$PG_PORT"
        else
            echo "[PG] Starting embedded PostgreSQL 16 on :$PG_PORT..."
            "$0" start
        fi
        ;;
    stop)
        "$PG_HOME/bin/pg_ctl" -D "$PGDATA" -m fast stop
        ;;
    status)
        "$PG_HOME/bin/pg_ctl" -D "$PGDATA" status
        ;;
    url)
        echo "$DATABASE_URL"
        ;;
    *)
        echo "Usage: $0 {ensure|start|stop|status|url}" >&2
        exit 1
        ;;
esac
