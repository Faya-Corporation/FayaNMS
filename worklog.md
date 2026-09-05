# FayaNMS — Project Worklog

Shared, append-only worklog. Every agent MUST read this file before starting and MUST append a section (starting with a line containing exactly `---`) when its Task ID is complete.

Template:

```markdown
---
Task ID: <id>
Agent: <agent name>
Task: <the task you were asked to do>

Work Log:
- <step>
- <step>

Stage Summary:
- <key results / decisions / artifacts>
```

---
Task ID: 0
Agent: Orchestrator (Z.ai Code)
Task: Full review & audit of the two FayaNMS source documents; reconcile them with the sandbox environment; produce the complete implementation roadmap and initial task breakdown; begin implementation.

Work Log:
- Read both uploaded documents end-to-end (3,475 + 3,089 lines).
- Audited workspace: Next.js 16 (App Router) + TypeScript + Tailwind 4 + full shadcn/ui set + Prisma 6/SQLite (db/custom.db via DATABASE_URL) + TanStack Query/Table + Zod + RHF + Recharts + Zustand + next-themes + next-intl. Bun runtime, port 3000, gateway `XTransformPort` for mini-services. No NestJS, no Python, no PostgreSQL/Redis/MinIO available. Only `/` is user-visible → single-route, client-side view navigation.
- Produced audit findings, adaptation decisions, roadmap and task breakdown below.

Stage Summary:
- See "PART A — AUDIT" and "PART B — ROADMAP" below. Implementation started with Task 1-a/1-b/1-c (Phase 0/1 Foundation).

# PART A — AUDIT (Documents + Environment)

## A1. Document inventory

| Document | Lines | Content |
|---|---|---|
| FayaNMS — Full Project Worktree & Design System Architecture | 3,475 | Design direction (Apex/Signal references), 8 UX principles, monorepo/worktree layout, full route map, design tokens (colors/typography/spacing/density/radius/shadows/icons), component system, dashboard/NOC layouts, table system, states, RTL/i18n, a11y, phases 0–9 with task codes, QA gates |
| Network Management… Project Plan | 3,089 | Business objectives, vendor tiers, adapter contract, collector architecture, inventory/credentials/backup/snapshot/diff/baseline/drift modules, change lifecycle+risk, incidents/SLA, monitoring/alerting, RBAC/audit, reporting, tech stack, DB entities, security, testing, phases 0–10, schedule, MVP definition, acceptance gates |

## A2. Consistency between the two documents (verified)

- ✅ Device status set matches: `ONLINE / OFFLINE / DEGRADED / MAINTENANCE / UNKNOWN / UNMANAGED`.
- ✅ Severity mapping matches (Critical/High/Medium/Low/Info; incidents SEV-1..4).
- ✅ Change lifecycle state machine matches (DRAFT→…→CLOSED + FAILED/ROLLBACK/REJECTED/CANCELLED/EXPIRED/ROLLBACK_FAILED/PARTIAL_SUCCESS).
- ✅ Risk scoring (0–100, LOW<21 / MEDIUM<41 / HIGH<71 / CRITICAL≥71) consistent.
- ✅ Restore-as-controlled-workflow (never one-click) consistent with HighRiskActionDialog pattern.
- ✅ Navigation taxonomy matches (Network / Configurations / Changes / Operations / Performance / Reports / Administration).
- ✅ MVP scope (Plan §90) fits the Design doc phases 1–8 — no contradiction.

## A3. Findings — conflicts & gaps (audit results)

| # | Finding | Severity | Resolution decision |
|---|---|---|---|
| F-01 | Docs prescribe monorepo (pnpm+turbo) with NestJS API, Python workers, PostgreSQL+TimescaleDB, Redis, MinIO. Sandbox mandates single Next.js 16 app, Prisma+SQLite, bun, one exposed port, API routes (no server actions). | Blocking (environment) | **ADR-01:** Keep the *architecture contracts* (adapter interface, job queue semantics, two-tier config storage, capability manifests) but implement in-process: API = `/api/v1` route handlers; queue = `JobExecution` table + in-process/mini-service worker; metrics = SQLite with rollup tables emulating Timescale aggregation/retention; object storage = AES-256-GCM-encrypted files under `storage/` with metadata in DB; Redis semantics via in-memory locks + DB. Swapping to NestJS/PG later only affects the persistence layer, not contracts. |
| F-02 | Docs define deep multi-level routes (`/network/devices/[id]/interfaces`…). Sandbox exposes only `/`. | Blocking (environment) | **ADR-02:** Single route `/` hosts an app shell with a client-side view router (Zustand store, persisted). Internal view keys mirror the doc route map 1:1 (`network.devices.detail`, tabs as sub-views). Real file routes remain possible post-export. |
| F-03 | Docs reference "Apex Dashboard" and "Signal Dashboard" templates as UI references. Neither exists in the workspace. | Minor | **ADR-03:** Treat them as descriptive references only. The design tokens/geometry specified in the doc (§15–§43, §75–§83) are complete enough to build the UI directly. |
| F-04 | Primary accent #2563EB / cyan #0891B2 is blue-family (normally restricted) — but explicitly specified by the user's design doc. | None | Use as specified: enterprise blue primary, cyan accent used sparingly (links, chart emphasis, focus). |
| F-05 | Auth: plan lists OAuth/OIDC/SSO/MFA as mandatory eventually; sandbox has NextAuth v4 available. | Medium | **ADR-04:** Phase 0/1 ships schema + permission model + `audit` hooks with a demo admin session (no login wall in preview). Full NextAuth credentials + RBAC enforcement UI scheduled in Phase 7 (Administration) with SSO-ready abstraction. Audit records this as a deliberate staging decision. |
| F-06 | Real device access (SSH/SNMP/RESTCONF to Cisco/FortiGate/Sophos/HPE) is impossible from the sandbox. | Blocking (reality) | **ADR-05:** Build a **Device Simulator + Job Worker mini-service** (bun, port 3030) implementing the adapter contract (connect/facts/config/backup/restore/apply/validate/rollback/metrics) over a simulated device fleet. All workflows (scheduled backup, drift, change execution, alerts, metrics) run end-to-end against simulated devices, so the platform is fully demonstrable; real adapters slot into the same contract later. |
| F-07 | Scheduler: docs need cron-style scheduled backups/reports. Sandbox has no system cron for app use. | Medium | **ADR-06:** Worker mini-service runs an internal scheduler loop (cron expressions parsed in-process) writing due jobs to the `JobExecution` queue. |
| F-08 | Time-series volume (docs: millions/day, Timescale/ClickHouse). SQLite demo cannot sustain that. | Medium | **ADR-07:** Write `MetricSample` (raw) + scheduled `MetricRollup` (5m/1h/1d avg/max/min/p95) with retention pruning. Dashboard reads rollups. Schema/queries designed so a Timescale swap is mechanical. |
| F-09 | No worktrees/git-flow possible (single sandbox project). | Minor | Map worktree ownership (§96) to folder ownership: `src/features/*`, `src/components/domain/*`, `src/app/api/v1/*`, `mini-services/worker`. |
| F-10 | Plan §88 estimates 5–7 engineers, 5–7 months. Sandbox is a single-agent codebase. | Context | Roadmap re-sequenced into vertical slices that each end in a demonstrable, browser-verifiable increment. |
| F-11 | Design doc requires RTL (EN/AR first-class) — next-intl is installed. | None | Phase 1 ships direction-aware tokens (logical CSS properties); i18n dictionaries (`messages/en.json`, `messages/ar.json`) land in Phase 8 with RTL regression pass. |
| F-12 | Config snapshots contain secrets; docs require encryption at rest + redacted viewer + download audit. | High (must not skip) | Implemented from Phase 2: AES-256-GCM file encryption, `sha256` integrity, `config.secrets.read` gate + `********` masking layer, `CONFIG_DOWNLOAD` audit events. |
| F-13 | Docs require TanStack Table with server-side pagination, saved views, bulk actions — heavy component. | Medium | Built once in Phase 1 as the single `<DataTable/>` (spec §43–§45); every module reuses it. |
| F-14 | "No test code" constraint in this environment vs docs' testing strategy (unit/contract/integration). | Context | Strategy kept as manual QA gates + browser verification per phase; adapter contract suite becomes a simulated checklist module (documented, not code) until the codebase leaves the sandbox. |

