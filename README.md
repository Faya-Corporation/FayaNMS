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
| Auth | NextAuth v4 (credentials) + RBAC (admin / operator / engineer / manager / auditor read-only / viewer) |
| AI | z-ai-web-dev-sdk (backend-only) — NL change drafting, "Ask the network" queries, RCA drafting; clean `AI_UNAVAILABLE` envelopes when unavailable |
| Worker | Dedicated Bun mini-service (`mini-services/worker`, port 3030) with claim-loop, exponential backoff and health endpoint |

## Architecture in brief

- **Single-route SPA shell** (`/`) with a client-side view router — 30+ registered views across seven domain groups.
- **Evaluate-in-Next pattern**: the worker never opens SQLite. It claims `JobExecution` rows over HTTP, drives staged progress, and calls `/api/v1/worker/*` completion endpoints where all database logic lives.
- **Audit-as-event-store**: every guarded write lands in a hash-chained `AuditEvent` chain; derived state (e.g. HA failover results) is reconstructed from audit rows by correlation ID.
- **Deterministic simulations**: seeded PRNG + fixed-point arithmetic so dashboards, forecasts and simulations don't flicker under polling.
- **Secrets hygiene**: config snapshots encrypted at rest (AES-256-GCM, sha256 integrity), masked viewer, audited downloads.

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

# Environment
cp .env.example .env         # DATABASE_URL + NEXTAUTH_SECRET

# Database (SQLite at db/custom.db)
bun run db:push              # create schema
bun prisma/seed.ts           # pristine demo dataset (30 devices / 7 vendors, jobs, incidents, CIs, …)

# App (port 3000)
bun run dev

# Worker (port 3030) — in a second terminal
cd mini-services/worker && bun run dev
```

Demo sign-in: `admin@faya.local` / `faya123` (every seeded user shares this password).

### Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Next dev server on port 3000 (logs to `dev.log`) |
| `bun run lint` | ESLint |
| `bunx tsc --noEmit` | Type check |
| `bun run db:push` | Push `prisma/schema.prisma` to SQLite |
| `bun prisma/seed.ts` | Rebuild the pristine demo dataset |

### Worker

The worker claims jobs (`CONFIG_BACKUP`, `DISCOVERY`, `DRIFT_CHECK`, `CHANGE_EXECUTE`, `ALERT_EVALUATION`, `METRIC_RETENTION`, `REPORT_RUN`, `FIRMWARE_UPGRADE`, `ZTP_PROVISION`) with concurrency 3, per-job timeouts, exponential backoff on backend outages, and `GET :3030/health` observability. A scheduler tick (`POST /api/v1/worker/tick`, every ~30 s) enqueues scheduled work, prunes metric/snapshot retention, and **reaps orphaned RUNNING jobs** (10 min threshold; 15 min for change execution) — flipped to FAILED with a `JOB_ORPHAN_REAPED` audit row and an "Orphaned" marker in the Job Center, recoverable via the built-in retry.

## Conventions

- Every list/detail surface uses the envelope `{ success, data, meta, requestContext }` with Zod-validated inputs and machine-readable error codes.
- All UI strings live in `messages/en.json` + `messages/ar.json` — kept at exact key parity (1285 = 1285 at time of writing); Arabic is genuine network-ops terminology, not machine translation.
- Accessibility: WCAG 2.2 AA pass (skip link, reduced motion, focus-visible rings, named tables/charts, ≥24px targets); responsive 375 → 1920 with a no-horizontal-overflow rule.
- High-risk operations (restore, failover test, rebalance apply, deletions) run through typed-confirm `HighRiskActionDialog` flows.

## Repository layout

```
src/app/            Next.js app (single visible route + /api/v1/* handlers)
src/components/     shell/, domain/, views/, per-module components
src/lib/            auth, audit chain, config diff/normalize, capacity/flows/HA engines, i18n, AI client
src/hooks/api/      TanStack Query hooks per domain
mini-services/worker/  Bun job runner (claim loop, drivers, scheduler)
prisma/             schema.prisma + seed.ts
messages/           en.json / ar.json dictionaries
docs/               design-governance.md
```
