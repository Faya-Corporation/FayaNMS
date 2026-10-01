#!/usr/bin/env bash
# RT-033 (F-063) — RESTORE_TARGET_DATABASE_URL → libpq environment variables.
#
# The restore drill must keep the database credentials OFF the command line:
# pg_restore/psql read PGHOST/PGPORT/PGUSER/PGPASSWORD from the environment,
# and --dbname receives the bare database name. This is the single parser
# implementation (restore-drill.sh sources it; its contract test executes it
# directly, so the fragment cannot drift from the tests).
#
# Canonical URL shape in this repo (deploy/oci/env.example:14):
#   postgresql://user:password@host:port/database
# Percent-encode special characters inside the password. The guard is
# deliberately strict — anything else (no ://, no credentials, query
# parameters, IPv6 literals, extra path segments) exits nonzero: a
# half-parsed credential must never reach a connection attempt.
parse_pg_url() {
  local url="$1"
  local shape='^postgresql://[^:@/]+:[^@/]+@[^@/:]+:[0-9]{1,5}/[A-Za-z0-9_]+$'
  if [[ ! "$url" =~ $shape ]]; then
    echo "RESTORE_TARGET_DATABASE_URL must match postgresql://user:password@host:port/database (percent-encode special characters); refusing to half-parse credentials." >&2
    exit 2
  fi
  local rest="${url#*://}"
  local userinfo="${rest%%@*}"
  local hostportdb="${rest#*@}"
  local portdb="${hostportdb#*:}"
  PGUSER="${userinfo%%:*}"
  PGPASSWORD="${userinfo#*:}"
  PGHOST="${hostportdb%%:*}"
  PGPORT="${portdb%%/*}"
  PGDATABASE="${portdb#*/}"
  export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
}
