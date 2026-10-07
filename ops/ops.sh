#!/usr/bin/env bash
set -euo pipefail

# FayaNMS — cross-platform fresh-install operator entry (Linux / macOS).
#
# Windows: use ops\ops.bat (it dispatches to ops/ops.ps1). Docker-only
# operators can use this file too — every docker:* command runs the same way.
#
# Fresh install (Linux):
#   bash ops/ops.sh install
#   bash ops/ops.sh db:up          # embedded PostgreSQL 16.4 (auto-provisioned)
#   bash ops/ops.sh migrate && bash ops/ops.sh seed
#   bash ops/ops.sh dev            # app :3000 + worker :3030
#
# Every command is idempotent and safe on a fresh clone. No secrets are ever
# generated or embedded here — production env files come from
# deploy/oci/env.example through a secure channel (SEC-ENV-001).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

readonly PG_EMBED="$ROOT/db/pg-embed"
readonly PGDATA="$ROOT/db/pgdata"
readonly PG_PORT=5433
readonly DEV_URL="postgresql://fayanms:fayanms@localhost:${PG_PORT}/fayanms"
readonly PG_JAR_URL="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/16.4.0/embedded-postgres-binaries-linux-amd64-16.4.0.jar"
readonly DEV_COMPOSE="ops/docker-compose.dev.yml"

# The ONE canonical command surface — ops/ops.ps1 must declare the exact
# same list (pinned by tests/audit/ga9-ops-scripts.test.ts).
readonly OPS_COMMANDS=(
  help
  doctor
  install
  db:up
  db:up:docker
  db:down
  migrate
  seed
  db:reset
  dev
  build
  start
  test
  lint
  typecheck
  keys:service
  health
  docker:build
  docker:up
  docker:down
  docker:logs
  backup
  restore-drill
  release:evidence
)

log()  { printf '\033[1;32m[ops]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ops]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ops]\033[0m %s\n' "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

ensure_bun() { has bun || die "bun is required (https://bun.sh) — install Bun >= 1.3.14 and re-run."; }

default_db_url() {
  # An operator-provided POSTGRES url wins; anything else (unset, or a
  # foreign scheme injected by the surrounding environment — e.g. a SQLite
  # file: URL) falls back to the standard dev URL. Same guard semantics as
  # the package.json `dev` script.
  case "${DATABASE_URL:-}" in
    postgres://* | postgresql://*) ;;
    *) export DATABASE_URL="$DEV_URL" ;;
  esac
}

# ── embedded PostgreSQL (Linux only — Zonky 16.4.0, no root, no apt) ──────
pg_provision() {
  [ -x "$PG_EMBED/bin/pg_ctl" ] && return 0
  has curl || die "curl is required to provision the embedded PostgreSQL."
  has unzip || die "unzip is required to provision the embedded PostgreSQL."
  log "Provisioning embedded PostgreSQL 16.4.0 (Zonky binaries, no root needed)…"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/pg.jar" "$PG_JAR_URL" || die "Download failed — check network access to repo1.maven.org."
  unzip -oq "$tmp/pg.jar" -d "$tmp"
  mkdir -p "$PG_EMBED"
  tar -xJf "$tmp"/postgres-linux-x86_64.txz -C "$PG_EMBED"
  rm -rf "$tmp"
  log "Embedded PostgreSQL provisioned at db/pg-embed."
}

