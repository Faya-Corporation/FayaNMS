# Deploying FayaNMS on Windows Server + Docker Desktop — full remaining-task runbook

**Audience:** the engineer who will stand this repository up on a Windows Server host using
Docker Desktop (Linux containers).
**Scope:** everything still needed to go from `git clone` to a running, backed-up,
upgradeable stack on one Windows Server box — the containerization slice of audit
**Phase 21** (production *infrastructure*). This does **not** close the production
data-plane blockers (PostgreSQL/Redis/KMS, real adapters) — those remain Phase 21/22/22/23.

Grounded in the repo as of commit `8804535` (R10 closeout, CI runs #6–#9 green).
**Status update 2026-09-12 (R12): the repository-side Phase B tasks T1/T1b/T2/T3/T6
and the repo-side half of T7 are LANDED** — `Dockerfile`, `Dockerfile.worker`,
`compose.yml`, `.dockerignore` and `docs/deploy/env.production.example`
now exist at the repo root / docs; **T4 was superseded by the next-auth 4.24.15 patch
upgrade** (the accepted-risk ledgers are now empty — see T4). Per-task status markers
below are kept current. The host-side work (Phase A/C/D) remains the deployer's to
execute and tick.

---

## 0. Current-state facts this plan is built on (verify nothing — it is verified)

| Fact | Source | Consequence |
|---|---|---|
| `next.config.ts` has `output: "standalone"` | next.config.ts | Container image is small; the build script already copies `static` + `public` into the standalone dir |
| Prisma datasource is **PostgreSQL** (Phase 21 slice 1, 2026-09-13); the SQLite-safety rules are RETAINED as portability discipline — no enums / no Json (String+`*Json` columns), 900-line schema | prisma/schema.prisma | compose ships a `postgres:16-alpine` service with its own named volume; the startup security policy REJECTS missing/non-postgres `DATABASE_URL` in production |
| Build/start scripts use POSIX `cp`/`tee` (`next build && cp -r …`, `bun … \| tee server.log`) | package.json | **Never run these natively in Windows PowerShell/cmd** — containers (Linux) are mandatory, not stylistic |
| App → worker calls go through `WORKER_BASE_URL` (env-configurable, runbook T5 as landed 2026-09-13; default preserves the historical `http://localhost:3030` loopback) in 4 route files (`devices/test-connection`, `worker/change-step`, `worker/status`, `admin/collectors`) | src/lib/worker/worker-url.ts + src/app/api/v1/** | Bare-metal dev needs NO env var; compose sets `WORKER_BASE_URL=http://worker:3030` on a normal bridge network (T3/T5) |
| Worker → app calls go through `NEXT_BASE_URL` (env-configurable, T5; default preserves `http://localhost:3000`) | mini-services/worker/next-client.ts | Same — compose sets `NEXT_BASE_URL=http://app:3000`; the worker's loopback self-calls stay container-local (`SELF_BASE_URL`) |
| Worker port **hardcoded 3030**, "do not read PORT env" (Task 2-b contract) | mini-services/worker/index.ts | The stack exposes exactly **one** port (3000); 3030 stays internal — same model as the sandbox gateway |
| `siteUrl()` **throws** in production without `NEXT_PUBLIC_SITE_URL`, and **rejects `localhost` / `127.0.0.1` / `0.0.0.0` / `*.local` hostnames** in production | src/lib/brand/identity.ts (B3-029) | You need a real DNS name (or a raw LAN IP — IPs pass the guard) baked at **build time** |
| Startup security policy (production) **aborts** unless: `NEXTAUTH_SECRET` ≥ 32 chars, `FAYANMS_SERVICE_SECRET` 64-hex, `FAYANMS_CONFIG_ENC_KEY` 64-hex, and `FAYANMS_DEMO_MODE ≠ true` | src/lib/startup/security-policy.ts, .env.example | Secrets must be generated per environment; demo seeding is a separate, non-production step |
| Demo seed gate: requires `FAYANMS_DEMO_MODE=true` **and** refuses under production NODE_ENV | prisma/seed.ts:2443 | Seed in a one-off container without `NODE_ENV=production`, then run the app clean |
| CI `scan` job's trivy step **is ACTIVE since 2026-09-12** (fs scan, HIGH/CRITICAL, exit-code 1; first verified scans: 0 vulns / 0 misconfigs / 0 secrets — the planned `.trivyignore` mirror never had to land, see T4) | .github/workflows/ci.yml step 12 | Any new HIGH/CRITICAL advisory or Dockerfile misconfig turns CI red — fix forward; the `osv-scanner.toml` accepted-risk ledger is EMPTY today, keep it that way unless a finding genuinely requires a major migration |
| CI is active (`gate` + `scan` on every push to `main`) — branch protection currently OFF, restore tracked as OPS-001 | README honest-status block | All repo-side tasks land via normal pushes; every push must stay green |

Demo dataset sign-in (only when seeded): `admin@faya.local` / `faya123` — **demo-only**,
advertised by the sign-in gate by design. Do not expose such a deployment to untrusted networks.

---

## 1. Host-platform reality check (read before buying the plan)

Docker Desktop is officially supported on **Windows 10/11**, not on Windows Server SKUs.
On Windows Server you have three working routes — pick one in this order:

1. **Recommended: WSL2 (Ubuntu 22.04/24.04) + Docker Engine inside WSL2.** Fully
   functional, standard `apt`-managed engine, compose v2 plugin, no Desktop licensing.
   This is the route detailed below; everything else (compose file, images) is identical.
2. **Docker Desktop on the box anyway** — installs and runs on many Server 2022 builds via
   WSL2, but it is outside Docker's support matrix and its GUI/licensing (paid for larger
   orgs) buys you nothing headless. Only choose if policy demands the Desktop SKU.
3. **Rancher Desktop / Podman Desktop** inside WSL2 — alternatives with the same compose
   workflow; adjust only §A.4.

Everything in Phases B–D is host-agnostic after this choice: the stack is Linux containers.

---

## Phase A — Windows Server host preparation (one-time)

- [ ] **A1. Hardware/BIOS:** virtualization enabled (Intel VT-x / AMD-V), ≥ 4 vCPU,
      ≥ 8 GB RAM for the host (the WSL2 VM gets 4–6 GB), ≥ 60 GB free disk on the
      system drive (WSL2 ext4 disk grows on C: by default).
- [ ] **A2. Enable WSL2** (PowerShell **as Administrator**), then reboot:

  ```powershell
  dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
  dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  # reboot, then:
  wsl --set-default-version 2
  wsl --install -d Ubuntu-22.04
  ```

- [ ] **A3. Cap WSL2 resources** — `C:\Users\<you>\.wslconfig`:

  ```ini
  [wsl2]
  memory=6GB
  processors=4
  swap=2GB
  ```

  then `wsl --shutdown` and reopen.
- [ ] **A4. Install Docker Engine inside Ubuntu WSL2** (official docker.com apt repo;
      `docker compose` v2 plugin included). Add your user to the `docker` group.
- [ ] **A5. Make Docker survive reboots:**
  - In `/etc/wsl.conf`: `[boot]` → `systemd=true` (then `systemctl enable --now docker`), **or**
  - Task Scheduler (Windows): at system startup run
    `wsl.exe -d Ubuntu-22.04 -u root service docker start`.
- [ ] **A6. Keep the stack OUT of `/mnt/c`.** Clone the repo and keep compose state under
  the WSL2 ext4 home (`~/fayanms`). Bind-mounts from `/mnt/c` are 9p-slow and
  **database volumes on 9p risk corruption/fsync breakage** — the #1 Windows-specific
  footgun (applies equally to the PostgreSQL data volume).
- [ ] **A7. Windows Defender Firewall inbound rules** (PowerShell as admin) — open only
  what you publish (80/443 with the proxy in D2; add 3000 only if you skip the proxy):

  ```powershell
  New-NetFirewallRule -DisplayName "FayaNMS HTTP"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow
  New-NetFirewallRule -DisplayName "FayaNMS HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
  ```

- [ ] **A8. Name the server.** Create a DNS A record, e.g. `fayanms.<yourcorp>.com` (or
  `.intra`/`.lan` — **anything except `.local`**, which mDNS owns AND `siteUrl()` rejects
  in production). A raw LAN IP (e.g. `http://10.20.30.40`) also passes the guard if DNS is
  unavailable — DNS preferred, IP acceptable for LAN pilots.

---

## Phase B — repository-side implementation tasks (land as PRs/pushes to `main`)

All tasks below are currently **open** — none exist in the repo yet. Order matters
(T4 before T1; T1 before T3).

### T1 — `Dockerfile` (app, multi-stage, bun-based) — **LANDED 2026-09-12 (R12)**

Reference implementation (adapt, don't cargo-cult):

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_SITE_URL          # REAL origin, e.g. http://fayanms.corp.example.com
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY . .
RUN bunx prisma generate && bun run build   # cp -r steps inside the script are POSIX — fine in Linux

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S faya && adduser -S faya -G faya
COPY --from=build --chown=faya:faya /app/.next/standalone ./
COPY --from=build --chown=faya:faya /app/prisma ./prisma
# Prisma query engine + client must survive standalone tracing:
COPY --from=build --chown=faya:faya /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=faya:faya /app/node_modules/@prisma  ./node_modules/@prisma
USER faya
# No DATABASE_URL in the image (Phase 21): compose composes the PostgreSQL URL
# from POSTGRES_PASSWORD; the startup policy aborts without a postgres URL.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "server.js"]
```

Acceptance criteria:
- [ ] Image builds from a clean clone; `docker run` serves the sign-in gate on :3000.
- [ ] `NEXT_PUBLIC_SITE_URL` is a **build ARG carrying the real origin** — NOT the CI
      `.invalid` placeholder (OG/metadata are baked into the bundle at build time).
- [ ] No `DATABASE_URL` baked into the image — it arrives from compose
      (`postgresql://fayanms:<POSTGRES_PASSWORD>@postgres:5432/fayanms`); a container
      started without it aborts at the startup security policy.
- [ ] Runs as non-root; `.prisma`/`@prisma` engine dirs verified present (boot fails fast
      without them — test on a clean machine, not just the build host).
- [ ] Container `HEALTHCHECK` green; `docker inspect --format='{{.State.Health.Status}}'` → `healthy`.

As-landed deviations from the reference above (deliberate, recorded for honesty):
- Runtime base is `oven/bun:1.3.14-slim` (debian), **not** `-alpine` — the Prisma query
  engine and sharp prebuilds are produced in the glibc build stage; musl would mismatch.
- The non-root uid is PINNED (`10001`). Phase 21 note: with persistence moved to
  PostgreSQL the app container is STATELESS — the original `/data/fayanms` volume, its
  chown, and the provision-time ownership handback are all GONE; the uid remains as
  defense-in-depth.
- A fail-fast `RUN test -n "$NEXT_PUBLIC_SITE_URL"` guard turns a missing build arg into
  a human-readable error instead of a deep `siteUrl()` throw during prerender.
- `PORT=3000` / `HOSTNAME=0.0.0.0` pinned explicitly for the standalone server binding.

### T1b — `.dockerignore` — **LANDED 2026-09-12 (R12)**

```
node_modules/**/.deps, simplified: node_modules, .next, db, upload, .scratch, agent-ctx,
.env*, dev.log, server.log, *.out, *.pid, skills, tool-results, .git
```

Acceptance: build context ≤ tens of MB; no `.env*` in the image (`docker history`/`export` check).

### T2 — `Dockerfile.worker` — **LANDED 2026-09-12 (R12)** (slim base, `USER bun`, HEALTHCHECK on `/health`)

```dockerfile
FROM oven/bun:1.3.14
WORKDIR /worker
COPY mini-services/worker/package.json ./
RUN bun install
COPY mini-services/worker/ .
USER bun
CMD ["bun", "index.ts"]
```

Acceptance: `GET /health` returns `ok:true` with adapter names (from inside the
worker container, and from the app container via the bridge network since T5);
no port published (3030 is internal by contract).

### T3 — `compose.yml` — the topology that makes the service contracts work — **LANDED 2026-09-12 (R12)**, topology updated by T5 (2026-09-13)

The worker must reach the app **and** the app must reach the worker. R12 landed
the zero-code-change solution (worker shares the app's network namespace);
T5 (below) replaced it on 2026-09-13 with the proper two-container bridge
network once both directions became env-configurable. The reference snippet
below reflects the CURRENT as-landed topology:

```yaml
name: fayanms

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: fayanms
      POSTGRES_DB: fayanms
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?required}"   # Phase 21 slice 1
    volumes:
      - fayanms-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fayanms -d fayanms"]
      interval: 10s
      timeout: 5s
      retries: 12
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }

  app:
    build:
      context: .
      args: { NEXT_PUBLIC_SITE_URL: "${NEXT_PUBLIC_SITE_URL}" }
    image: fayanms-app:latest
    restart: unless-stopped
    env_file: .env.production
    environment:
      NODE_ENV: production
      WORKER_BASE_URL: "${WORKER_BASE_URL:-http://worker:3030}"   # T5: app → worker hop
      DATABASE_URL: "postgresql://fayanms:${POSTGRES_PASSWORD}@postgres:5432/fayanms"
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "80:3000"        # or via reverse proxy (D2) — then publish nothing here
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }

  worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    image: fayanms-worker:latest
    restart: unless-stopped
    env_file: .env.production
    environment:
      NEXT_BASE_URL: "${NEXT_BASE_URL:-http://app:3000}"   # T5: worker → app hop
    depends_on: [app]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }

