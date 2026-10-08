# FayaNMS — cross-platform fresh-install operator entry (Windows PowerShell).
#
# Invoked via ops\ops.bat (which prefers pwsh and falls back to Windows
# PowerShell 5.1). Linux/macOS use ops/ops.sh — the command surface is
# IDENTICAL and pinned by tests/audit/ga9-ops-scripts.test.ts.
#
# Fresh install (Windows):
#   ops\ops.bat install
#   ops\ops.bat db:up:docker      # embedded PG is Linux-only; Docker covers Windows
#   ops\ops.bat migrate ; ops\ops.bat seed
#   ops\ops.bat dev               # app :3000 + worker :3030
#
# No secrets are ever generated or embedded here — production env files come
# from deploy/oci/env.example through a secure channel (SEC-ENV-001).

$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$PgEmbed  = Join-Path $Root 'db\pg-embed'
$PgPort   = 5433
$DevUrl   = "postgresql://fayanms:fayanms@localhost:$PgPort/fayanms"
$DevCompose = 'ops/docker-compose.dev.yml'

Set-Location $Root

# The ONE canonical command surface — ops/ops.sh must declare the exact
# same list (pinned by tests/audit/ga9-ops-scripts.test.ts).
$Script:OpsCommands = @(
  'help',
  'doctor',
  'install',
  'db:up',
  'db:up:docker',
  'db:down',
  'migrate',
  'seed',
  'db:reset',
  'dev',
  'build',
  'start',
  'test',
  'lint',
  'typecheck',
  'keys:service',
  'health',
  'docker:build',
  'docker:up',
  'docker:down',
  'docker:logs',
  'backup',
  'restore-drill',
  'release:evidence'
)