pg_running() {
  [ -x "$PG_EMBED/bin/pg_ctl" ] && "$PG_EMBED/bin/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

pg_ensure_db() {
  # CREATE DATABASE is idempotent-by-swallow (42P04 = already exists), then verify
  echo "CREATE DATABASE fayanms OWNER fayanms;" \
    | bunx prisma db execute --url "postgresql://fayanms@127.0.0.1:${PG_PORT}/postgres" --stdin 2>/dev/null || true
  echo "SELECT 1;" | bunx prisma db execute --url "postgresql://fayanms@127.0.0.1:${PG_PORT}/fayanms" --stdin \
    || die "Database fayanms is not reachable on :${PG_PORT}."
}

# ── commands ──────────────────────────────────────────────────────────────

cmd_help() {
  cat <<'BANNER'
FayaNMS operator entry — one surface for Linux, Windows and Docker.

Usage:
  Linux/macOS : bash ops/ops.sh <command>
  Windows     : ops\ops.bat <command>   (dispatches to ops/ops.ps1)

Commands:
BANNER
  local c
  for c in "${OPS_COMMANDS[@]}"; do
    case "$c" in
      help)             printf '  %-17s %s\n' "$c" "show this help" ;;
      doctor)           printf '  %-17s %s\n' "$c" "validate prerequisites (bun/docker/curl/pg/ports)" ;;
      install)          printf '  %-17s %s\n' "$c" "install dependencies (root + worker) and generate the Prisma client" ;;
      db:up)            printf '  %-17s %s\n' "$c" "start the embedded PostgreSQL 16.4 dev cluster on :5433 (Linux; auto-provisions)" ;;
      db:up:docker)     printf '  %-17s %s\n' "$c" "start the dev PostgreSQL via Docker (ops/docker-compose.dev.yml, any OS)" ;;
      db:down)          printf '  %-17s %s\n' "$c" "stop the dev database (native cluster and/or docker compose)" ;;
      migrate)          printf '  %-17s %s\n' "$c" "apply all migrations (prisma migrate deploy)" ;;
      seed)             printf '  %-17s %s\n' "$c" "load the demo seed (idempotent)" ;;
      db:reset)         printf '  %-17s %s\n' "$c" "drop + re-migrate + re-seed the dev database" ;;
      dev)              printf '  %-17s %s\n' "$c" "run the app (:3000) and worker (:3030) in dev mode" ;;
      build)            printf '  %-17s %s\n' "$c" "production build (standalone output)" ;;
      start)            printf '  %-17s %s\n' "$c" "start the production standalone server" ;;
      test)             printf '  %-17s %s\n' "$c" "run the full test suite" ;;
      lint)             printf '  %-17s %s\n' "$c" "run eslint" ;;
      typecheck)        printf '  %-17s %s\n' "$c" "run tsc --noEmit" ;;
      keys:service)     printf '  %-17s %s\n' "$c" "generate the EdDSA service keypair for the app/worker plane" ;;
      health)           printf '  %-17s %s\n' "$c" "probe app /api/health and worker /health" ;;
      docker:build)     printf '  %-17s %s\n' "$c" "build the app/worker/migrator images locally (fayanms-local:* tags)" ;;
      docker:up)        printf '  %-17s %s\n' "$c" "start the production-grade compose stack (requires deploy/oci env files)" ;;
      docker:down)      printf '  %-17s %s\n' "$c" "stop the compose stack" ;;
      docker:logs)      printf '  %-17s %s\n' "$c" "tail app/worker/caddy logs from the compose stack" ;;
      backup)           printf '  %-17s %s\n' "$c" "encrypted pg_dump backup (deploy/oci/backup.sh; Linux/WSL)" ;;
      restore-drill)    printf '  %-17s %s\n' "$c" "restore drill against a disposable target (deploy/oci/restore-drill.sh; Linux/WSL)" ;;
      release:evidence) printf '  %-17s %s\n' "$c" "generate the release-evidence manifest for the current HEAD" ;;
    esac
  done
}

cmd_doctor() {
  local fail=0
  say() { printf '  %-28s %s\n' "$1" "$2"; }
  echo "FayaNMS doctor —"
  if has bun; then say "bun" "$(bun --version)"; else say "bun" "MISSING (required — https://bun.sh)"; fail=1; fi
  if has docker && docker compose version >/dev/null 2>&1; then
    say "docker compose" "$(docker compose version --short)"
  else
    say "docker compose" "not found (optional — needed for db:up:docker / docker:*)"
  fi
  if has curl; then say "curl" "present"; else say "curl" "MISSING (needed for health probes)"; fi
  if [ -d "$ROOT/node_modules" ]; then say "node_modules" "present"; else say "node_modules" "missing — run: bash ops/ops.sh install"; fi
  if [ -x "$PG_EMBED/bin/pg_ctl" ]; then say "embedded PostgreSQL" "provisioned"; else say "embedded PostgreSQL" "not provisioned (db:up auto-provisions on Linux)"; fi
  if pg_running; then say "pg cluster" "running on :$PG_PORT"; else say "pg cluster" "stopped"; fi
  if [ -f "$ROOT/.env" ]; then say ".env" "present"; else say ".env" "absent (dev flows do not need it; production does — see deploy/oci/env.example)"; fi
  [ "$fail" -eq 0 ] && log "doctor: required prerequisites OK." || die "doctor: required prerequisites missing."
}

cmd_install() {
  ensure_bun
  log "Installing root dependencies…"
  bun install
  log "Installing worker dependencies…"
  (cd mini-services/worker && bun install)
  log "Generating the Prisma client…"
  bunx prisma generate
  log "install complete — next: bash ops/ops.sh db:up (Linux) or db:up:docker, then migrate + seed."
}