volumes:
  fayanms-pgdata:
```

As landed, `compose.yml` additionally ships a **`provision` service** (compose profile
`provision`; builds the Dockerfile `build` target, which carries the full prisma CLI) for
the T7 one-off schema/seed jobs, and the published port is `${FAYANMS_HTTP_PORT:-80}:3000`.
All compose commands take `--env-file .env.production` (build-arg interpolation source).

Acceptance criteria:
- [ ] End-to-end golden path: sign in → Devices → Test Connection (app→worker hop) works;
      Job Center shows runner claims (worker→app hop); scheduler tick visible in
      `POST /api/v1/worker/tick` audit rows.
- [ ] `restart: unless-stopped` + host reboot → stack returns automatically.
- [ ] `docker compose down && up` against the same `fayanms-pgdata` volume **preserves
      data** (PostgreSQL survives redeploys; this is the regression that matters most).

### T4 — CI pre-work BEFORE the Dockerfile lands: `.trivyignore` — **SUPERSEDED by a dependency fix, 2026-09-12 (R12)**

The original plan mirrored the four `osv-scanner.toml` entries (next-auth v4 ×3,
uuid@8.3.2 ×1) into a `.trivyignore`, because trivy's activated HIGH/CRITICAL gate would
re-flag them (and trivy keys findings by CVE ID, not GHSA — the mirror had to be CVE-keyed).
The local pre-push scan then surfaced a better path: the upstream v4 **patch** line
next-auth **4.24.15** (2026-07-20) fixes the advisories AND moves the uuid dependency to
^11.1.1 — no v5 migration needed for these four. R12 therefore upgraded
next-auth 4.24.13 → 4.24.15 and:

- dropped the four `osv-scanner.toml` entries per that ledger's own rules (osv-scanner
  v2.5.1 on the new `bun.lock`: "No issues found", all four ignores explicitly UNUSED);
- never landed `.trivyignore` — trivy 0.74.0 on the R12 tree: **0 vulnerabilities
  (bun.lock), 0 misconfigurations (Dockerfile + Dockerfile.worker), 0 secrets** at
  HIGH/CRITICAL.

First real container-scan run in the repo's history = the CI run on the R12 commit. The
next-auth v5 migration remains desirable for platform reasons but is NO LONGER
security-forced.

### T5 — configurable service URLs — **LANDED 2026-09-13 (R13)**

As specified: `mini-services/worker/next-client.ts` now resolves `NEXT_BASE_URL`
(`process.env` with fallback `http://localhost:3000`), the four app-side literals
resolve `WORKER_BASE_URL` (fallback `http://localhost:3030`) via the new
`src/lib/worker/worker-url.ts` single source of truth, and compose switched to a
normal bridge network. As-landed details:

- **Env vars:** `WORKER_BASE_URL` (app → worker), `NEXT_BASE_URL` (worker → app),
  `SELF_BASE_URL` (worker → itself, container-local loopback). All three trim,
  fall back to the loopback default when unset/blank, and **fail fast at module
  load** on a malformed value (same philosophy as `siteUrl()`).
- **Display strings follow the config:** the collectors registry `host` field now
  derives from the resolved URL (`WORKER_HOST`) instead of the hardcoded
  `"localhost:3030"`.
- **compose.yml:** `network_mode: "service:app"` removed; `WORKER_BASE_URL:
  "${WORKER_BASE_URL:-http://worker:3030}"` on the app, `NEXT_BASE_URL:
  "${NEXT_BASE_URL:-http://app:3000}"` on the worker — `${VAR:-default}` form so
  a custom topology can still override via the `--env-file`.
- **Bare-metal dev unchanged:** no env var needed anywhere; loopback defaults
  preserve the Task 2-b contracts byte-for-byte.

### T6 — `.env.production` template + secrets — **LANDED 2026-09-12 (R12)**: `docs/deploy/env.production.example`

Add `docs/deploy/env.production.example` mirroring `.env.example` with the container
values (canonical URLs; `POSTGRES_PASSWORD` — compose composes `DATABASE_URL` from it,
Phase 21). Never commit real values (`.env*` is gitignored — gitleaks in CI also watches
this).

Generation (inside WSL2):

```bash
openssl rand -hex 32   # NEXTAUTH_SECRET          (≥32 chars)
openssl rand -hex 32   # FAYANMS_SERVICE_SECRET   (64 hex)
openssl rand -hex 32   # FAYANMS_CONFIG_ENC_KEY   (64 hex) — this is the KEK that
                       # encrypts all config snapshots; LOSING IT = losing backups
openssl rand -hex 32   # POSTGRES_PASSWORD        (64 hex) — compose composes the
                       # app's DATABASE_URL from it; changing it later requires
                       # an ALTER USER + volume plan (see troubleshooting)
```

`FAYANMS_CONFIG_ENC_KEY_ID=k1`. If you ever rotate the KEK, the old key must remain
available to decrypt historical snapshots — document the rotation before doing one.

### T7 — Database provisioning strategy — **repo-side LANDED 2026-09-12 (R12)** via the `provision` compose service; **migrate-deploy path since Phase 21 slice 2 (2026-09-13)**; the demo-vs-pristine CHOICE happens at first deploy

