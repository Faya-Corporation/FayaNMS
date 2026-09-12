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
| Prisma datasource is **SQLite**, schema has **no enums / no Json** (SQLite-safety rules, 900-line schema) | prisma/schema.prisma | SQLite runs fine in a container **on a named volume**; PostgreSQL migration stays a separate Phase-21 task |
| Build/start scripts use POSIX `cp`/`tee` (`next build && cp -r …`, `bun … \| tee server.log`) | package.json | **Never run these natively in Windows PowerShell/cmd** — containers (Linux) are mandatory, not stylistic |
| App → worker calls go through `WORKER_BASE_URL` (env-configurable, runbook T5 as landed 2026-09-13; default preserves the historical `http://localhost:3030` loopback) in 4 route files (`devices/test-connection`, `worker/change-step`, `worker/status`, `admin/collectors`) | src/lib/worker/worker-url.ts + src/app/api/v1/** | Bare-metal dev needs NO env var; compose sets `WORKER_BASE_URL=http://worker:3030` on a normal bridge network (T3/T5) |
| Worker → app calls go through `NEXT_BASE_URL` (env-configurable, T5; default preserves `http://localhost:3000`) | mini-services/worker/next-client.ts | Same — compose sets `NEXT_BASE_URL=http://app:3000`; the worker's loopback self-calls stay container-local (`SELF_BASE_URL`) |
| Worker port **hardcoded 3030**, "do not read PORT env" (Task 2-b contract) | mini-services/worker/index.ts | The stack exposes exactly **one** port (3000); 3030 stays internal — same model as the sandbox gateway |
| `siteUrl()` **throws** in production without `NEXT_PUBLIC_SITE_URL`, and **rejects `localhost` / `127.0.0.1` / `0.0.0.0` / `*.local` hostnames** in production | src/lib/brand/identity.ts (B3-029) | You need a real DNS name (or a raw LAN IP — IPs pass the guard) baked at **build time** |
| Startup security policy (production) **aborts** unless: `NEXTAUTH_SECRET` ≥ 32 chars, `FAYANMS_SERVICE_SECRET` 64-hex, `FAYANMS_CONFIG_ENC_KEY` 64-hex, and `FAYANMS_DEMO_MODE ≠ true` | src/lib/startup/security-policy.ts, .env.example | Secrets must be generated per environment; demo seeding is a separate, non-production step |
| Demo seed gate: requires `FAYANMS_DEMO_MODE=true` **and** refuses under production NODE_ENV | prisma/seed.ts:2443 | Seed in a one-off container without `NODE_ENV=production`, then run the app clean |
| CI `scan` job's trivy step **is ACTIVE since 2026-09-12** (fs scan, HIGH/CRITICAL, exit-code 1; first verified scans: 0 vulns / 0 misconfigs / 0 secrets — the planned `.trivyignore` mirror never had to land, see T4) | .github/workflows/ci.yml step 12 | Any new HIGH/CRITICAL advisory or Dockerfile misconfig turns CI red — fix forward; the `osv-scanner.toml` accepted-risk ledger is EMPTY today, keep it that way unless a finding genuinely requires a major migration |
| CI is active with required checks `gate` + `scan` on protected `main` (owner direct-push bypass documented) | SOCIAL-REPOSITORY.md §6 | All repo-side tasks land via normal pushes; every push must stay green |

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
  **SQLite on 9p risks lock corruption** — this is the #1 Windows-specific footgun.
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
ENV DATABASE_URL=file:/data/fayanms/custom.db
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "server.js"]
```

Acceptance criteria:
- [ ] Image builds from a clean clone; `docker run` serves the sign-in gate on :3000.
- [ ] `NEXT_PUBLIC_SITE_URL` is a **build ARG carrying the real origin** — NOT the CI
      `.invalid` placeholder (OG/metadata are baked into the bundle at build time).
- [ ] `DATABASE_URL` is an **absolute** `file:/data/...` path (kills all relative-path
      ambiguity between Prisma CLI conventions and the standalone runtime).
- [ ] Runs as non-root; `.prisma`/`@prisma` engine dirs verified present (boot fails fast
      without them — test on a clean machine, not just the build host).
- [ ] Container `HEALTHCHECK` green; `docker inspect --format='{{.State.Health.Status}}'` → `healthy`.

As-landed deviations from the reference above (deliberate, recorded for honesty):
- Runtime base is `oven/bun:1.3.14-slim` (debian), **not** `-alpine` — the Prisma query
  engine and sharp prebuilds are produced in the glibc build stage; musl would mismatch.
- The non-root uid is PINNED (`10001`) and `/data/fayanms` is pre-created + chowned in
  the image, so the named volume seeds with correct ownership no matter which container
  mounts it first (provision runs as root and hands ownership back with an explicit
  `chown -R 10001:10001`).
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
  app:
    build:
      context: .
      args: { NEXT_PUBLIC_SITE_URL: "${NEXT_PUBLIC_SITE_URL}" }
    image: fayanms-app:latest
    restart: unless-stopped
    env_file: .env.production
    environment:
      NODE_ENV: production
      DATABASE_URL: file:/data/fayanms/custom.db
      WORKER_BASE_URL: "${WORKER_BASE_URL:-http://worker:3030}"   # T5: app → worker hop
    volumes:
      - fayanms-db:/data
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
  fayanms-db:
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
- [ ] `docker compose down && up` against the same volume **preserves data** (SQLite
      survives redeploys; this is the regression that matters most).

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
values (`DATABASE_URL=file:/data/fayanms/custom.db`, canonical URLs). Never commit real
values (`.env*` is gitignored — gitleaks in CI also watches this).

Generation (inside WSL2):

```bash
openssl rand -hex 32   # NEXTAUTH_SECRET          (≥32 chars)
openssl rand -hex 32   # FAYANMS_SERVICE_SECRET   (64 hex)
openssl rand -hex 32   # FAYANMS_CONFIG_ENC_KEY   (64 hex) — this is the KEK that
                       # encrypts all config snapshots; LOSING IT = losing backups
```

`FAYANMS_CONFIG_ENC_KEY_ID=k1`. If you ever rotate the KEK, the old key must remain
available to decrypt historical snapshots — document the rotation before doing one.

### T7 — Database provisioning strategy — **repo-side LANDED 2026-09-12 (R12)** via the `provision` compose service; the demo-vs-pristine CHOICE happens at first deploy

Two mutually exclusive paths, chosen at first deploy. Both use the `provision` service
(the Dockerfile **build** stage — the slim runtime deliberately does not carry the prisma
CLI) and both finish with the ownership handback to the runtime uid:

- **Demo dataset (matches everything the demo surfaces expect):** one-off **`provision`
  container** **without** `NODE_ENV=production` **with** `FAYANMS_DEMO_MODE=true`:

  ```bash
  docker compose --env-file .env.production run --rm --no-deps -e NODE_ENV= \
    -e FAYANMS_DEMO_MODE=true provision \
    sh -c 'bunx prisma db push && bun prisma/seed.ts && chown -R 10001:10001 /data/fayanms'
  ```

- **Pristine:** same db push, no seed — then create your real admin through the app's own
  user management. Verify the first-run experience before choosing this on a box anyone
  else can reach.

  ```bash
  docker compose --env-file .env.production run --rm --no-deps provision \
    sh -c 'bunx prisma db push && chown -R 10001:10001 /data/fayanms'
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
  sh -c 'bunx prisma db push && bun prisma/seed.ts && chown -R 10001:10001 /data/fayanms'
                                                         # T7 demo path (pristine: db push + chown only)
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

- [ ] **D1. Backups (Task-Scheduler-driven, weekly minimum):** SQLite is single-writer —
  stop, copy, start:

  ```bash
  docker compose stop app worker
  docker run --rm -v fayanms_fayanms-db:/data -v ~/backups:/backup alpine \
    tar czf /backup/fayanms-$(date +%F).tar.gz -C /data .
  docker compose start
  ```

  Trigger from Windows: `wsl.exe -d Ubuntu-22.04 -u root bash -lc 'cd ~/fayanms && ./backup.sh'`.
  Keep N weekly + 4 daily off-box copies. (Litestream sidecar = continuous S3-style
  replication — optional upgrade, do NOT run it against the same volume without reading
  its SQLite-consistency notes.)
- [ ] **D2. TLS/reverse proxy (recommended before any non-LAN exposure):** Caddy sidecar
  with a mounted volume for its CA/certs, proxying to `app:3000`; flip compose to publish
  80/443 only. If a corporate cert exists, mount it instead. `NEXTAUTH_URL` /
  `NEXT_PUBLIC_SITE_URL` become `https://…` and the images must be **rebuilt** (the URL is
  a build-time ARG — T1).
- [ ] **D3. Upgrade procedure** (the repo ships `db:push`, not migrations):

  ```bash
  cd ~/fayanms && git pull
  docker compose --env-file .env.production build
  docker compose --env-file .env.production run --rm --no-deps provision \
    sh -c 'bunx prisma db push && chown -R 10001:10001 /data/fayanms'   # schema sync; read the diff output!
  docker compose --env-file .env.production up -d
  ```

  Snapshot the volume (D1) immediately before every upgrade. CI `gate` already proved the
  commit builds green — trust but verify the seed/schema diff.
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
| Startup abort: security policy (secret too short / demo mode) | policy contract | Regenerate secrets per T6; run app without `FAYANMS_DEMO_MODE` |
| SQLite `database is locked` / silent corruption | DB on `/mnt/c` (9p) or two app replicas | Named volume only (T3); keep exactly one app instance (single-writer by design) |
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

## Explicitly NOT covered here (tracked elsewhere)

- PostgreSQL/Redis/KMS/object storage, migrations, distributed locks — audit Phase 21
  (this runbook's T3 + T5 + D2 are its containerization slice — now fully landed,
  two-container bridge topology; the persistence swap is its own migration project
  given the SQLite-typed schema: 900 lines, no enums/Json by design).
- Real vendor adapters (Phase 22) and controlled change execution (Phase 23).
- HA/multi-node (the architecture is deliberately single-node SQLite today).

---

*Maintainer note: keep this document honest the same way SOCIAL-REPOSITORY §6 is kept —
tick checkboxes only with evidence (CI run IDs, `docker compose ps` output, backup file
listings).*