cmd_db_up() {
  ensure_bun
  [ "$(uname -s)" = "Linux" ] || die "The embedded PostgreSQL ships Linux binaries only — use: bash ops/ops.sh db:up:docker"
  pg_provision
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "Initializing the dev cluster (trust auth — local dev only)…"
    mkdir -p "$PGDATA"
    LD_LIBRARY_PATH="$PG_EMBED/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      "$PG_EMBED/bin/initdb" -D "$PGDATA" -U fayanms -A trust -E UTF8 >/dev/null
  fi
  if pg_running; then
    log "PostgreSQL already running on :$PG_PORT."
  else
    log "Starting PostgreSQL on 127.0.0.1:$PG_PORT…"
    LD_LIBRARY_PATH="$PG_EMBED/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      "$PG_EMBED/bin/pg_ctl" -D "$PGDATA" \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k /tmp" \
      -l "$PG_EMBED/pg.log" -w start >/dev/null
  fi
  pg_ensure_db
  log "Dev database ready — DATABASE_URL=$DEV_URL"
}

cmd_db_up_docker() {
  has docker || die "Docker is required for db:up:docker — install Docker Desktop/Engine and re-run."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required."
  log "Starting dev PostgreSQL via docker compose (127.0.0.1:$PG_PORT)…"
  docker compose -f "$DEV_COMPOSE" up -d --wait
  ensure_bun
  default_db_url
  pg_ensure_db
  log "Dev database ready — DATABASE_URL=$DEV_URL"
}

cmd_db_down() {
  if pg_running; then
    log "Stopping the native dev cluster…"
    LD_LIBRARY_PATH="$PG_EMBED/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      "$PG_EMBED/bin/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null || true
  fi
  if has docker && [ -f "$DEV_COMPOSE" ]; then
    docker compose -f "$DEV_COMPOSE" down --remove-orphans >/dev/null 2>&1 || true
  fi
  log "Dev database stopped."
}

cmd_migrate() { ensure_bun; default_db_url; bunx prisma migrate deploy; }
cmd_seed()    { ensure_bun; default_db_url; bun prisma/seed.ts; }
cmd_db_reset(){ ensure_bun; default_db_url; bunx prisma migrate reset --force; }

# Fresh-install dev identity: generate ONCE into .fayanms/dev-identity.env
# (gitignored, mode 600, per-install random material), then fill env gaps —
# an operator-provided value ALWAYS wins over the generated one.
load_dev_identity() {
  local f="$ROOT/.fayanms/dev-identity.env"
  if [ ! -f "$f" ]; then
    log "Bootstrapping local dev service identity (.fayanms/dev-identity.env — gitignored, local-only)…"
    bun ops/bootstrap-dev-identity.ts
  fi
  # shellcheck disable=SC1090
  . "$f"
}

cmd_dev() {
  ensure_bun
  default_db_url
  load_dev_identity
  export NEXTAUTH_URL="${NEXTAUTH_URL:-http://localhost:3000}"
  export NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$DEV_NEXTAUTH_SECRET}"
  export FAYANMS_CONFIG_ENC_KEY="${FAYANMS_CONFIG_ENC_KEY:-$DEV_CONFIG_ENC_KEY}"
  # control plane: mints with the CONTROL key, verifies WORKER tokens
  export FAYANMS_SERVICE_PRIVATE_KEY="${FAYANMS_SERVICE_PRIVATE_KEY:-$DEV_CONTROL_PRIVATE_KEY}"
  export FAYANMS_SERVICE_PUBLIC_KEYS="${FAYANMS_SERVICE_PUBLIC_KEYS:-$DEV_WORKER_PUBLIC_KEY}"
  # worker plane: mints with the WORKER key, verifies control AND its own self-call tokens
  local WORKER_PRIV="$DEV_WORKER_PRIVATE_KEY"
  local WORKER_PUBS="$DEV_CONTROL_PUBLIC_KEY,$DEV_WORKER_PUBLIC_KEY"
  log "Starting worker (mini-services/worker) in the background…"
  ( cd mini-services/worker && \
    DATABASE_URL="$DATABASE_URL" \
    FAYANMS_SERVICE_PRIVATE_KEY="$WORKER_PRIV" \
    FAYANMS_SERVICE_PUBLIC_KEYS="$WORKER_PUBS" \
    FAYANMS_CONFIG_ENC_KEY="$FAYANMS_CONFIG_ENC_KEY" \
    bun --hot index.ts >"$ROOT/.worker-dev.log" 2>&1 & echo $! >"$ROOT/.worker-dev.pid" )
  local worker_pid; worker_pid="$(cat "$ROOT/.worker-dev.pid")"
  trap 'kill "$worker_pid" 2>/dev/null || true; rm -f "$ROOT/.worker-dev.pid"' EXIT
  log "Worker pid $worker_pid (log: .worker-dev.log). Starting app on :3000 (Ctrl-C stops both)…"
  bunx next dev -p 3000
}