Two mutually exclusive paths, chosen at first deploy. Both use the `provision` service
(the Dockerfile **build** stage — the slim runtime deliberately does not carry the prisma
CLI) and both target the `postgres` service directly. Since Phase 21 there is NO
ownership handback — the database lives in PostgreSQL, not on a file volume. Both paths
replay the COMMITTED migration history (`prisma/migrations`) via `prisma migrate deploy`
— `db:push` is a dev-only scratch tool and must never touch this database (and since
P2-3 the plain `db:push` itself refuses destructive diffs — the only way to force one
is the explicitly named `db:push:force`, which you should have NO reason to run here):

- **Demo dataset (matches everything the demo surfaces expect):** one-off **`provision`
  container** **without** `NODE_ENV=production` **with** `FAYANMS_DEMO_MODE=true`:

  ```bash
  docker compose --env-file .env.production run --rm --no-deps -e NODE_ENV= \
    -e FAYANMS_DEMO_MODE=true provision \
    sh -c 'bunx prisma migrate deploy && bun prisma/seed.ts'
  ```

- **Pristine:** same migrate deploy, no seed — then create your real admin through the
  app's own user management. Verify the first-run experience before choosing this on a box
  anyone else can reach.

  ```bash
  docker compose --env-file .env.production run --rm --no-deps provision \
    sh -c 'bunx prisma migrate deploy'
  ```

  Then start the stack **without** `FAYANMS_DEMO_MODE` (the startup policy forbids it in
  production — it stays empty in `.env.production`; the demo flag above lives only inside
  the one-off `docker compose run` invocation). Sign-in when seeded:
  `admin@faya.local` / `faya123`.

Acceptance: after provisioning, `GET /` sign-in renders; the startup security policy does
not abort (check `docker compose logs app` for the policy banner).

---

## Phase C — first deployment walkthrough (on the server)

```bash
# in WSL2 Ubuntu
sudo apt install -y git && git clone https://github.com/fayafatehi/FayaNMS.git ~/fayanms
cd ~/fayanms
git config core.autocrlf input          # guard against CRLF if checked out on Windows earlier

cp docs/deploy/env.production.example .env.production   # then edit: 3 secrets + URL
docker compose --env-file .env.production build          # build args need the env-file
docker compose --env-file .env.production run --rm --no-deps -e NODE_ENV= \
  -e FAYANMS_DEMO_MODE=true provision \
  sh -c 'bunx prisma migrate deploy && bun prisma/seed.ts'
                                                       # T7 demo path (pristine: migrate deploy only)
docker compose --env-file .env.production up -d
docker compose ps && docker compose logs -f app          # watch the startup policy pass
```

- [ ] `curl -I http://localhost/` from WSL → 200 (sign-in gate).
- [ ] From a LAN machine: `http://fayanms.<yourcorp>.com` renders the sign-in gate with
      the canonical lockup; browser console clean; favicon local.
