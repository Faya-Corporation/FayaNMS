# FayaNMS — Network Operations Management

A full-stack network management system (NMS) demo platform: device inventory, configuration management, change execution, operations (alerts/incidents/NOC), performance analytics with ML-assisted capacity forecasting, reporting, and administration — with first-class English/Arabic (RTL) localization and an audit trail behind every write.

> **Demo-simulation semantics.** This is a self-contained demo environment: devices, metrics, flow data, HA topology, collector fleets and failover tests are deterministic simulations over a seeded dataset. Simulated surfaces are documented as such in-code and in-UI. The architecture (job queue, state machines, guarded writes, audit chain) is real.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript 5, Bun runtime |
| UI | Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons, next-themes (light/dark) |
| Data | Prisma 6 + SQLite (single file, WAL), TanStack Query/Table, Zustand |
| i18n | next-intl — English + Arabic with direction-aware RTL layout |
| Auth | NextAuth v4 (credentials) + RBAC (admin / operator / engineer / manager / auditor read-only / viewer) + permission-engine checks on sensitive paths |
| AI | z-ai-web-dev-sdk (backend-only) — NL change drafting, "Ask the network" queries, RCA drafting; clean `AI_UNAVAILABLE` envelopes when unavailable |
| Worker | Dedicated Bun mini-service (`mini-services/worker`, port 3030) with claim-loop, exponential backoff and health endpoint |

## Architecture in brief

- **Single-route SPA shell** (`/`) with a client-side view router — 30+ registered views across seven domain groups.
- **Evaluate-in-Next pattern**: the worker never opens SQLite. It claims `JobExecution` rows over HTTP, drives staged progress, and calls `/api/v1/worker/*` completion endpoints where all database logic lives.
- **Audit-as-event-store**: every guarded write lands in a hash-chained `AuditEvent` chain (SHA-256, GENESIS root) with **DB-level fork protection** — a unique `prevHash` index + retry-with-restamp makes concurrent forks physically impossible; derived state (e.g. HA failover results) is reconstructed from audit rows by correlation ID.
- **Deterministic simulations**: seeded PRNG + fixed-point arithmetic so dashboards, forecasts and simulations don't flicker under polling.
- **Secrets hygiene (P19)**: config snapshots encrypted at rest — per-snapshot random DEK, AES-256-GCM text + DEK wrap under an env-configured master key (keystore path is a Phase 21 upgrade), sha256-of-plaintext integrity column, zero plaintext rows (migration enforced); masked viewer; raw downloads are permission-gated (`config.download`), audited with the real session actor, `no-store`.
- **Server-authoritative identity (P19)**: the client never chooses the actor. `actAsUserId` was removed from every request DTO; approvals, executions and all mutations are attributed to the authenticated session principal (separation of duties enforced server-side); restore flows can no longer auto-approve via seeded identities.
- **Machine-principal service boundary (P19)**: the worker authenticates to the job-engine routes with short-lived HS256 service JWTs (audience-pinned, rotation-window supported); anonymous internal mutation is rejected with precise 401 codes.
- **Fail-closed startup policy (P19)**: production boot refuses missing/weak/known-bad secrets and demo-mode; the seed refuses to install shared-credential demo users into production.

## Feature map

| Group | Surfaces |
|---|---|
| **Network** | Device inventory (detail tabs: config, interfaces, health, records, AI assistant), sites, interfaces, topology, discovery + CSV import, firmware lifecycle (EOS/EOL, guarded upgrades), zero-touch provisioning (ZTP claims → worker → device registration) |
| **Configurations** | Backup policies + snapshots, baselines, drift detection & triage, backup compliance analytics, CMDB (CI register, relations, BFS impact analysis) |
| **Changes** | Change wizard with transparent risk engine, approvals queue with segregation-of-duties, execution engine (pre-check BLOCK, auto-rollback with byte-identical restore proof), conflict-aware calendar, templates |
| **Operations** | NOC fullscreen wallboard, alert rules/threshold evaluation/dedup/suppression, incident lifecycle (SEV1–4, SLA timers, PIR export), maintenance windows, audit event stream, job center, HA/DR topology with staged failover tests |
| **Performance** | Overview/devices/interfaces/availability dashboards, capacity forecast (ridge regression v3 with honest backtest metrics + v2 confidence bands), flow analytics (top talkers/protocols), predictive health |
| **Reports** | Report builder, generated runs with download, scheduled runs (cron-driven via worker) |
| **Administration** | Users & roles, credential profiles (masked), API clients (key rotation), collectors registry + deterministic agent distribution with guarded rebalance, drivers catalog, webhook/notification integrations, system settings, audit-chain verification |

Global surfaces: dashboard KPIs, command palette, guided tour, job center sheet, notifications center, **"Ask the network"** natural-language query dialog (two-stage LLM → grounded, read-only, audited answers).

## Getting started