## A4. Risk register (top items)

1. **Single-route SPA growth** — view registry must stay typed and lazy-loaded to avoid one mega-bundle. Mitigation: dynamic imports per view.
2. **SQLite write contention** — worker + API concurrent writes. Mitigation: WAL mode, short transactions, queue table as single writer funnel.
3. **Simulated data realism drift** — configs must look vendor-authentic (Cisco/FortiGate/Sophos/HPE syntax) to make diff/drift demos meaningful. Mitigation: curated seed fixtures.
4. **Scope explosion** — docs describe an enterprise suite. Mitigation: strict MVP cut (Plan §90) with non-MVP backlog parked (Plan §91).
5. **Secrets masking gaps** — vendor-specific secret lines. Mitigation: centralized masking rule list per vendor, applied at render and export time.

# PART B — ROADMAP (sandbox-adapted, execution-ready)

Ordering principle: each phase ends with a browser-verifiable vertical slice + worklog entry. Parallelism noted per task ID.

## Phase 0/1 — Foundation (Tasks 1-a, 1-b, 1-c) — IN PROGRESS
- **1-a** Prisma core schema (all Part-C entities, SQLite-safe: no enums → string + TS constant maps), db push, realistic seed (org/sites, 24+ devices across cisco/fortinet/sophos/hpe with mixed health, interfaces, vendor-authentic config snapshots, 24h metrics + rollups, changes/steps/approvals, incidents/timelines, alerts, jobs, audit, maintenance window, baselines, drift).
- **1-b** Design foundation: token architecture in globals.css (neutral light/dark, primary #2563EB, accent #0891B2, success/warning/danger/info + subtle variants, radius 6/8/10/12, density data-attribute), status.ts single-source-of-truth maps, domain components (StatusDot, DeviceStatusBadge, SeverityBadge, ChangeStatusBadge, ChangeRiskBadge, BackupStatusBadge, DriftStatusBadge, KpiCard, PageHeader, EmptyState, ErrorState, SectionCard, TimeRangeSelect, FilterChip), Inter + JetBrains Mono fonts, ThemeProvider.
- **1-c** App shell at `/`: sidebar (groups per §16, 264px/72px collapse, badges, tooltips, mobile drawer), header (search, ⌘K command palette, alerts/notifications, theme+density toggles, user menu), sticky status footer, typed view router; Dashboard view (KPI row, availability chart, health distribution, active incidents, upcoming changes, backup compliance, recent activity); stub views with proper empty states; `/api/v1/{dashboard,devices,incidents,changes,alerts,jobs}` with Zod + envelope + TanStack Query + centralized query keys.
- **Gate G1:** `/` renders shell+dashboard with live API data in browser, dark/light + density toggles work, lint clean, no hydration errors.

## Phase 2 — Device Inventory & Simulation Core (2-a, 2-b, 2-c)
- **2-a** Devices DataTable (server pagination/sort/filter/columns/export, saved views, bulk actions) + device detail (tabs: overview/health/interfaces/config/backups/changes/incidents/alerts/logs/audit as sub-views) + sites + vendors + Add Device form (RHF+Zod, test-connection).
- **2-b** Worker mini-service v1 (bun:3030): adapter contract, generic+cisco/fortigate/sophos/hpe simulator adapters, capability manifests, job runner (retry/timeout/DLQ/locks), scheduler loop, health endpoint. Gateway wiring via `XTransformPort`.
- **2-c** Discovery job (simulated scan → candidate devices → import flow), CSV import, credential profiles UI (never display secrets).
- **Gate G2:** add/import device → test connection → backup-now job runs via worker → job center shows progress → device detail reflects state.

## Phase 3 — Configuration Management (3-a, 3-b, 3-c)
- **3-a** Backup engine end-to-end: policies (cron), scheduled/manual/pre/post-change backups, encrypted storage (AES-256-GCM), SHA-256, version history, retention pruning, backup compliance dashboard.
- **3-b** Config viewer (mono, line numbers, search, copy, wrap, secrets masking, fullscreen) + diff engine (unified/split, raw/normalized, normalization rules).
- **3-c** Baselines (approve snapshot), drift detection job + drift records + drift dashboard, restore workflow (guarded multi-step HighRiskActionDialog → change request).
- **Gate G3:** edit config on a simulated device → next poll detects drift → diff view shows normalized changes → baseline approve → restore guarded flow queues an approved change.

## Phase 4 — Change Management (4-a, 4-b)
- **4-a** Change CRUD + 8-step wizard (general/scope/implementation/validation/rollback/schedule/risk/review), risk scoring engine (0–100 table per Plan §23), templates (per-vendor), calendar with conflict highlighting.
- **4-b** Approval workflow (technical/security/manager/CAB, SoD rule requester≠approver for high risk), execution engine (pre-checks incl. "config changed since approval → BLOCK", pre-backup, apply steps, post-validation, post-backup, auto-rollback on failure), execution timeline UI, change dashboards.
- **Gate G4:** create change → approve as second user → execute → watch step timeline succeed; force failure → auto-rollback → incident correlation offered.

## Phase 5 — Operations: Alerts, Incidents, NOC (5-a, 5-b)
- **5-a** Alert rules, threshold evaluation in worker, dedup/grouping/suppression, maintenance-window suppression, alert stream UI (ack/assign/suppress/create incident), notifications center (separate from alerts per §74).
- **5-b** Incident lifecycle (SEV1-4, SLA timers, timeline with system/user/integration attribution), change↔incident correlation window search, RCA/PIR form + PDF export, incident dashboards, NOC fullscreen view.
- **Gate G5:** simulated device down → root alert only (children suppressed) → incident auto-created with SLA → acknowledge → resolve → PIR exported.

## Phase 6 — Performance & Metrics (6)
- Performance dashboards (device/interface/WAN/latency/availability/capacity), rollup retention policies UI, capacity risk list, time-range control everywhere, forecast (linear) capacity chart.
- **Gate G6:** 7d/30d views backed by rollups; retention pruning provable.

## Phase 7 — Administration, Security & Integrations (7-a, 7-b)
- **7-a** Users/roles/permissions UI (granular perms + site scoping), NextAuth credentials login + session enforcement, API clients (scoped tokens), webhooks (signed), notification channels (email/webhook), collectors registry, device drivers page, retention settings, system settings.
- **7-b** Audit explorer (filterable, before/after, correlation ID), audit hash chain, API governance (rate limit, request IDs), backup/download audit.
- **Gate G7:** RBAC demo — auditor sees read-only UI; secrets masked; export audited.

## Phase 8 — i18n, RTL, Accessibility & Polish (8-a, 8-b)
- **8-a** next-intl EN/AR dictionaries by domain, direction-aware layout pass, tech blocks stay LTR.
- **8-b** A11y pass (WCAG 2.2 AA targets: keyboard nav, focus, reduced motion, chart summaries), responsive QA matrix (375→1920, zoom), UX acceptance gates (§108–§110), final design governance doc.
- **Gate G8:** full QA matrix green; worklog final report.

## Phase 9 — Hardening & Demo Readiness (stretch)
Job center UX, saved-views persistence, report scheduler, seeded demo narrative ("guided tour" dataset), performance pass on DataTable with 1k+ rows.

## Parked (explicitly non-MVP per Plan §91)
AI troubleshooting, auto-RCA, flow analytics, full CMDB, firmware lifecycle, ZTP, predictive failure, capacity ML, natural-language changes, additional vendors (Juniper/Palo/CheckPoint/…), collector agent distribution, HA/DR topology.

# PART C — IMPLEMENTATION TASKS (execution backlog)

Current sprint tasks (Phase 0/1) with acceptance criteria:

- **Task 1-a — Data foundation** (general-purpose agent)
  - Deliver: `prisma/schema.prisma` (User, Role, Organization, Site, Vendor, Device, DeviceInterface, CredentialProfile, BackupPolicy, ConfigSnapshot, ConfigBaseline, DriftRecord, ChangeRequest, ChangeDevice, ChangeStep, ChangeApproval, Incident, IncidentDevice, IncidentEvent, Alert, AlertRule, MaintenanceWindow, MetricSample, MetricRollup, JobExecution, AuditEvent, ReportSchedule, Setting — string status fields, TS constant maps in `src/lib/domain/status.ts` consumed by app), `bun run db:push`, `prisma/seed.ts` with vendor-authentic fixtures, query indexes.
  - Accept: push + seed succeed; counts plausible; no Prisma enums (SQLite); seed re-runnable (idempotent reset).

- **Task 1-b — Design foundation** (frontend-styling-expert agent)
  - Deliver: tokens per spec §23–§35 in globals.css (shadcn-compatible variables + FayaNMS extensions), density attribute support, domain badge/status components with icon+text (never color-only), KpiCard, PageHeader, EmptyState, ErrorState, SectionCard, TimeRangeSelect, FilterChip, fonts, ThemeProvider wiring.
  - Accept: `bun run lint` clean; story-free compile; existing ui/* untouched; dark mode + density via data attributes verified in isolation page temporarily.

- **Task 1-c — Shell + Dashboard + API v1** (full-stack-developer agent; blocked by 1-a, 1-b)
  - Deliver: `/` app shell (sidebar/header/footer/command palette/view router with dynamic views), Dashboard fed by `/api/v1/dashboard`, list APIs for devices/incidents/changes/alerts/jobs with Zod + envelope, TanStack Query + `src/lib/query-keys.ts` + `src/lib/api-client.ts`, stub views with proper empty states, sticky footer, responsive + a11y basics.
  - Accept: G1 gate above.

Later agents MUST re-read this file, pick the next unchecked task, append results, and update the roadmap checkboxes below.

## Roadmap status tracker
- [x] Phase 0/1 planning (Task 0)
- [x] 1-a Data foundation
- [x] 1-b Design foundation
- [x] 1-c Shell + Dashboard + API v1
- [x] Gate G1 verification — PASSED
- [x] 2-a Device inventory depth (DataTable + detail + sites + add device)
- [x] 2-b Worker mini-service v1 (bun:3030) + worker API
- [x] 2-c Discovery + CSV import + credential profiles
- [x] Gate G2 verification — PASSED
- [ ] Phase 3 — Configuration Management (3-a backup engine/policies/retention, 3-b config viewer depth + diff engine, 3-c baselines + drift + guarded restore) → Gate G3
- [ ] Phase 4 — Change Management (4-a wizard + risk engine, 4-b approvals + execution engine) → Gate G4
- [ ] Phase 5 — Operations: alerts rules/dedup, incident lifecycle + NOC (5-a, 5-b) → Gate G5
- [ ] Phase 6 — Performance & metrics dashboards + rollups (6) → Gate G6
- [ ] Phase 7 — Administration, security, audit explorer (7-a, 7-b) → Gate G7
- [ ] Phase 8 — i18n/RTL, accessibility & polish (8-a, 8-b) → Gate G8
- [ ] Phase 9 — Hardening & demo readiness (stretch)

---
Task ID: 1-b
Agent: frontend-styling-expert
Task: Design foundation — token architecture in globals.css, Inter/JetBrains Mono fonts + ThemeProvider wiring, status single-source-of-truth, domain components, preferences store.

Work Log:
- Read worklog (PART A audit + PART B roadmap + conventions) and existing globals.css/layout.tsx before editing; kept every existing shadcn variable working on the same `@theme inline` mechanism.
- globals.css token architecture:
  - Neutrals — light: bg #FAFAFA (neutral-50), surface/card white, surface-subtle #FAFAFA, border #E5E5E5/#D4D4D4 (neutral-200/300), text #0A0A0A/#525252; dark: bg #0A0A0A (neutral-950), surface/card #171717 (neutral-900), border #262626/#404040 (neutral-800/700), text #FAFAFA/#A3A3A3; new --surface/--surface-subtle. Layered dark surfaces, no absolute black.
  - Brand — --primary #2563EB (light+dark), --primary-hover #1D4ED8 light / #3B82F6 dark; --brand-accent #0891B2 light / #22D3EE dark (links, chart emphasis, focus only). shadcn's --accent hover surface deliberately stays neutral; brand accent exposed separately.
  - Status families — --success/--warning/--danger/--danger-orange/--info/--neutral each with -foreground and -subtle (subtle = color-mix translucent fill so badge backgrounds layer over any surface in both themes); exposed as --color-* so bg-success-subtle / text-success / border-success/25 etc. work.
  - Severity aliases — --severity-{critical,high,medium,low,info} (+ -subtle) -> danger / danger-orange / warning / info / neutral; single mapping reused everywhere.
  - Radius — explicit scale: --radius-sm 6px (small controls), --radius-md 8px (inputs/buttons/selects), --radius-lg 12px (dialogs/sheets/large panels), --radius-xl 10px (cards/KPI/section cards); explicit values because shadcn slots map modals->rounded-lg and cards->rounded-xl; --radius kept at 0.625rem for compatibility.
  - Density — :root[data-density="comfortable"|"compact"|"dense"] drives --density-row-h 44/36/28px, --density-control-h 36/32/28px, --density-toolbar-h 48/40/36px, --density-pad 16/12/8px, --density-cell-x 12/10/8px; font sizes never change. Named spacing utilities p-card/p-cell-x/h-row generated via --spacing-card/-cell-x/-row.
  - Shadows — --elevation-1/2/3 (subtle -> strong, e2/e3 reserved for menus/popovers/dialogs/command palette) exposed as shadow-e1/e2/e3 utilities; dark theme uses higher alphas.
  - Base layer — thin custom scrollbars (webkit + Firefox) via --scrollbar-thumb(-hover); :focus-visible accent outline with opt-out rule for shadcn components that render their own ring (ring resolves to accent via --ring); ::selection; prefers-reduced-motion support.
  - Utilities — .font-tech (mono, 13px, tabular figures, for IP/MAC/CLI/config) and .ltr-technical (direction:ltr + isolate for RTL layouts); logical-property guidance (ms-/me-/ps-/pe-/start-/end-) documented in CSS comments.
- Fonts: next/font/google Inter (--font-sans) + JetBrains_Mono (--font-mono), subsets ["latin"], display swap — Google Fonts fetch SUCCEEDED in this sandbox (compiled CSS contains "Inter", "Inter Fallback"; body classes present), so no fallback removal was needed; system font stacks remain wired as var() fallbacks in @theme inline. Metadata updated (title "FayaNMS — Network Operations Management", NMS description, icon kept). suppressHydrationWarning already on <html>; children wrapped in ThemeProvider (attribute="class", defaultTheme="system", enableSystem, disableTransitionOnChange) via new client wrapper src/components/providers/theme-provider.tsx.
- src/lib/domain/status.ts (no external deps): DEVICE_STATUS, SEVERITY, INCIDENT_SEVERITY (SEV1-SEV4), CHANGE_STATUS (16 lifecycle states, each with family: active/success/warning/danger/neutral), RISK_LEVEL, BACKUP_STATUS, BACKUP_COMPLIANCE, DRIFT_STATUS, JOB_STATUS, ALERT_STATUS, INCIDENT_STATUS; StatusBadgeConfig {key,label,token,icon,dotClass,badgeClass,iconClass}; getStatusConfig(map, key) safe lookup (trims/uppercases/normalizes hyphens+spaces, prefers the map's own UNKNOWN, falls back to neutral "Unknown", never throws, always icon+label). Icon names verified against installed lucide-react 0.525 exports.
- src/components/domain/: status-dot.tsx (pulse + aria), status-icon.tsx (name->lucide registry), status-badge.tsx (shared subtle-bg badge), device-status-badge.tsx, severity-badge.tsx, change-status-badge.tsx, change-risk-badge.tsx, backup-status-badge.tsx (+ BackupComplianceBadge), drift-status-badge.tsx, job-status-badge.tsx, kpi-card.tsx (loading skeleton matches final structure, trend arrow with semantic tone via positive flag, live status dot, truncation+title), page-header.tsx (breadcrumbs, max 1 primary action rendered last, 2-3 secondary, responsive stacking), empty-state.tsx, error-state.tsx (reason box, correlation ID in .font-tech, retry), section-card.tsx (rounded-xl card, density-aware p-card content), time-range-select.tsx (15m/1h/6h/24h/7d/30d/custom, controlled), filter-chip.tsx ("Vendor: Cisco x", logical ps-/pe- padding).
- src/stores/preferences.ts: zustand + persist ("fayanms-prefs") {density, sidebarCollapsed, setDensity, toggleSidebar}.
- Verification: `bun run lint` clean; `bunx tsc --noEmit` — zero errors under src/ (remaining output is pre-existing examples/ + skills/ noise outside src/, untouched by this task); curl / -> 200; compiled CSS spot-checked (.rounded-md 8px, .rounded-lg 12px, .rounded-xl 10px, .bg-success-subtle -> var(--success-subtle), .p-card -> var(--density-pad), .shadow-e1, .font-tech, .ltr-technical, .text-danger-orange all generated); dev.log shows clean fast recompiles, no font-fetch/compile/hydration errors. ui/*, page.tsx, prisma/**, package.json untouched; no new npm packages.

Stage Summary:
- Artifacts: src/app/globals.css (full token architecture), src/app/layout.tsx + src/components/providers/theme-provider.tsx (fonts + theming), src/lib/domain/status.ts, 13 domain components in src/components/domain/, src/stores/preferences.ts.
- Token consumption for domain teams: colors via bg-{token}-subtle text-{token} border-{token}/25 and dot bg-{token}; severity via bg-severity-high etc.; radius rounded-sm/md/lg/xl; elevation shadow-e1/e2/e3; density via h-(--density-row-h), h-(--density-control-h), p-card, px-cell-x; technical data via .font-tech + .ltr-technical. Apply <html data-density> from usePreferencesStore to activate tiers (Task 1-c shell).
- Statuses: always render through StatusBadge/StatusDot + the domain map from @/lib/domain/status — never hardcode colors/labels; unknown values degrade to neutral "Unknown" with icon automatically (never color-only). DataTable (next task) must use --density-row-h/--density-cell-x so the density toggle works end-to-end.
- Font strategy: next/font (Inter + JetBrains Mono) works in this sandbox; keep it. If fonts ever fail in a offline build, remove the imports and rely on the system stacks already present in the --font-sans/--font-mono var() fallbacks.

---
Task ID: 1-a
Agent: general-purpose
Task: Data foundation — rewrite prisma/schema.prisma (SQLite-safe, all Part-C entities), push to db, and build the idempotent realistic seed (prisma/seed.ts).

Work Log:
- Read worklog.md (PART A audit + PART B roadmap + PART C backlog) and audited existing files (schema.prisma was the Next.js starter default; package.json scripts; .env DATABASE_URL=file:/home/z/my-project/db/custom.db).
- Rewrote `prisma/schema.prisma`: 28 models (User, Role, Organization, Site, Vendor, Device, DeviceInterface, CredentialProfile, BackupPolicy, ConfigSnapshot, ConfigBaseline, DriftRecord, ChangeRequest, ChangeDevice, ChangeStep, ChangeApproval, Incident, IncidentDevice, IncidentEvent, Alert, AlertRule, MaintenanceWindow, MetricSample, MetricRollup, JobExecution, AuditEvent, ReportSchedule, Setting). Zero Prisma `enum` (allowed values documented in field comments — Task 1-b's `src/lib/domain/status.ts` maps align with them), zero Prisma `Json` (serialized-JSON String columns suffixed `*Json`), BigInt counters on DeviceInterface. Explicit onDelete: Cascade for parent-owned children (Device→interfaces/snapshots/baselines/drifts/metrics/alerts, Site→sites-of-org, ChangeRequest→steps/devices/approvals, Incident→events/devices, snapshots→baselines+drifts), SetNull for optional references (siteId/userId/changeId/jobId/ruleId/incidentId/approverId/ownerId…), Restrict for Device.vendorId and ChangeRequest.requesterId. Indexes on hot paths: deviceId+createdAt (snapshots), deviceId+metric+ts (samples), unique deviceId+metric+granularity+periodStart (rollups), status+priority (jobs), status/severity/criticality/backupCompliance filters, correlationId/createdAt (audit+jobs), plus @@unique deviceId+version, changeId+deviceId, incidentId+deviceId, changeId+level, changeId+order, deviceId+name (interfaces).
- `bun run db:push` → OK ("Your database is now in sync", Prisma client regenerated, no `@db` native-type issues).
- Created `prisma/seed.ts` (~1.9k lines; run with `bun prisma/seed.ts`; deterministic mulberry32 PRNG): wipes all tables via deleteMany in FK-safe order then rebuilds — verified idempotent (two consecutive runs → identical counts). Content: 1 org + 4 sites (HQ-Sanaa, DC-Aden, Branch-Hodeidah, Branch-Mukalla); 5 vendors; 26 devices (21 ONLINE / 2 MAINTENANCE / 1 OFFLINE / 1 DEGRADED / 1 UNMANAGED) with realistic hostnames/models/firmware (ISR4451-X, C9500-48Y4C, FortiGate 600F/601E, Sophos XGS 3300/2300, HPE 6300M/6400/6100, NX-OS N9K, 2960X aging…); 134 DeviceInterfaces with mixed admin/oper states and BigInt bps counters; 3 CredentialProfiles (vault:// secretRefs only); 2 BackupPolicies (incl. "0 2 * * *" daily).
- ConfigSnapshots: 34 across 9 devices (3-5 versions each) with vendor-authentic text — Cisco IOS XE (BGP/QoS/snmp/aaa blocks, per-version feature flags), Cisco Catalyst 9500 (VLANs/SVI/HSRP/spanning-tree), FortiOS (`config system global`/`interface`/`firewall policy`/`system ha`), Sophos SFOS CLI (zones/rules/ha blocks), HPE AOS-CX (`vlan 10/20/30/99`, `interface 1/1/24`, lag 1) — real sha256 + normalizedText + sizeBytes; PRE_CHANGE/POST_CHANGE pair on HQ-Core-RTR-01 tied to CHG-2026-00407. DRIFT STORY: HQ-Access-SW-01 baseline v3 approved (gold config incl. camera VLAN 30) → v4 introduces unauthorized `vlan 55 GUEST-TEMP` + port access, v5 changes `interface 1/1/24 description` UPLINK-CORE-01→02 → 2 OPEN DriftRecords vs v3 + INC-2026-00104 + DRIFT_DETECTED audit events. Baselines on 3 devices (HQ-Core-RTR-01 v4, HQ-WAN-FW-01 v3, HQ-Access-SW-01 v3).
- Metrics: 24 devices × CPU/MEMORY/UTILIZATION_IN/OUT × 24h — recent 4h at 5-min + older 20h at 15-min = 12,384 MetricSamples (diurnal wave, per-device bases: aging 2960X high, DEGRADED Sophos 96-99% spikes; UTIL samples linked to each device's uplink interface) + computed 1H MetricRollups (2,400 rows: avg/max/min/p95). See deviation note below for the two-tier resolution.
- Changes: 10 ChangeRequests CHG-2026-00401..410 — 2 DRAFT, 2 AWAITING_APPROVAL (PENDING approvals), 1 SCHEDULED (approved), 1 EXECUTING (CHECK/BACKUP PASSED, APPLY RUNNING, VALIDATE/ROLLBACK PENDING), 3 CLOSED-SUCCESSFUL (full PASSED steps + SKIPPED rollback), 1 ROLLBACK story (VALIDATE FAILED → auto-rollback PASSED) correlated to INC-2026-00105; 14 ChangeDevice, 30 ChangeStep, 15 ChangeApproval (unique changeId+level).
- Operations: 6 Incidents INC-2026-00101..106 (SEV1 INVESTIGATING w/ slaDueAt ≈ now+20min, SEV2 ACKNOWLEDGED, 2 SEV3, SEV3 RESOLVED + SEV2 CLOSED with rootCause/corrective/preventive) + 17 IncidentEvents (SYSTEM/USER/INTEGRATION) + 7 IncidentDevice links (one incident on 2 HA firewalls); 12 Alerts (8 ACTIVE incl. 1 CRITICAL BGP-down linked to INC-00101, 2 ACKNOWLEDGED, 1 SUPPRESSED by active maintenance window, 1 RESOLVED) + 3 AlertRules (CPU>95/5m, UTIL_IN≥90/15m, Device Unreachable via pseudo-metric AVAILABILITY<1/3m); 2 MaintenanceWindows (1 active on BR2-Access-SW-01, alert suppression narrative); 15 JobExecutions (9 SUCCEEDED/3 RUNNING/2 QUEUED/1 FAILED backup attempts=3, correlationId JOB-XXXXXX, incl. pre-change backup for CHG-00406 and queued VALIDATION step); 37 AuditEvents (DEVICE_CREATED/UPDATED, CONFIG_BACKUP incl. FAILURE, CONFIG_DOWNLOAD, CHANGE_CREATED/APPROVED/EXECUTED, BASELINE_APPROVED, DRIFT_DETECTED, INCIDENT_CREATED, ALERT_ACKNOWLEDGED, USER_LOGIN + LOGIN_FAILED) with beforeJson/afterJson and correlation IDs; 2 ReportSchedules; 6 Settings; 5 Users (admin/noc1/engineer1/auditor1/manager1, passwordHash null) + 6 Roles with permissionsJson.
- Fixed one bug found during dev: snapshots referenced CHG-2026-00407 before changes existed (FK violation) — reordered seeding so changes precede snapshots.
- Verification: `bun prisma/seed.ts` run twice — clean and idempotent (summary table TOTAL 15,185 both times); one-off bun spot-check script (deleted afterwards) confirmed: devices by status 21/2/1/1/1, drift device snapshot chain v1..v5 (MANUAL/SCHEDULED/BASELINE/SCHEDULED/CURRENT), VLAN 55 present in v5 raw text, sha256 length 64, FortiOS header authentic, changes by status {DRAFT 2, AWAITING_APPROVAL 2, SCHEDULED 1, EXECUTING 1, CLOSED 3, ROLLBACK 1}, alert mix {ACTIVE 8 incl 1 CRITICAL, ACK 2, SUPPRESSED 1, RESOLVED 1}, latest 1H CPU rollup avg/max/min/p95 sane, INC-2026-00105 ↔ CHG-2026-00410 correlation, jobs 9/3/2/1, BigInt counters populated; `bun run lint` clean. Only prisma/schema.prisma, prisma/seed.ts and worklog.md touched.

Stage Summary:
- Key artifacts: `prisma/schema.prisma` (28 SQLite-safe models; enum values documented as comments; `*Json` String columns; full index/relation coverage) and `prisma/seed.ts` (idempotent deterministic seed with vendor-authentic configs, drift narrative, full change/incident/alert/job/audit web). DB at db/custom.db is in sync and populated (15,185 rows; per-table counts printed by the seed).
- Decisions: JSON handled as serialized String columns (`payloadJson`, `tagsJson`, `permissionsJson`, `beforeJson`/`afterJson`, `recipientsJson`, `scopeJson`, `valueJson`…); enumerations as String + comment-documented values (align with 1-b's status maps); readable fixed IDs (dev-*, chg-2026-*, inc-2026-*, JOB-XXXXXX) for deterministic cross-references; MetricRollup unique key prevents double-rollup; Device.vendorId Restrict so vendor deletion can't cascade devices.
- Deviations from spec: (1) metric sampling two-tier (5-min last 4h + 15-min prior 20h) instead of flat 5-min×24h — flat would be 27.6k rows vs the ~15-20k cap; schema already supports 5M/1H/1D rollups; (2) 2 devices in MAINTENANCE (spec: 1) — one is the EXECUTING change target, the other holds the active maintenance window; (3) 2 BackupPolicies / 2 MaintenanceWindows instead of exactly 1 (1 window active, per spec); (4) 37 audit events (~30 asked).
- Next for other agents: 1-c can build dashboard KPIs from seeded status mixes (devices by status, open incidents/alerts, backup compliance, recent jobs, latest audit); Phase 3 diff/drift UI should demo HQ-Access-SW-01 v3↔v4/v5; worker mini-service (2-b) should pick up QUEUED jobs (job-010 VALIDATION, job-012 CONFIG_BACKUP) and the failed backup story on HQ-IDF-SW-01 is ready for retry logic.

---
Task ID: 1-c
Agent: full-stack-developer (verified & logged by Orchestrator after agent context deadline)
Task: App shell at / (sidebar, header, command palette, view router, sticky footer) + Dashboard + /api/v1 endpoints.

Work Log:
- Replaced src/app/page.tsx with thin wrapper rendering <AppShell/> (single-route ADR-02 preserved).
- Shell: src/components/shell/{app-shell,app-sidebar,sidebar-nav,app-header,app-footer,command-palette,job-center,view-router}.tsx — grouped collapsible sidebar w/ real badge counts, header (search/⌘K palette, notifications, theme+density toggles, user menu, jobs indicator), sticky footer (status + version + last refresh), mobile Sheet drawer.
- View router: src/stores/navigation.ts (persisted Zustand) + src/lib/navigation/{registry,sidebar-config}.ts covering full sidebar taxonomy; implemented views: dashboard, network.devices, ops.alerts, ops.incidents, changes.all, ops.jobs; rest render PlaceholderView with EmptyState + phase labels.
- Dashboard (src/components/views/dashboard-view.tsx + src/components/dashboard/*): KPI row, 24h CPU/Memory utilization trend (Recharts), health distribution donut, active incidents, upcoming changes, backup compliance, capacity risks, recent activity — skeletons/errors/empty states throughout.
- API v1 (src/app/api/v1/**): dashboard, devices (filters+sort+pagination), incidents, changes, alerts, jobs (GET+POST backup-now), meta (vendors+sites), search — Zod-validated, {success,data,meta} envelope, correlationId'd job creation.
- Client data layer: src/lib/api-client.ts (apiFetch envelope handling), src/lib/query-keys.ts, src/hooks/api/* (useDashboard/useDevices/useJobs/...).

Stage Summary:
- Gate G1 code-complete and orchestrator-verified: lint clean; tsc clean under src/ (only pre-existing examples/skills noise); /api/v1/dashboard returns live data (25 managed devices, 21 online, 1 critical alert, 4 active incidents, 2 pending approvals, 92% backup compliance, 2 drift, 24h trend); GET / 200. Browser E2E verification executed by orchestrator separately.

---
Task ID: G1-VERIFY
Agent: Orchestrator (Z.ai Code, via agent-browser)
Task: End-to-end browser verification of Gate G1 (Phase 0/1 Foundation).

Work Log:
- agent-browser opened /; title "FayaNMS — Network Operations Management"; zero page errors.
- FOUND & FIXED bug: BreadcrumbSeparator (an <li>) nested inside BreadcrumbItem (an <li>) in app-header.tsx + page-header.tsx caused hydration DOM-nesting errors ("2 Issues" overlay). Fixed by hoisting separator to a Fragment sibling. Re-verified: 0 errors, 0 console errors after clean reload.
- Verified default view = dashboard (fresh localStorage), devices-view persistence via fayanms-nav works for returning sessions.
- Golden path: command palette opens from header search (Quick Actions + Navigation); typed "core" -> live /api/v1/search returned devices (DC-Core-RTR-01…) and changes (CHG-2026-00405); clicking a result navigated to Devices view.
- Backup-now action on device row: toast "Backup job queued — Correlation JOB-6PBQ3H"; POST /api/v1/jobs verified QUEUED row in DB; header jobs badge 6 -> 7 live.
- Theme cycled to dark: layered neutral surfaces, badges/health bars adapt, no contrast issues.
- Responsive 375px: no horizontal overflow, hamburger drawer header, filters stack, table degrades to essential columns.
- Footer: sticky at viewport bottom on short scroll; status + version + last-refresh present.
- bun run lint clean; dev.log shows only historical Fast-Refresh reload notes from mid-edit hot reloads, no runtime errors on final state.

Stage Summary:
- GATE G1 PASSED. Phase 0/1 Foundation is browser-verified complete: shell + view router + dashboard + devices list + alerts/incidents/changes/jobs views + 8 API endpoints over seeded SQLite (15,185 rows). Ready for Phase 2 (Device Inventory depth + Worker mini-service per roadmap).

---
Task ID: 2-a
Agent: full-stack-developer (code landed before agent context deadline; completed, fixed and verified by Orchestrator)
Task: Device inventory depth — DataTable upgrade, device detail sub-views, Sites view, Add Device flow + API surface.

Work Log:
- Agent delivered: rewritten devices-view.tsx (server sort/filter/pagination, column visibility, row selection + bulk backup-now, saved views in new src/stores/device-views.ts, CSV export, density-token rows), device-detail-view.tsx (9 lazy tabs), device-form-sheet.tsx (RHF+Zod add/edit sheet), device-health-tab.tsx, device-interfaces-tab.tsx, config-viewer.tsx, extended api-client.ts (DeviceDetail/SiteSummary/TestConnectionResult/etc.), query-keys device* + sites, use-devices/use-device-detail/use-sites hooks, /api/v1/devices (extended + POST), /api/v1/devices/[id] (GET/PATCH) with subresources metrics/snapshots/interfaces/alerts/incidents/changes/audit, /api/v1/devices/bulk, /api/v1/devices/test-connection (proxies worker :3030 /simulate/connect with 8s timeout, graceful worker-down handling), /api/v1/sites; view-router + registry + ViewKey wired for network.device-detail (hidden from sidebar).
- Agent died at context deadline BEFORE writing: sites-view.tsx, device-config-tab.tsx, device-records-tabs.tsx, plus 5 small wiring errors.
- Orchestrator completion pass:
  - Wrote src/components/views/sites-view.tsx (PageHeader + site cards: status dot mix from DEVICE_STATUS map, interface count, BackupComplianceBadge, "View devices" → setActiveView("network.devices", { siteId })).
  - Wrote src/components/device/device-config-tab.tsx (version history list + ConfigViewer embed, SNAPSHOT_SOURCE/STATUS maps, primary-subtle selection highlight).
  - Wrote src/components/device/device-records-tabs.tsx (BackupsTab with compliance cards + history + "View config" jump; ChangesTab with ChangeStatus/RiskBadge; IncidentsTab with SeverityBadge + overdue-SLA danger text; DeviceAlertsTab with SEVERITY/ALERT_STATUS maps; DeviceAuditTab with success/failure dots + correlation IDs).
  - Fixes: device-detail-view render-time state reset (prev-device-id pattern) replacing setState-in-effect lint error; useToast import; apiFetch/apiRequest missing imports in use-device-detail/use-devices; Sheet side="end"→"right"; removed unused eslint-disable; useWatch() instead of form.watch() in device-form-sheet (React Compiler incompatible-library warning).
  - Added siteId-param consumer effect in devices-view for Sites drill-down.
- Verification: bun run lint clean; bunx tsc --noEmit clean under src/ (only pre-existing examples/+skills/ noise); curl: devices?sort=hostname OK, /api/v1/sites OK, device detail OK, metrics 24h/7d series OK (6h empty = seed aging, documented), snapshots v6 CURRENT from worker OK, interfaces with BigInt-as-string OK; dev.log no runtime errors.

Stage Summary:
- Devices view is a full Phase-2 inventory surface; device detail covers overview/health/interfaces/config/backups/changes/incidents/alerts/audit with per-tab lazy queries; Sites view + drill-down filter live; Add/Edit device form posts with audit + test-connection gracefully degrades when worker is down.
- Decisions: detail view reached via setActiveView("network.device-detail", { deviceId }); saved views persisted in fayanms-store device-views; CSV export client-side (cap 500 rows); config tab is read-only viewer (diff/normalize explicitly Phase 3).
- Notes for 2-c: /api/v1/meta exposes credentialProfiles? (check route) — credential select in form exists; sites drill-down uses params.siteId; DISCOVERY view key network.discovery still placeholder.

---
Task ID: 2-b
Agent: general-purpose (code landed before agent context deadline; completed, fixed and verified by Orchestrator)
Task: Worker mini-service v1 (bun :3030) — adapter contract, simulators, job runner, scheduler + Next.js worker API.

Work Log:
- Agent delivered before deadline: mini-services/worker/{index,adapters,runner,scheduler,next-client}.ts (1096 lines, zero deps, port 3030 hardcoded, bun --hot), worker API routes src/app/api/v1/worker/{claim,progress,complete,tick,status}/route.ts.
- Architecture (binding): worker never opens SQLite; all persistence via http://localhost:3000 (backend-to-backend). Claim is atomic QUEUED→RUNNING via updateMany guard with attempts increment + scheduledAt filtering; complete(FAILED) requeues with 30s*attempts backoff until maxAttempts then dead-letters; claim enriches CONFIG_BACKUP payload with device fields (no second lookup); complete SUCCEEDED creates next-version ConfigSnapshot (demotes previous CURRENT→SUPERSEDED, sha256, sizeBytes, source from payload), updates device lastBackupAt/lastSeen, writes AuditEvent CONFIG_BACKUP with job correlationId; tick parses 5-field cron (ranges/lists/steps, Vixie dom/dow union), resolves policy scopeJson, excludes UNMANAGED+OFFLINE, 10-min per-device dedupe, cap 10/policy/tick; scheduler pokes tick every 30s; /health, /capabilities, /simulate/connect on 3030.
- Orchestrator found & fixed: next-client postJson unwrapped json.data but worker's own /simulate/connect answers flat {ok:true,...} → selfPost returned undefined → "sim.negotiated" crash on every backup. Fixed: return "data" in json ? json.data : json.
- Start & verify: worker started in background (bun --hot, nohup, logs mini-services/worker/worker.log + worker.out). E2E: seeded G1 backup-now jobs retried after backoff → SUCCEEDED (HQ-Core-SW-01 2328B cisco-ios; HQ-WAN-FW-01 2425B fortios); scheduler tick enqueued daily fleet backup once (17 jobs) then enqueued=0 (dedupe proven); job-012 (seeded payload without device ref) correctly failed "Unclaimable target" → dead-letters as designed; /health {claimed 18, completed 18, failed 0}; /api/v1/worker/status reachable:true + lastClaimAt; DB: new SCHEDULED v6 CURRENT snapshots with real sha256, previous demoted, devices lastBackupAt updated; dev.log clean.
- Note: VALIDATION/METRIC_POLL/CONFIG_APPLY/DISCOVERY seeded jobs untouched (types filter claims CONFIG_BACKUP only — DISCOVERY support is Task 2-c).

Stage Summary:
- Worker v1 operational end-to-end: claim → simulate connect (vendor-authentic banners) → generate config (cisco-ios/fortios/sfos/aos-cx/generic templates with per-run deltas) → progress posts → snapshot persistence + audit. Retry/backoff/DLQ semantics proven (job-012 dead-letter path).
- Contracts for 2-c: add DISCOVERY by (1) supporting type in claim types filter, (2) implementing runner branch that scans payload.subnets (seed job-014 payload is the shape), (3) persisting candidates via a new worker-facing endpoint or reusing complete with result shape agreed in 2-c.

---
Task ID: 2-c
Agent: general-purpose (code landed before agent context deadline; verified end-to-end by Orchestrator)
Task: Discovery job + import flow, CSV import, Credential Profiles UI.

Work Log:
- Agent delivered before deadline: worker DISCOVERY support (runner.ts runDiscoveryJob — per-subnet sweep simulation, 2–4 candidates/subnet with vendor-flavored IPs/hostnames/osFingerprints/confidence 60–99, per-subnet progress, result candidates persisted into job resultJson; claim types now ["CONFIG_BACKUP","DISCOVERY"]; /health gained completedByType). Next.js API: POST/GET /api/v1/discovery (queue scan with Zod CIDR validation + audit DISCOVERY_QUEUED; history = last 10 DISCOVERY jobs with parsed candidates), POST /api/v1/discovery/import (creates Devices from resultJson candidates, vendor key mapping, duplicate/unknown-vendor skips, resultJson rewritten with imported flags, DEVICE_CREATED audit per device), POST /api/v1/devices/csv-import (≤200 rows, per-row skip reasons, shared correlationId), GET /api/v1/credentials (+POST, /credentials/[id] PATCH — vault-ref only, never secrets), meta now exposes credentialProfiles. Views: discovery-view.tsx (New Scan dialog, scan history with live polling while jobs run, candidates table with imported states + bulk import dialog), credentials-view.tsx (vault security callout, profiles table, create/edit), CSV import dialog added to Devices view PageHeader; view-router wired for network.discovery + admin.credentials.
- Orchestrator verification (all curl): discovery scan of 10.60+10.70 → SUCCEEDED 6 candidates in 4s; import 2 → created:2 (vendor hpe/cisco mapped, model guess, status UNKNOWN); re-import → skipped "duplicate"; csv-import 3 rows → created:1 + skipped duplicate + skipped unknown vendor "juniper"; credentials POST (type enum from schema: SSH_PASSWORD|SSH_KEY|API_TOKEN|SNMPV3|HTTPS) → listed with vault refs only; worker DISCOVERY run visible in worker.log.
- Incident during verification: Next.js dev server crashed with Prisma P2028 (transaction timeout) under claim/complete contention. Root-cause fixes: (1) enabled WAL journal mode on db/custom.db (persistent), (2) raised claim + complete-success interactive transactions to { maxWait: 5s, timeout: 20s }. Worker restart + server restart recovered cleanly; no recurrence.
- Added stale-job reaper in tick route (by orchestrator): RUNNING CONFIG_BACKUP/DISCOVERY jobs older than 10 min → FAILED "Orphaned…" (cleaned 8 orphans stranded by the crash; seeded stuck job-014 DISCOVERY also reaped — now honestly FAILED in Job Center).
- Browser verification of the flows: see G2-VERIFY.

Stage Summary:
- Full Phase-2 onboarding surface: UI-driven discovery (scan → poll → select → import), CSV import (paste/file + template download), credential profiles (vault-ref-only invariant). Devices can enter the system via form, discovery import, or CSV — all audited.
- Contracts/notes for later phases: candidates live only in job resultJson (no schema change — deliberate); DISCOVERY claim filter means seed METRIC_POLL/CONFIG_APPLY/VALIDATION jobs stay untouched; configStatus field does NOT exist on Device (use backupCompliance/lastBackupAt); /health reports per-type counters.

---
Task ID: G2-VERIFY
Agent: Orchestrator (Z.ai Code, via agent-browser)
Task: End-to-end browser verification of Gate G2 (Phase 2 — Device Inventory & Simulation Core).

Work Log:
- / renders clean (no page errors, no console errors). Dashboard Recent Activity already shows system:backup-worker CONFIG_BACKUP events — worker visibly driving data.
- Devices view: full DataTable (search, status/vendor/site/criticality/compliance filters, Export CSV, column visibility, saved views, select-all + bulk) renders with live data; density tokens on rows.
- Device detail (BR1-Access-SW-01): all 9 tabs verified — Overview (KPIs, device record, recent activity), Health (CPU/Memory + Utilization charts render after FIX below), Config (version history incl. worker-created v5 CURRENT → ConfigViewer with mask/wrap/search + sha256), Backups (compliance cards + history), Changes/Incidents/Alerts/Audit lists.
- FIX during verification: useDeviceMetrics hook unwrapped the envelope wrong (series.map crash on Health tab — hook expected array, API returns data:{series}). Fixed in src/hooks/api/use-device-detail.ts; charts now render 6h/24h/7d.
- Test connection → worker: "Connection OK — 898 ms" (seeded device) and "Connection OK — 873 ms" (brand-new device) — test-connection → :3030/simulate/connect path proven both ways.
- Backup now (device header) → worker claims → Job Center sheet shows "Succeeded — Configuration backup — JOB-DCAFPF — device dev-br1-access-sw-01" with progress bar + auto-refresh note. Golden path G2 complete.
- Sites: cards with status dot mixes + compliance; "View devices" drill-down applies site filter with removable chip.
- Discovery (UI flow): New Scan dialog → queued → live-polling history row → SUCCEEDED 4 candidates → select all → import dialog (site/credential/criticality/managed) → "4 (4 imported)".
- Credentials view: security callout + vault-ref-only table verified.
- Add Device: form → validation correctly displayed when a field is invalid ("Enter a valid IPv4 management address") → create navigates to new device detail. CSV import dialog: paste → parse preview → "Import 2 rows" → both devices created (verified via API).
- Responsive 375px: no horizontal overflow anywhere tested; mobile drawer nav works; footer pushed naturally on long pages; shell structure (min-h-screen flex-col + footer) confirmed via computed styles. Theme cycle light/dark OK.
- bun run lint clean; tsc clean under src/; dev.log shows no runtime errors after fixes.

Stage Summary:
- GATE G2 PASSED. Phase 2 is browser-verified complete: device inventory depth (DataTable + detail + sites), worker mini-service executing real job lifecycle end-to-end (claim → simulate → persist → audit), discovery + CSV onboarding, credential profiles. Ready for Phase 3 (Configuration Management: policies/retention, diff engine, baselines, drift, guarded restore) per roadmap.