- [ ] Golden path (R8's browser script): dashboard → Devices search/filter → command
      palette → Device Detail → Job Center shows a runner claim → audit trail row exists.
- [ ] `docker compose logs app` shows **no** `security-policy` abort, **no**
      `NEXT_PUBLIC_SITE_URL` throw.

---

## Phase D — day-2 operations

- [ ] **D1. Backups (Task-Scheduler-driven, weekly minimum):** consistent live dumps via
  `pg_dump` — no stop/start needed (Phase 21: the database is PostgreSQL):

  ```bash
  docker compose exec -T postgres pg_dump -U fayanms -d fayanms -Fc \
    > ~/backups/fayanms-$(date +%F).dump
  ```

  Trigger from Windows: `wsl.exe -d Ubuntu-22.04 -u root bash -lc 'cd ~/fayanms && ./backup.sh'`.
  Keep N weekly + 4 daily off-box copies. Restore drill: create a throwaway postgres
  container, `pg_restore` into it, point the app at it once, then delete. Custom format
  (`-Fc`) is compressed and supports selective restore.
- [ ] **D2. TLS/reverse proxy (recommended before any non-LAN exposure):** Caddy sidecar
  with a mounted volume for its CA/certs, proxying to `app:3000`; flip compose to publish
  80/443 only. If a corporate cert exists, mount it instead. `NEXTAUTH_URL` /
  `NEXT_PUBLIC_SITE_URL` become `https://…` and the images must be **rebuilt** (the URL is
  a build-time ARG — T1).
- [ ] **D3. Upgrade procedure** (the repo ships a COMMITTED migration history —
  `prisma/migrations` — applied via `prisma migrate deploy`):

  ```bash
  cd ~/fayanms && git pull
  docker compose --env-file .env.production build
  docker compose --env-file .env.production run --rm --no-deps provision \
    sh -c 'bunx prisma migrate deploy'   # applies any NEW migrations; no-op when current
  docker compose --env-file .env.production up -d
  ```

  Take a D1 `pg_dump` snapshot immediately before every upgrade. Migrations are
  forward-only, and CI proves on every push that (a) the committed history applies to a
  fresh database and (b) the history reproduces `prisma/schema.prisma` exactly (drift
  guard) — so `migrate deploy` is deterministic. `db:push` is a dev-only scratch tool
  (fail-tight since P2-3: `db:push:force` is the only path that accepts data loss);
  never point it at this database (a schema change must land as a migration, or CI's
  drift guard fails the push).
- [ ] **D4. Monitoring:** external uptime probe against `/` (sign-in gate is public);
  worker liveness is already modeled — `GET /api/v1/worker/status` (app-authenticated)
  proxies `/health` with job counters + scheduler state. `docker events` → optional
  Uptime Kuma sidecar.
- [ ] **D5. Clock:** WSL2 clock drifts after host sleep/patching; JWT/expiry checks are
  time-based. Schedule `wsl --shutdown` weekly or run `hwclock -s` in a boot task.

---

## Troubleshooting matrix (Windows-specific first)

| Symptom | Root cause | Fix |
|---|---|---|
| Startup abort: `NEXT_PUBLIC_SITE_URL is required/… localhost/.local` | B3-029 guard | Real DNS name or LAN IP; **rebuild** the image (build-time ARG), not just env |
| Startup abort: security policy (secret too short / demo mode / non-postgres DATABASE_URL) | policy contract | Regenerate secrets per T6 (incl. POSTGRES_PASSWORD); run app without `FAYANMS_DEMO_MODE`; keep `DATABASE_URL` as the compose-composed postgres URL |
| `postgres: password authentication failed` | stale `fayanms-pgdata` volume created under an earlier POSTGRES_PASSWORD | `docker compose down -v` DESTROYS data — take a D1 dump first — or `ALTER USER fayanms WITH PASSWORD` inside the container; then keep POSTGRES_PASSWORD stable |
| Live probe/backup fails: `SSH_HOSTKEY_UNENROLLED` (fail-closed by design) | the endpoint has no pinned host key yet | Enroll from the device page (SSH Host Key card): probe → verify the fingerprint out-of-band → pin; then retry |
| Live connection fails: `SSH_HOSTKEY_MISMATCH` | the endpoint presented a DIFFERENT key than the pinned enrollment (device re-provisioned, key rotated, or an impostor) | Treat as a security signal FIRST — verify the new key out-of-band; only then Re-enroll from the device page (the old pin is replaced, audited) |
| API answers `429 RATE_LIMITED` with a `Retry-After` header | pre-handler rate gate (SAFE-002): 120 mutations/min, 300 reads/min per client key — or a whole office NAT sharing one key | Expected for abusive loops; wait out the `Retry-After` window (≤60 s). If legitimate humans collide behind one NAT, split them across egress IPs, or (advanced) raise the budgets in `src/lib/api/rate-gate.ts` — never disable the gate |
| Multi-device change stopped at the FIRST failing device; later devices show `SKIPPED` | fail-fast containment (SAFE-006): the APPLY loop stops at the first failure — later devices are never contacted (previously they were applied anyway and then mislabeled) | Expected protective behavior. Read the step error + the `APPLY_FAIL_FAST` audit event (stop host, first error, applied/failed/uncontacted map), fix the failing device, then re-execute; devices already applied keep `SUCCESS` and their post-apply snapshots |
| Post-rollback validation FAILED: `applied marker still present after rollback — restore did not complete` | context-aware post-rollback validation (SAFE-006): after a restore the assertion is INVERTED — the applied marker must be GONE; its presence means the restore did not take effect | Investigate that device first (the ROLLBACK step output names what was restored); verify its config manually and restore via a new change — treat the stuck marker as a real half-applied state, not a validation bug |
| Execute answers `409 EXECUTION_IN_FLIGHT` | single-flight guard (SAFE-003): this change ALREADY has a queued/running execution (double-click or retry while the first job is alive) | Follow the active job named in the error (id + correlation) in the Job Center instead of re-queuing; the lease auto-releases when the execution reaches a terminal state |
| Change driver logs `409 DEVICE_WRITE_LOCKED … (held by change …)` | per-device write lock (SAFE-005): another executing change currently owns a device in this change's scope — one change, one device, one step at a time | Expected under contention: the job requeues automatically (30 s × attempts backoff) and resumes when the holder's step completes; if the holder is wedged, the tick reaper / 15-min lock expiry clears it — investigate the HOLDING change first |
| Restore change fails with `RESTORE_TARGET_UNRESOLVABLE` (apply step, devices SKIPPED) | fail-closed target guard (SAFE-008): the approved snapshot is gone (deleted → FK SetNull), belongs to another device, or failed its stored digest | This is by design — the engine never guesses a substitute restore source. Re-file the restore from the device page against an existing snapshot; check `RESTORE_REFUSED` in the audit trail for the typed reason |
| Execute answers `409 APPROVALS_PENDING` naming levels | bindable approval gate (POL-001): each level needs its quorum of DISTINCT approvers decided — CAB on CRITICAL changes needs TWO | Have the required approvers decide under their own accounts (one person can never fill two slots — a wildcard holder that already decided a level is refused `DECISION_STILL_VALID`) |
| Execute answers `409 APPROVAL_EXPIRED` and the change moved back to AWAITING_APPROVAL | validity horizon (POL-003): quorum-counting approvals outlived their risk-tiered window (CRITICAL 14d · HIGH 30d · MEDIUM 90d · LOW 180d) | Expected protective behavior — run a fresh approval cycle (the same approvers can re-cast; their expired history is superseded), then execute again |
| Execute answers `409 APPROVAL_FINGERPRINT_MISMATCH` (audit: `CHANGE_EXECUTE_FINGERPRINT_MISMATCH`) | fingerprint binding (POL-002): the change's current devices/operations/restore-target/schedule no longer hash to what the approvers approved — out-of-band edits are real drift | Re-approval required by design: an approval authorizes exactly the spec it saw. Audit the audit trail for WHO moved the spec, fix the intent, collect fresh approvals, execute |
| Execute answers `409 APPROVALS_REBIND_REQUIRED` | the approval gate carries pre-POL data (APPROVED rows with no bindable decisions or no verifiable validity horizon) | One-time migration posture: re-approve the change under the bindable model; new changes always provision quorum-stamped rows and bindable decisions |
| App can't reach postgres / connection refused | postgres not healthy yet, or topology override broke DNS | `docker compose ps` (health check), `docker compose logs postgres`; app retries are NOT automatic — `docker compose restart app` after postgres is healthy |
| Worker logs "backend unreachable" loops | app not reachable at `NEXT_BASE_URL` (e.g. typo'd env override) | compose default `http://app:3000` (T5) is correct for the shipped stack — verify `WORKER_BASE_URL`/`NEXT_BASE_URL` overrides in the `--env-file`; the worker self-heals with backoff once reachable |
| App routes report "Worker service unreachable" | worker not reachable at `WORKER_BASE_URL` | compose default `http://worker:3030` (T5); check `docker compose ps`/worker `HEALTHCHECK`, and that 3030 was never published/firewalled |
| `docker: command not found` after reboot | boot persistence missing | A5 (systemd in wsl.conf or Task Scheduler task) |
| WSL2 fails to start | virtualization disabled | BIOS VT-x/AMD-V + `VirtualMachinePlatform` feature |
| Everything slow, image builds minutes | repo on `/mnt/c` | A6 — clone into WSL ext4 |
| Port 3000 already in use | IIS/other service | free it or change the published port; keep the **internal** 3000 (hardcoded contracts) |
| Build throws `cp: cannot stat` | Windows-native shell ran package scripts | only build inside Linux containers (T1) |
| CRLF breaks shell scripts in image | autocrlf on clone | A: `git config core.autocrlf input`, re-clone |

---

## Security notes for this deployment shape

1. **Expose one port** (80/443). 3030 is backend-to-backend by contract and must never be
   published; the service-JWT (`FAYANMS_SERVICE_SECRET`) protects it even inside the host.
2. The three secrets in `.env.production` are the entire threat surface for config-at-rest
   (`FAYANMS_CONFIG_ENC_KEY` = KEK) and impersonation (`NEXTAUTH_SECRET`,
   `FAYANMS_SERVICE_SECRET`). NTFS/ACL-protect the file, back it up **separately from DB
   backups**, and never commit it (gitleaks runs on every push).
3. Demo credentials (`faya123`) are a designed feature of the seeded dataset — acceptable
   on an isolated LAN pilot; rotate/delete seeded users before any broader exposure.
4. Branch protection, `gate`+`scan` required checks, and the owner direct-push bypass are
   already live at the GitHub side (SOCIAL-REPOSITORY §6); keep landing server-side
   changes through pushes so CI keeps proving the image inputs.
5. `enforce_admins=false` means **whoever controls the owner credential controls `main`**
   — on a shared Windows Server host, protect the deployment key (the PAT/credential
   helper used for `git pull`) accordingly.
6. **LIVE_SSH secrets (Phase 22) live ONLY on the worker**: the app stores vault
   references; the worker resolves them from `FAYANMS_VAULT_*` entries in
   `.env.production` at connect time. The compose `worker` service carries the env_file —
   protect that file exactly like the other secrets (item 2) and never publish 3030
   beyond the host (the service JWT + the plan validation / per-flavor command
   templates are the device-control gates — the app can never send command text).
7. **SSH host-key pinning (SAFE-001, audit P0-001)** is a device-control gate too:
   every LIVE_SSH connection is refused unless the endpoint's host key was enrolled
   from the device page (probe → out-of-band verification → pin; the `SshHostKey`
   table holds one key per host+port). The worker verifies the pinned fingerprint
   DURING the handshake, BEFORE authentication — a key mismatch (`SSH_HOSTKEY_MISMATCH`)
   or a missing enrollment (`SSH_HOSTKEY_UNENROLLED`) kills the connection with no
   credential sent. Host-key enrollment/revocation is audited (`SSH_HOSTKEY_*` events);
   after a legitimate device key rotation, re-enroll from the device page.
8. **Pre-handler rate gate (SAFE-002, audit P0-002)**: every `/api/v1` request is
   budgeted in the proxy plane BEFORE a handler runs (120 mutations / 300 reads per
   minute per client key), so a throttled mutation can no longer commit side effects
   and then answer 429. The client key is the `X-Forwarded-For` entry N hops from the
   RIGHT — set `FAYANMS_TRUST_PROXY_HOPS` to the number of reverse proxies in front of
   the app (default 1 = this compose stack's single Caddy/Nginx; 0 = trust nothing,
   all callers share one conservative bucket). A VERIFIED service JWT (worker loops)
   is exempt; forged, rotated or absent-leftmost XFF entries cannot mint fresh
   budgets. In-memory store (per-process): a horizontally scaled app needs a shared
   store (Redis) before budgets mean anything fleet-wide.
9. **Execution concurrency guards (SAFE-003/004/005, audit P0-003)** are device-control
   gates too: ONE queued/running execution per change (a DB lease — a racing execute
   POST is refused `409 EXECUTION_IN_FLIGHT`), one atomic CAS step claim (a lost
   claimant gets `409 STEP_IN_FLIGHT`), and exclusive per-device write locks so two
   changes can never interleave work on the same hardware (`409 DEVICE_WRITE_LOCKED`
   names the holder). Enforcement is database-side (lease PK = changeId, lock deviceId
   unique), so it holds across multiple app/worker instances; a requeued retry is the
   same execution and keeps its lease; both guards carry generous expiries (4 h lease,
   15 min lock) purely as crash valves — the tick reaper and the engine's own release
   paths are the normal lifecycle.
10. **Fail-fast multi-device apply + truthful states (SAFE-006, audit P0-005)** is a
   blast-radius gate: a multi-device change STOPS at the first failing device — later
   devices are never contacted (previously they were modified anyway and then labeled
   SKIPPED). Per-device results are truthful (`SUCCESS` = applied, its post-apply config
   snapshotted even on a failed step; `FAILED` = the stopper; `SKIPPED` = provably
   never contacted), every stop writes an `APPLY_FAIL_FAST` audit event with the
   disposition map, the ROLLBACK executor restores only the devices the apply actually
   reached, and the post-rollback validation asserts the change is GONE (marker absent)
   on restored devices — never "marker present", which could only fail forever.
11. **Snapshot-exact restore + typed target (SAFE-008/009, audit P0-004)**: a
   restore-as-change carries its approved snapshot on `ChangeRequest.restoreSnapshotId`
   (stamped at creation, immutable) and the engine restores EXACTLY that configuration —
   the simulator plane commits the approved bytes only after a sha256 pre-commit
   verification (`/simulate/restore` refuses a mismatched body with `409 SHA_MISMATCH`),
   the commit echo is re-asserted in the apply transaction and again by the VALIDATE
   step (a restore is "validated" only when the committed config IS the approved
   snapshot, byte for byte). Every unresolvable target refuses fail-closed
   (`RESTORE_TARGET_UNRESOLVABLE` — unset / deleted / cross-device / digest failure,
   zero device contact, `RESTORE_REFUSED` audited). Restore changes over LIVE_SSH
   devices remain refused until full-config pushes are vendor-certified (the live
   transport is certified for bounded description-marker deltas only) — the refusal is
   a capability boundary, not a gap. Rollback of a failed restore = the job's
   pre-restore backup, exactly like any other change.
12. **Bindable approvals (POL-001/002/003, audit §6 P1-001/P1-002)**: every
   approval decision is a first-class record bound to the SHA-256 fingerprint
   of the canonical approved spec and stamped with a risk-tiered validity
   horizon (CRITICAL 14d · HIGH 30d · MEDIUM 90d · LOW 180d). A level is
   satisfied by a quorum of DISTINCT approvers (CAB on CRITICAL changes: two
   people — a wildcard holder that already decided the level is refused
   `DECISION_STILL_VALID`, so no single person can satisfy a CAB quorum). The
   execute gate re-verifies the fingerprint and the validity horizons inside
   the single-flight transaction: spec drift after approval refuses
   `APPROVAL_FINGERPRINT_MISMATCH`; lapsed approvals refuse
   `APPROVAL_EXPIRED` and flip the change back to `AWAITING_APPROVAL` for a
   fresh approval cycle (expired decisions may be superseded by the same
   approvers; live ones cannot). Pre-POL approval data refuses
   `APPROVALS_REBIND_REQUIRED` — the gate never silently bypasses.
13. **Timezone-deterministic risk policy (P1-003, audit §6)**: the business-hours
   risk factor (which feeds the approval-level policy) is evaluated in ONE
   policy IANA timezone — `Asia/Riyadh`, a code constant, not a server/browser
   setting — so the client preview and the server's authoritative score agree
   on any host. Deploy the app and worker in any timezone; do not "fix" risk
   scoring by changing the host clock. The audit trail stamps
   `riskPolicyVersion`/`riskTimezone` on every CHANGE_CREATED/CHANGE_UPDATED
   event so the policy generation is auditable at decision time.
14. **Webhook egress SSRF guard (P1-010, audit §6)**: webhook endpoints and
   WEBHOOK notification channels can only point at public http(s) targets —
   admission refuses loopback/private/link-local/metadata addresses (and the
   encoded-IP forms resolvers accept) with `400 SSRF_BLOCKED`, and the signed
   delivery re-checks the resolved addresses and refuses redirects right
   before every fetch. This is also a host-protection control: the container
   network behind the compose stack (postgres, worker :3030, the host's own
   loopback) is exactly the space the guard refuses to let webhook payloads
   reach from the app plane.
15. **Webhook secrets encrypted at rest (P1-011, audit §6)**: the HMAC
   signing secret of every webhook endpoint is stored KEK-encrypted
   (AES-256-GCM, row-id-bound AAD, `enc1:` envelope in the same column) — a
   DB dump alone no longer reveals a key that forges deliveries. The KEK
   (`FAYANMS_CONFIG_ENC_KEY`) is the crown jewel for THIS surface too
   (item 2); after a KEK rotation run
   `bun scripts/encrypt-webhook-secrets.ts` once against the upgraded
   deployment to re-encrypt every envelope under the new keyId (it is
   idempotent and refuses envelopes minted by keys it does not hold).
16. **The worker vault is a real provider resolver (P1-005, audit §6)**:
   `FAYANMS_VAULT_PROVIDER` selects where the worker resolves
   `vault://…` references from — `env` (default: the Phase 22
   `FAYANMS_VAULT_*` variables, byte-compatible with existing refs),
   `file` (`FAYANMS_VAULT_FILE` → a JSON secrets store looked up by full
   ref, bare path or the env-style name, so migrating from env vars is a
   copy-paste), or `exec` (`FAYANMS_VAULT_EXEC` → a shell-free argv
   template wrapping any real vault CLI — HashiCorp Vault agent, pass,
   1Password CLI, a KMS helper — with the reference substituted at every
   `%s`). In this compose shape keep using `env` with entries in
   `.env.production`, or mount a root-owned `0600` JSON file and switch to
   `file`; the `exec` provider is the escape hatch to a REAL vault without
   embedding vendor SDKs in the worker. Every provider is fail-closed
   (typed `CREDENTIAL_UNRESOLVED`/`VAULT_PROVIDER_*` errors, never a
   fallback, secret values never logged or returned), and the exec deadline
   (`FAYANMS_VAULT_EXEC_TIMEOUT_MS`, default 5 s) hard-kills a hanging
   vault CLI (SIGTERM, then SIGKILL) before the SSH session can stall the
   worker. References never encode a provider — switching backends never
   silently re-interprets an existing reference.
17. **Asymmetric service identity (P1-007, audit §6)**: the internal
   service-JWT plane is no longer HS256-shared-secret trust (where the
   holder of the secret could mint ANY identity). Tokens may be Ed25519
   (`alg: "EdDSA"`) verified against a public-key set — verifiers can
   authenticate but never mint. Run the two-phase, flag-free rotation:
   **Phase 1** — generate keypairs with `bun run keys:service` (once per
   side; the recommended topology is one CONTROL keypair on the Next.js
   app and one WORKER keypair on the worker, each side holding only the
   other's public key); set `FAYANMS_SERVICE_PRIVATE_KEY` on each minter
   and `FAYANMS_SERVICE_PUBLIC_KEYS` on each verifier (comma-separated,
   so old and new keys can overlap during rotation). Both algorithms are
   accepted and minters emit EdDSA immediately. **Phase 2** — remove
   `FAYANMS_SERVICE_SECRET(S)` from every process (`.env.production`,
   compose env, CI): symmetric tokens are then refused outright
   (`SERVICE_ALG_REJECTED`/`WORKER_ALG_REJECTED`) and a leaked shared
   secret no longer mints anything. Protect the private keys like every
   other crown jewel in item 2 — they are the ONLY minting capability
   once Phase 2 completes. `FAYANMS_SERVICE_ISSUERS` must include each
   issuer the verifier expects (`fayanms:control,fayanms:worker` covers
   the two-plane topology). If a key rotates without a process restart,
   clear the worker's token cache via a restart (or call
   `resetServiceTokenCache()` programmatically).
18. **SFOS WebAPI transport + TLS trust (CERT-006, audit §6)**: sophos
   devices drive the live plane over the device WebAPI (TLS, JSON
   envelope: GetAuthStatus probe + GetConfig collection — a hardcoded
   two-action READ-ONLY allowlist; there is no code path that mutates an
   SFOS device, and apply/restore/rollback stay simulator-only). Because
   there is no SSH handshake, host-key pinning does not apply to sophos —
   the trust gate is TLS certificate verification, which is ALWAYS on
   (there is no bypass flag anywhere in the transport): the default anchor
   is the worker's system CA store, and devices with private/self-signed
   certificates are enrolled worker-side via `FAYANMS_WEBAPI_CA_PEM`
   (a PATH to a PEM file or inline PEM with escaped newlines — the HTTPS
   analog of host-key enrollment). A TLS failure refuses the request
   BEFORE the api-key is ever transmitted. The linked credential profile
   must be type API_TOKEN (its secret is the WebAPI api-key, resolved
   worker-side from the vault like every other device secret); the
   app-side invariant enforces the vendor↔profile-type coupling
   (SSH_PASSWORD for the five CLI vendors, API_TOKEN for sophos) and the
   host-key enrollment page refuses sophos devices typed
   (`SSH_HOSTKEY_NOT_APPLICABLE`).
19. **Production config hygiene (P2-1/P2-3/P1-019, external ULTRA audit)**:
   (P2-1) the Next.js process no longer logs every SQL query in
   production (`src/lib/db-log.ts` — production defaults to
   errors+warnings; development keeps full visibility). For time-boxed
   incident debugging set `FAYANMS_DB_QUERY_LOG=true` in
   `.env.production`, restart, and REMEMBER to remove it — query logs can
   carry tenant/device payload and belong in aggregate logs only
   deliberately. (P2-3) `bun run db:push` is fail-tight (a diff that
   would destroy tables/columns refuses in non-interactive contexts);
   `bun run db:push:force` is the explicit scratch reset. On THIS
   deployment neither should ever target the provisioned database — the
   only sanctioned path is `migrate deploy` (T7/D3). (P1-019) production
   startup REFUSES every deterministic sample secret committed to the
   repository — `.github/workflows/ci.yml`'s `NEXTAUTH_SECRET`,
   `FAYANMS_SERVICE_SECRET` and `FAYANMS_CONFIG_ENC_KEY` values are
   blocklisted in the startup policy, and the known-bad check now covers
   all three secret variables plus every `FAYANMS_SERVICE_SECRETS`
   rotation entry (previously only the session secret was blocklist-
   checked). Practical rule unchanged and now enforced: generate real
   secrets with `openssl rand -hex 32`; never copy sample values from
   committed workflow files into `.env.production`.
20. **Login abuse control (AUTH-001-A, independent audit 2026-09-15)**:
   credential sign-in (`POST /api/auth/callback/credentials`) is throttled
   BEFORE password verification — the route answers the standard 429
   envelope with `Retry-After` before NextAuth parses anything, and
   `authorize()` re-checks the guard before the DB lookup + scrypt even if
   a request reaches it another way. Budgets: 10 failed sign-ins per
   source and 30 per targeted account inside a 300 s sliding window (all
   env-tunable with clamped ranges: `FAYANMS_LOGIN_WINDOW_SECONDS` 30–3600,
   `FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE` 3–100,
   `FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT` 5–200). A locked account backs
   off exponentially (30 s·2^n, capped at 4 min) and ALWAYS recovers —
   lockouts are never permanent, unauthenticated traffic cannot cause an
   irrecoverable denial, and a successful sign-in resets the (source,
   account) state. Failures are keyed by the trusted-proxy source (the same
   `FAYANMS_TRUST_PROXY_HOPS` policy as the /api/v1 gate — keep it set to
   your real proxy depth, item above) and an HMAC-keyed hash of the
   submitted identifier, so nothing enumeration-relevant is stored, logged
   or emitted; typed audit events (`SIGNIN_THROTTLED` / `SIGNIN_LOCKOUT`,
   at most one row per key per window) land in the audit trail with a NULL
   actor (pre-auth — no fabricated actor FK). The guard store is bounded
   in-process memory (5,000-key cap, stale-first sweep) — behind a
   load-balanced deployment the budgets are per-instance until
   SCALE-001-A's shared store lands; single-instance deployments (this
   runbook) are fully covered.

## Explicitly NOT covered here (tracked elsewhere)

- Redis/KMS/object storage/distributed locks — the REST of audit Phase 21. Slice 1 (the
  PostgreSQL swap: schema provider, compose `postgres` service, startup-policy
  enforcement, CI service-container gates) LANDED 2026-09-13; slice 2 (the committed
  `prisma/migrations` history, fresh-database `migrate deploy` + migrations≡schema drift
  guard in CI, `migrate deploy` as the T7/D3 path) LANDED the same day. The remaining
  components are optional hardening, not prerequisites for this single-host deployment.
- Real vendor adapters — Phase 22 slices 1–3 + Phase 23 LANDED 2026-09-13: devices carry a
  data plane (`SIMULATOR` default / `LIVE_SSH`) chosen in the Add/Edit device form with a
  linked credential profile (fail-closed API invariants: LIVE ⇒ SSH_PASSWORD profile), the
  worker has a REAL SSH transport (exec-only, per-flavor command allowlist) with
  worker-side vault resolution (`FAYANMS_VAULT_*` entries in `.env.production`), and FIVE
  flavors are protocol-certified in CI against the in-repo SSH harnesses: cisco-ios
  (`show running-config`), fortinet-fortios (`show full-configuration`), hpe-aos-cx
  (`show running-config`), juniper-junos (`show configuration`), palo-panos
  (`show config running`). Sophos SFOS is deliberately uncertified over SSH (no
  read-only full-config dump in the SFOS CLI — a WebAPI transport is the future path).
- Controlled changes on LIVE devices — Phase 23 LANDED 2026-09-13: the change engine
  routes each device by data plane; LIVE_SSH devices execute a validated PLAN
  (`{ kind, anchor, slug }` — never command text) through the worker's controlled-change
  plane (per-flavor command templates built worker-side, bounded PTY CLI session with
  stop-on-first-rejection), the applied delta is one reversible interface-description
  token anchored in the decrypted pre-change snapshot, VALIDATE re-fetches and asserts
  the marker in the live config, ROLLBACK pushes the inverse plan, and the demo `failAt`
  controls never contact live devices. The job engine's loopback calls are exempt from
  the user-facing rate budget (verified service JWT required) so a change can never
  self-throttle mid-run. SAFE-001 (same day) added host-key pinning to EVERY live
  connection (backups, probes and all change steps) — an endpoint whose key is not
  enrolled, or whose key does not match the pin, fails closed before authentication.
  STILL OPEN: physical-hardware certification of the live plane (CERT-006
  closed the sophos transport gap below — sophos rides the WebAPI, not SSH).
- HA/multi-node (the architecture is deliberately single-node PostgreSQL today).

---

*Maintainer note: keep this document honest the same way SOCIAL-REPOSITORY §6 is kept —
tick checkboxes only with evidence (CI run IDs, `docker compose ps` output, backup file
listings).*