function Write-Log([string]$Message)  { Write-Host '[ops] ' -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-WarnOp([string]$Message) { Write-Host '[ops] ' -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Die([string]$Message)        { Write-Host '[ops] ' -ForegroundColor Red -NoNewline; Write-Host $Message; exit 1 }

function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Ensure-Bun { if (-not (Test-Command 'bun')) { Die 'bun is required (https://bun.sh) — install Bun >= 1.3.14 and re-run.' } }

function Set-DefaultDbUrl {
  # An operator-provided POSTGRES url wins; anything else (unset, or a
  # foreign scheme injected by the surrounding environment) falls back to
  # the standard dev URL. Same guard semantics as the package.json `dev`.
  $u = $env:DATABASE_URL
  if (-not $u -or ($u -notmatch '^postgres(ql)?://')) { $env:DATABASE_URL = $DevUrl }
}

function Invoke-PgEnsureDb {
  # CREATE DATABASE is idempotent-by-swallow (42P04 = already exists), then verify
  'CREATE DATABASE fayanms OWNER fayanms;' |
    bunx prisma db execute --url "postgresql://fayanms@127.0.0.1:$PgPort/postgres" --stdin 2>$null
  if ($LASTEXITCODE -ne 0) { Write-WarnOp 'create-database returned nonzero (usually: already exists).' }
  'SELECT 1;' | bunx prisma db execute --url "postgresql://fayanms@127.0.0.1:$PgPort/fayanms" --stdin
  if ($LASTEXITCODE -ne 0) { Die "Database fayanms is not reachable on :$PgPort." }
}

# ── commands ──────────────────────────────────────────────────────────────

function Invoke-Help {
  Write-Host 'FayaNMS operator entry — one surface for Linux, Windows and Docker.'
  Write-Host ''
  Write-Host 'Usage:'
  Write-Host '  Linux/macOS : bash ops/ops.sh <command>'
  Write-Host '  Windows     : ops\ops.bat <command>   (dispatches to ops/ops.ps1)'
  Write-Host ''
  Write-Host 'Commands:'
  $descriptions = @{
    'help'             = 'show this help'
    'doctor'           = 'validate prerequisites (bun/docker/curl/pg/ports)'
    'install'          = 'install dependencies (root + worker) and generate the Prisma client'
    'db:up'            = 'start the embedded PostgreSQL 16.4 dev cluster on :5433 (Linux; auto-provisions)'
    'db:up:docker'     = 'start the dev PostgreSQL via Docker (ops/docker-compose.dev.yml, any OS)'
    'db:down'          = 'stop the dev database (native cluster and/or docker compose)'
    'migrate'          = 'apply all migrations (prisma migrate deploy)'
    'seed'             = 'load the demo seed (idempotent)'
    'db:reset'         = 'drop + re-migrate + re-seed the dev database'
    'dev'              = 'run the app (:3000) and worker (:3030) in dev mode'
    'build'            = 'production build (standalone output)'
    'start'            = 'start the production standalone server'
    'test'             = 'run the full test suite'
    'lint'             = 'run eslint'
    'typecheck'        = 'run tsc --noEmit'
    'keys:service'     = 'generate the EdDSA service keypair for the app/worker plane'
    'health'           = 'probe app /api/health and worker /health'
    'docker:build'     = 'build the app/worker/migrator images locally (fayanms-local:* tags)'
    'docker:up'        = 'start the production-grade compose stack (requires deploy/oci env files)'
    'docker:down'      = 'stop the compose stack'
    'docker:logs'      = 'tail app/worker/caddy logs from the compose stack'
    'backup'           = 'encrypted pg_dump backup (deploy/oci/backup.sh; Linux/WSL)'
    'restore-drill'    = 'restore drill against a disposable target (deploy/oci/restore-drill.sh; Linux/WSL)'
    'release:evidence' = 'generate the release-evidence manifest for the current HEAD'
  }
  foreach ($c in $Script:OpsCommands) {
    Write-Host ('  {0,-17} {1}' -f $c, $descriptions[$c])
  }
}

function Invoke-Doctor {
  $fail = $false
  Write-Host 'FayaNMS doctor —'
  if (Test-Command 'bun') { Write-Host ('  {0,-28} {1}' -f 'bun', (bun --version)) }
  else { Write-Host ('  {0,-28} {1}' -f 'bun', 'MISSING (required — https://bun.sh)'); $fail = $true }
  if ((Test-Command 'docker') -and (docker compose version 2>$null)) {
    Write-Host ('  {0,-28} {1}' -f 'docker compose', (docker compose version --short))
  } else {
    Write-Host ('  {0,-28} {1}' -f 'docker compose', 'not found (optional — needed for db:up:docker / docker:*)')
  }
  if (Test-Command 'curl') { Write-Host ('  {0,-28} {1}' -f 'curl', 'present') }
  else { Write-Host ('  {0,-28} {1}' -f 'curl', 'MISSING (needed for health probes)') }
  if (Test-Path (Join-Path $Root 'node_modules')) { Write-Host ('  {0,-28} {1}' -f 'node_modules', 'present') }
  else { Write-Host ('  {0,-28} {1}' -f 'node_modules', 'missing — run: ops\ops.bat install') }
  if (Test-Path (Join-Path $PgEmbed 'bin\pg_ctl')) { Write-Host ('  {0,-28} {1}' -f 'embedded PostgreSQL', 'provisioned (Linux binaries — inert on Windows)') }
  else { Write-Host ('  {0,-28} {1}' -f 'embedded PostgreSQL', 'not provisioned (Windows uses db:up:docker)') }
  if (Test-Path (Join-Path $Root '.env')) { Write-Host ('  {0,-28} {1}' -f '.env', 'present') }
  else { Write-Host ('  {0,-28} {1}' -f '.env', 'absent (dev flows do not need it; production does — see deploy/oci/env.example)') }
  if ($fail) { Die 'doctor: required prerequisites missing.' }
  Write-Log 'doctor: required prerequisites OK.'
}

function Invoke-Install {
  Ensure-Bun
  Write-Log 'Installing root dependencies…'
  bun install
  if ($LASTEXITCODE -ne 0) { Die 'root install failed.' }
  Write-Log 'Installing worker dependencies…'
  Push-Location (Join-Path $Root 'mini-services\worker')
  bun install
  Pop-Location
  if ($LASTEXITCODE -ne 0) { Die 'worker install failed.' }
  Write-Log 'Generating the Prisma client…'
  bunx prisma generate
  Write-Log 'install complete — next: ops\ops.bat db:up:docker, then migrate + seed.'
}

function Invoke-DbUp {
  Ensure-Bun
  Write-WarnOp 'The embedded PostgreSQL ships Linux binaries only — routing to the Docker dev database (db:up:docker).'
  Invoke-DbUpDocker
}

function Invoke-DbUpDocker {
  if (-not (Test-Command 'docker')) { Die 'Docker is required for db:up:docker — install Docker Desktop and re-run.' }
  Write-Log "Starting dev PostgreSQL via docker compose (127.0.0.1:$PgPort)…"
  docker compose -f $DevCompose up -d --wait
  if ($LASTEXITCODE -ne 0) { Die 'docker compose up failed.' }
  Ensure-Bun
  Set-DefaultDbUrl
  Invoke-PgEnsureDb
  Write-Log "Dev database ready — DATABASE_URL=$DevUrl"
}

function Invoke-DbDown {
  if (Test-Command 'docker') {
    docker compose -f $DevCompose down --remove-orphans 2>$null
  }
  Write-Log 'Dev database stopped.'
}

function Invoke-Migrate  { Ensure-Bun; Set-DefaultDbUrl; Ensure-DataKey; bunx prisma migrate deploy; if ($LASTEXITCODE -ne 0) { exit 1 } }
function Invoke-Seed     { Ensure-Bun; Set-DefaultDbUrl; Ensure-DataKey; bun prisma/seed.ts; if ($LASTEXITCODE -ne 0) { exit 1 } }
function Invoke-DbReset  { Ensure-Bun; Set-DefaultDbUrl; Ensure-DataKey; bunx prisma migrate reset --force; if ($LASTEXITCODE -ne 0) { exit 1 } }

# Fresh-install dev identity: generate ONCE into .fayanms/dev-identity.env
# (gitignored, mode 600, per-install random material), then fill env gaps —
# an operator-provided value ALWAYS wins over the generated one.
function Load-DevIdentity {
  $f = Join-Path $Root '.fayanms\dev-identity.env'
  if (-not (Test-Path $f)) {
    Write-Log 'Bootstrapping local dev service identity (.fayanms/dev-identity.env — gitignored, local-only)…'
    bun ops/bootstrap-dev-identity.ts
    if ($LASTEXITCODE -ne 0) { Die 'dev identity bootstrap failed.' }
  }
  foreach ($line in Get-Content $f) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line -split '=', 2
    $v = $v.Trim()
    if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
    Set-Variable -Name $k -Value $v -Scope Script
  }
}

# Data-state commands (migrate / seed / db:reset) encrypt at rest (e.g. the
# webhook demo fixtures) and therefore need the 64-hex config-encryption key.
# A FRESH install has none until the dev identity is bootstrapped — fall back
# to it so the documented install order (db:up → migrate → seed → dev) works
# on a clean machine; an operator-provided key ALWAYS wins.
function Ensure-DataKey {
  if (-not $env:FAYANMS_CONFIG_ENC_KEY) {
    Load-DevIdentity
    $env:FAYANMS_CONFIG_ENC_KEY = $Script:DEV_CONFIG_ENC_KEY
  }
}

function Invoke-Dev {
  Ensure-Bun
  Set-DefaultDbUrl
  Load-DevIdentity
  if (-not $env:NEXTAUTH_URL)      { $env:NEXTAUTH_URL = 'http://localhost:3000' }
  if (-not $env:NEXTAUTH_SECRET)   { $env:NEXTAUTH_SECRET = $Script:DEV_NEXTAUTH_SECRET }
  if (-not $env:FAYANMS_CONFIG_ENC_KEY) { $env:FAYANMS_CONFIG_ENC_KEY = $Script:DEV_CONFIG_ENC_KEY }
  # save operator-provided identity material (operator values ALWAYS win);
  # we swap the identity twice: the worker child inherits the PROCESS env,
  # so it must hold the WORKER identity at Start-Process time, then the app
  # must see the CONTROL identity again.
  $savedPriv = $env:FAYANMS_SERVICE_PRIVATE_KEY
  $savedPubs = $env:FAYANMS_SERVICE_PUBLIC_KEYS
  # control plane (for the app): mints with the CONTROL key, verifies WORKER tokens
  if (-not $savedPriv) { $savedPriv = $Script:DEV_CONTROL_PRIVATE_KEY }
  if (-not $savedPubs) { $savedPubs = $Script:DEV_WORKER_PUBLIC_KEY }
  # worker plane: mints with the WORKER key, verifies control AND its own self-call tokens
  $workerPriv = $Script:DEV_WORKER_PRIVATE_KEY
  $workerPubs = "$($Script:DEV_CONTROL_PUBLIC_KEY),$($Script:DEV_WORKER_PUBLIC_KEY)"
  Write-Log 'Starting worker (mini-services/worker) in the background…'
  $env:FAYANMS_SERVICE_PRIVATE_KEY = $workerPriv
  $env:FAYANMS_SERVICE_PUBLIC_KEYS = $workerPubs
  $workerLog = Join-Path $Root '.worker-dev.log'
  $worker = Start-Process -FilePath 'bun' -ArgumentList '--hot','index.ts' `
    -WorkingDirectory (Join-Path $Root 'mini-services\worker') `
    -RedirectStandardOutput $workerLog -RedirectStandardError $workerLog `
    -PassThru -WindowStyle Hidden
  # restore the control-plane identity for the app process
  $env:FAYANMS_SERVICE_PRIVATE_KEY = $savedPriv
  $env:FAYANMS_SERVICE_PUBLIC_KEYS = $savedPubs
  Write-Log "Worker pid $($worker.Id) (log: .worker-dev.log). Starting app on :3000 (Ctrl-C stops both)…"
  try {
    bunx next dev -p 3000
  } finally {
    try { Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

function Invoke-Build {
  Ensure-Bun
  bunx next build
  if ($LASTEXITCODE -ne 0) { exit 1 }
  $standalone = Join-Path $Root '.next\standalone'
  Copy-Item -Recurse -Force (Join-Path $Root '.next\static') (Join-Path $standalone '.next\static')
  Copy-Item -Recurse -Force (Join-Path $Root 'public') (Join-Path $standalone 'public')
  Write-Log 'Build complete (.next/standalone).'
}

function Invoke-Start { Ensure-Bun; Set-DefaultDbUrl; $env:NODE_ENV = 'production'; bun (Join-Path $Root '.next\standalone\server.js') }
function Invoke-Test  { Ensure-Bun; bun test tests/; if ($LASTEXITCODE -ne 0) { exit 1 } }
function Invoke-Lint  { Ensure-Bun; bun run lint; if ($LASTEXITCODE -ne 0) { exit 1 } }
function Invoke-Typecheck { Ensure-Bun; bunx tsc --noEmit; if ($LASTEXITCODE -ne 0) { exit 1 } }
function Invoke-Keys  { Ensure-Bun; bun scripts/generate-service-keys.ts }

function Invoke-Health {
  $rc = 0
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    Write-Log 'app    :3000 /api/health -> 200'
  } catch {
    Write-WarnOp 'app    :3000 /api/health -> DOWN'; $rc = 1
  }
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3030/health' -TimeoutSec 5
    Write-Log 'worker :3030 /health      -> 200'
  } catch {
    Write-WarnOp 'worker :3030 /health      -> DOWN'; $rc = 1
  }
  exit $rc
}

function Invoke-DockerBuild {
  if (-not (Test-Command 'docker')) { Die 'Docker is required.' }
  Write-Log 'Building local images (fayanms-local:{app,worker,migrator})…'
  docker build -f Dockerfile          -t fayanms-local:app      .
  if ($LASTEXITCODE -ne 0) { exit 1 }
  docker build -f Dockerfile.worker   -t fayanms-local:worker   .
  if ($LASTEXITCODE -ne 0) { exit 1 }
  docker build -f Dockerfile.migrator -t fayanms-local:migrator .
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Write-Log 'Built. Point FAYANMS_IMAGE / FAYANMS_WORKER_IMAGE / FAYANMS_MIGRATOR_IMAGE at these tags in deploy/oci/.env, or push+pin digests for production.'
}

function Test-OciEnvReady {
  $missing = $false
  foreach ($f in @('.env', '.env.app', '.env.worker')) {
    if (-not (Test-Path (Join-Path $Root "deploy\oci\$f"))) {
      Write-WarnOp "Missing deploy/oci/$f — create it from deploy/oci/env.example (SEC-ENV-001) before docker:up."
      $missing = $true
    }
  }
  return (-not $missing)
}

function Invoke-DockerUp {
  if (-not (Test-Command 'docker')) { Die 'Docker is required.' }
  if (-not (Test-OciEnvReady)) { Die 'deploy/oci env files incomplete — see deploy/oci/README.md.' }
  Push-Location (Join-Path $Root 'deploy\oci')
  docker compose --env-file .env up -d
  Pop-Location
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Write-Log 'Compose stack up — run: ops\ops.bat health'
}

function Invoke-DockerDown {
  if (-not (Test-Command 'docker')) { Die 'Docker is required.' }
  Push-Location (Join-Path $Root 'deploy\oci')
  docker compose --env-file .env down
  Pop-Location
  Write-Log 'Compose stack down.'
}

function Invoke-DockerLogs {
  if (-not (Test-Command 'docker')) { Die 'Docker is required.' }
  Push-Location (Join-Path $Root 'deploy\oci')
  docker compose --env-file .env logs -f --tail=100 app worker caddy
  Pop-Location
}

function Invoke-Backup {
  if (-not (Test-Command 'bash')) {
    Die 'backup runs the bash script deploy/oci/backup.sh — use WSL or Git Bash (add bash to PATH), or run on the Linux host.'
  }
  bash deploy/oci/backup.sh @args
}

function Invoke-RestoreDrill {
  if (-not (Test-Command 'bash')) {
    Die 'restore-drill runs the bash script deploy/oci/restore-drill.sh — use WSL or Git Bash (add bash to PATH), or run on the Linux host.'
  }
  bash deploy/oci/restore-drill.sh @args
}

function Invoke-ReleaseEvidence {
  Ensure-Bun
  bun scripts/release/evidence-manifest.ts @args
}

# ── dispatch ──────────────────────────────────────────────────────────────

$Command = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$Rest    = @(); if ($args.Count -ge 2) { $Rest = $args[1..($args.Count - 1)] }

switch ($Command) {
  'help'             { Invoke-Help }
  'doctor'           { Invoke-Doctor }
  'install'          { Invoke-Install }
  'db:up'            { Invoke-DbUp }
  'db:up:docker'     { Invoke-DbUpDocker }
  'db:down'          { Invoke-DbDown }
  'migrate'          { Invoke-Migrate }
  'seed'             { Invoke-Seed }
  'db:reset'         { Invoke-DbReset }
  'dev'              { Invoke-Dev }
  'build'            { Invoke-Build }
  'start'            { Invoke-Start }
  'test'             { Invoke-Test }
  'lint'             { Invoke-Lint }
  'typecheck'        { Invoke-Typecheck }
  'keys:service'     { Invoke-Keys }
  'health'           { Invoke-Health }
  'docker:build'     { Invoke-DockerBuild }
  'docker:up'        { Invoke-DockerUp }
  'docker:down'      { Invoke-DockerDown }
  'docker:logs'      { Invoke-DockerLogs }
  'backup'           { Invoke-Backup @Rest }
  'restore-drill'    { Invoke-RestoreDrill @Rest }
  'release:evidence' { Invoke-ReleaseEvidence @Rest }
  default            { Die "Unknown command: $Command — run 'ops\ops.bat help'." }
}
