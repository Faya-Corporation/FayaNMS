# Product Map — FayaNMS 0.2.1

## What it is
Enterprise Network Operations Management (NMS) demo platform: device inventory, configuration management, change execution, operations (alerts/incidents/NOC), performance analytics with ML-assisted capacity forecasting, reporting, and administration. First-class EN/AR (RTL) localization; audit trail behind every write. Simulation semantics documented in README (deterministic seeded demo data; job queue / state machines / audit chain are real).

## Stack
Next.js 16 App Router + TS 5.9.3, Bun 1.3.14, Tailwind 4 + shadcn/ui (New York), TanStack Query/Table, Zustand, next-intl (en/ar), NextAuth v4 credentials + RBAC, Prisma 6 + PostgreSQL, Bun worker (mini-services/worker, port 3030), AI via z-ai-web-dev-sdk (backend-only), Prometheus/Grafana monitoring profiles, GHCR container publication (currently disabled at repo level by owner).

## User roles (RBAC)
admin / operator / engineer / manager / auditor (read-only) / viewer — enforced by NextAuth session + `src/lib/auth/permissions.ts` role matrix + permission-engine checks on sensitive paths; client-side `permissions-client.ts` is courtesy-only (server is authoritative).

## Surfaces
- **SPA shell**: single route `/` with client-side view router (30+ views, 7 domain groups: Network, Configurations, Changes, Operations, Performance, Reports, Administration) + global surfaces (dashboard KPIs, command palette, guided tour, job center, notifications, "Ask the network" AI dialog, NOC wallboard).
- **API**: `/api/auth/*` (NextAuth), `/api/v1/**` (~148 route.ts files; session plane + machine plane `/api/v1/worker/*` with Ed25519 service JWTs), `/api/metrics` (token-optional process metrics), `/api` (stub).
- **Jobs/collectors**: worker claim-loop (`JobExecution`), SNMP pollers, syslog/NetFlow/protocol ingest, discovery, backups, scheduled reports; evaluate-in-Next pattern (worker never touches DB).
- **Ingest paths**: `/api/v1/ingest/*` (protocol, drain), webhook integrations (HMAC-signed), ZTP claims.
- **Data model (prisma, 48 models)**: User, Site, Device, CredentialProfile, ConfigSnapshot (DEK-encrypted), Baseline/Drift, Change/ChangeStep/Approval, Alert/Incident/MaintenanceWindow, MetricSample/MetricRollup, FlowRecord, ProtocolEventQueue, AuditEvent (hash-chained, fork-protected), JobExecution, ApiClient, WebhookIntegration, HA topology models, CMDB CI/relations.
- **Trust boundaries**: browser ↔ Next (session cookie, SameSite=Lax); worker ↔ Next HTTP (service JWT, audience/issuer-pinned); devices ↔ worker (SSH host-key pinning, SNMPv3 auth/priv, credential-free first-contact); ingest ↔ internet (rate gates, HMAC); app ↔ DB (Prisma).

## Main journeys
1. Sign in (demo accounts) → dashboard KPIs.
2. Add/import device → discovery → credential profile attach → poll → alerts.
3. Backup policy → snapshot → baseline → drift triage.
4. Change draft → risk engine → approval (SoD) → execute (pre-checks, auto-rollback) → audit chain.
5. Alert fires → dedup/suppress → incident (SEV/SLA) → PIR.
6. Capacity forecast / reports / scheduled runs.
7. Admin: users, API clients, collectors, webhooks, audit-chain verification.

## Deployment
- `deploy/oci/compose.yml` (+ TLS profile): app + worker + postgres + caddy + prometheus/grafana profiles; backup.sh/restore-drill.sh; env via `.env` (env.example documents keys incl. FAYANMS_CONFIG_ENC_KEY master key).
- CI: ci.yml (gate/e2e/browser/scan, required by branch protection); container.yml (ARM64 cert → GHCR; disabled at repo level); deploy-staging.yml (needs 4 OCI secrets).

## Coverage table (Phase 1 audit)
| Module | Reviewed | Notes |
|---|---|---|
| src/lib/auth/** + src/lib/security/** | YES (A1) | notes/A1-auth-api.md |
| src/app/api/** (148 routes) + src/proxy.ts | YES (A1) | all routes enumerated in A1 notes |
| mini-services/worker/** | YES (A2) | transports, vault, runner, adapters |
| src/lib/protocol, collectors, flows, net, dns, ssh, vendors | YES (A2) | |
| prisma schema/migrations/seed + src/lib data/domain services | YES (A3) | notes/A3-data-core.md |
| src/app UI, src/components, hooks, stores, i18n | YES (A4) | heaviest views + all 46 hooks; ~25 secondary views only grep-level (documented) |
| Dockerfiles, compose*, workflows, deploy/, scripts/ci|release|verification, monitoring/, runbooks | YES (A5) | notes/A5-ops-ci.md |
| Browser UX walk | PARTIAL | Unauthenticated surfaces only (375/768/1440 + failed sign-in) — sandbox has no PostgreSQL (no sudo); post-auth screens covered by code audit (A4) + existing browser e2e suite |
| Live device interaction | NO | No physical devices in sandbox; simulator/harness code reviewed statically (A2) |