cmd_build() {
  ensure_bun
  bunx next build
  cp -r .next/static .next/standalone/.next/
  cp -r public .next/standalone/
  log "Build complete (.next/standalone)."
}

cmd_start() { ensure_bun; default_db_url; NODE_ENV=production bun .next/standalone/server.js; }
cmd_test()  { ensure_bun; bun test tests/; }
cmd_lint()  { ensure_bun; bun run lint; }
cmd_typecheck() { ensure_bun; bunx tsc --noEmit; }
cmd_keys()  { ensure_bun; bun scripts/generate-service-keys.ts; }

cmd_health() {
  local rc=0
  if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then
    log "app    :3000 /api/health -> 200"
  else
    warn "app    :3000 /api/health -> DOWN"; rc=1
  fi
  if curl -fsS http://localhost:3030/health >/dev/null 2>&1; then
    log "worker :3030 /health      -> 200"
  else
    warn "worker :3030 /health      -> DOWN"; rc=1
  fi
  return "$rc"
}

cmd_docker_build() {
  has docker || die "Docker is required."
  log "Building local images (fayanms-local:{app,worker,migrator})…"
  docker build -f Dockerfile          -t fayanms-local:app      .
  docker build -f Dockerfile.worker   -t fayanms-local:worker   .
  docker build -f Dockerfile.migrator -t fayanms-local:migrator .
  log "Built. Point FAYANMS_IMAGE / FAYANMS_WORKER_IMAGE / FAYANMS_MIGRATOR_IMAGE at these tags in deploy/oci/.env, or push+pin digests for production."
}

oci_env_ready() {
  local missing=0 f
  for f in .env .env.app .env.worker; do
    if [ ! -f "deploy/oci/$f" ]; then
      warn "Missing deploy/oci/$f — create it from deploy/oci/env.example (SEC-ENV-001) before docker:up."
      missing=1
    fi
  done
  return "$missing"
}

cmd_docker_up() {
  has docker || die "Docker is required."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required."
  oci_env_ready || die "deploy/oci env files incomplete — see deploy/oci/README.md."
  ( cd deploy/oci && docker compose --env-file .env up -d )
  log "Compose stack up — run: bash ops/ops.sh health"
}

cmd_docker_down() {
  has docker || die "Docker is required."
  ( cd deploy/oci && docker compose --env-file .env down )
  log "Compose stack down."
}

cmd_docker_logs() {
  has docker || die "Docker is required."
  ( cd deploy/oci && docker compose --env-file .env logs -f --tail=100 app worker caddy )
}

cmd_backup()        { bash deploy/oci/backup.sh "$@"; }
cmd_restore_drill() { bash deploy/oci/restore-drill.sh "$@"; }
cmd_release_evidence() { ensure_bun; bun scripts/release/evidence-manifest.ts "$@"; }

# ── dispatch ──────────────────────────────────────────────────────────────

command="${1:-help}"
[ $# -gt 0 ] && shift || true
case "$command" in
  help) cmd_help ;;
  doctor) cmd_doctor ;;
  install) cmd_install ;;
  db:up) cmd_db_up ;;
  db:up:docker) cmd_db_up_docker ;;
  db:down) cmd_db_down ;;
  migrate) cmd_migrate ;;
  seed) cmd_seed ;;
  db:reset) cmd_db_reset ;;
  dev) cmd_dev ;;
  build) cmd_build ;;
  start) cmd_start ;;
  test) cmd_test ;;
  lint) cmd_lint ;;
  typecheck) cmd_typecheck ;;
  keys:service) cmd_keys ;;
  health) cmd_health ;;
  docker:build) cmd_docker_build ;;
  docker:up) cmd_docker_up ;;
  docker:down) cmd_docker_down ;;
  docker:logs) cmd_docker_logs ;;
  backup) cmd_backup "$@" ;;
  restore-drill) cmd_restore_drill "$@" ;;
  release:evidence) cmd_release_evidence "$@" ;;
  *) die "Unknown command: $command — run 'bash ops/ops.sh help'." ;;
esac