Prerequisites: [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install

# Environment — generate every secret yourself; the repo ships NO usable values
# (production startup FAILS on missing/weak/known-bad secrets — see
# src/lib/startup/security-policy.ts).
cp .env.example .env
# then set in .env:
#   NEXTAUTH_SECRET=$(openssl rand -hex 32)
#   FAYANMS_SERVICE_SECRET=$(openssl rand -hex 32)   # worker <-> app service JWTs
#   FAYANMS_CONFIG_ENC_KEY=$(openssl rand -hex 32)   # snapshot encryption KEK

# Database (SQLite at db/custom.db — NOT tracked in git)
bun run db:push                    # create schema
bun prisma/seed.ts                 # pristine demo dataset (30 devices / 7 vendors, jobs, incidents, CIs, …)
bun scripts/migrate-encrypt-snapshots.ts   # encrypt the seeded snapshots at rest (idempotent)

# App (port 3000)
bun run dev

# Worker (port 3030) — in a second terminal; reads FAYANMS_SERVICE_SECRET
# from the repo-root .env to authenticate its job-engine calls
cd mini-services/worker && bun run dev
```

Demo sign-in: `admin@faya.local` / `faya123` (every seeded user shares this password — demo
users are installed by the seed ONLY; the startup policy forbids running them in production,
and the seed refuses to wipe a production database).

### Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Next dev server on port 3000 (logs to `dev.log`) |
| `bun run lint` | ESLint |
| `bunx tsc --noEmit` | Type check |
| `bun run db:push` | Push `prisma/schema.prisma` to SQLite |
| `bun prisma/seed.ts` | Rebuild the pristine demo dataset |
| `bun scripts/migrate-encrypt-snapshots.ts` | Encrypt legacy plaintext snapshots (idempotent; also the KEK-rotation path) |

### Worker

The worker claims jobs (`CONFIG_BACKUP`, `DISCOVERY`, `DRIFT_CHECK`, `CHANGE_EXECUTE`, `ALERT_EVALUATION`, `METRIC_RETENTION`, `REPORT_RUN`, `FIRMWARE_UPGRADE`, `ZTP_PROVISION`) with concurrency 3, per-job timeouts, exponential backoff on backend outages, and `GET :3030/health` observability. A scheduler tick (`POST /api/v1/worker/tick`, every ~30 s) enqueues scheduled work, prunes metric/snapshot retention, and **reaps orphaned RUNNING jobs** (10 min threshold; 15 min for change execution) — flipped to FAILED with a `JOB_ORPHAN_REAPED` audit row and an "Orphaned" marker in the Job Center, recoverable via the built-in retry.

## Conventions

- Every list/detail surface uses the envelope `{ success, data, meta, requestContext }` with Zod-validated inputs and machine-readable error codes.
- All UI strings live in `messages/en.json` + `messages/ar.json` — kept at exact key parity (1285 = 1285 at time of writing); Arabic is genuine network-ops terminology, not machine translation.
- Accessibility: WCAG 2.2 AA is the TARGET (skip link, reduced motion, focus-visible rings, named tables/charts, ≥24px targets implemented — see docs/design-governance.md §5–§6 for the per-criterion status and the honestly-graded browser QA matrix); responsive 375 → 1920 with a no-horizontal-overflow rule.
- High-risk operations (restore, failover test, rebalance apply, deletions) run through typed-confirm `HighRiskActionDialog` flows.

## Security posture (P19) & honest status

Implemented and verified in Phase 19 (2026-09-09 repository audit remediation — see
`docs/audits/`): session-authoritative actor model (24 route sites swept, SoD enforced on the
session principal), permission-gated raw-config downloads, de-auto-approved restores,
service-JWT job-engine boundary, AES-256-GCM snapshot encryption with zero plaintext rows,
audit-chain fork protection (verified across a 20-way concurrent-writer race: valid chain,
562 rows), fail-closed secrets policy, gateway port allowlist.

Known limitations (not production claims): the device data plane remains a deterministic
SIMULATOR; SQLite is single-writer and the demo db is no longer committed (rebuild via the
seed above); the CI workflow currently gates lint + typecheck (the full automated test suite
of audit Phase 20 is future work); the design-governance QA matrix is only partially
executed by design — see §6 there.

## Repository layout

```
src/app/            Next.js app (single visible route + /api/v1/* handlers)
src/components/     shell/, domain/, views/, per-module components
src/lib/            auth, service-auth, audit chain, config crypto/diff/normalize, capacity/flows/HA engines, i18n, AI client
src/hooks/api/      TanStack Query hooks per domain
mini-services/worker/  Bun job runner (claim loop, drivers, scheduler, service-token signer)
prisma/             schema.prisma + seed.ts
scripts/            tracked ops scripts (snapshot encryption migration)
messages/           en.json / ar.json dictionaries
docs/               design-governance.md + audits/ (external review reports)
```
