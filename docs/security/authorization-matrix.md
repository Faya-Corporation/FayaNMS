# FayaNMS Authorization Matrix

**Status:** AUTHORITATIVE (Phase 19-C / audit AUTHZ-101 + P19C-AUTHZ-005)
**Scope:** every mutating endpoint on `/api/v1`
**Enforcement:** server-side only — `requirePermission()` /
`requireApprovalEntitlement()` / `requireRole("admin")` /
`authenticateServiceRequest(scope)` (src/lib/auth/session.ts,
src/lib/auth/service-auth.ts). The middleware (src/middleware.ts) stays a
COARSE gate (401 unauthenticated, auditor write-block) and is never the
final authority. The UI mirrors the matrix as a courtesy only.

**Single source of truth for role permissions:**
`src/lib/auth/role-matrix.ts` (consumed by prisma/seed.ts,
scripts/sync-role-permissions.ts and tests/auth/role-matrix.test.ts).

---

## 1. Roles

| Role | Seed permissions |
|---|---|
| `admin` | `*` (wildcard) |
| `operator` | device.read, config.read, config.backup, config.download, config.restore, alert.read/ack/assign/suppress, incident.read/create/write/close, change.read/cancel/close, maintenance.read/write, job.read/run, metrics.read, report.read/create |
| `engineer` | device.read/write, config.read/write/backup/baseline/download/restore, change.read/create/execute/cancel/close, alert.read, incident.read/create/write/close, maintenance.read, job.read/run, metrics.read, firmware.execute, ztp.provision, cmdb.write, report.read/create |
| `manager` | device.read, config.read/download, change.read/approve/approve.technical/approve.manager/approve.cab/cancel/close, incident.read/close, alert.read, metrics.read, report.read/create/schedule/export |
| `auditor` | `*.read`, audit.export (+ middleware write block) |
| `viewer` | `*.read` |

Policy decisions recorded (audit §6/§7/§8/§36):
- `change.execute` — engineer only (admin via wildcard). Managers/operators
  cannot queue executions; this is the direct network-control gate once real
  adapters land.
- `config.restore` — operator + engineer: emergency restore requests are NOC
  work, but they remain approval-gated changes.
- Approval levels: `manager` = TECHNICAL + MANAGER + CAB; **SECURITY is
  reachable only through the admin wildcard** until a dedicated security
  officer role exists (one manager cannot fake SECURITY approval).
- Multi-level separation of duties: one principal cannot decide two
  different levels of the same change unless they hold `*`.

## 2. Mutation endpoints → permission

Every `POST/PUT/PATCH/DELETE` handler under `src/app/api/v1/**` is listed.
The static contract test (`tests/auth/authorization-contract.test.ts`)
enforces that each file below contains an auth marker and that the
allowlist (§4) does not silently grow.

### 2.1 Change management

| Endpoint | Method | Permission |
|---|---|---|
| `/changes` | POST | `change.create` |
| `/changes/[id]` (field edit / SUBMIT) | PATCH | `change.create` + draft ownership (requester; admin wildcard excepted) |
| `/changes/[id]` (CANCEL) | PATCH | `change.cancel` |
| `/changes/[id]` (CLOSE) | PATCH | `change.close` |
| `/changes/[id]/approvals` (TECHNICAL) | POST | `change.approve` + `change.approve.technical` |
| `/changes/[id]/approvals` (SECURITY) | POST | `change.approve` + `change.approve.security` (admin wildcard only) |
| `/changes/[id]/approvals` (MANAGER) | POST | `change.approve` + `change.approve.manager` |
| `/changes/[id]/approvals` (CAB) | POST | `change.approve` + `change.approve.cab` |
| `/changes/[id]/execute` | POST | `change.execute` |

Additional approval guards (server-authoritative): requester self-approval
blocked for HIGH/CRITICAL (SoD); one principal cannot decide two distinct
levels of one change unless wildcard; disabled accounts and expired sessions
are rejected by `requireUser` before entitlement is evaluated.

### 2.2 Configuration / devices

| Endpoint | Method | Permission |
|---|---|---|
| `/devices` | POST | `device.write` |
| `/devices/[id]` | PATCH | `device.write` |
| `/devices/bulk` | POST | `device.write` |
| `/devices/csv-import` | POST | `device.write` |
| `/devices/test-connection` | POST | `config.backup` (data-plane probe; session-attributed audit) |
| `/devices/[id]/snapshots/[snapshotId]/restore` | POST | `config.restore` |
| `/devices/[id]/snapshots/[snapshotId]/download` | GET | `config.download` (P19 SEC-005) |
| `/baselines` | POST | `config.baseline` |
| `/baselines/[id]` | DELETE | `config.baseline` |
| `/drift/[id]` | PATCH | `config.baseline` |
| `/drift/check` | POST | `config.baseline` |
| `/credentials` | POST | `admin.credential` |
| `/credentials/[id]` | PATCH | `admin.credential` |
| `/backup-policies` | POST | `config.backup` |
| `/backup-policies/[id]` | PATCH/DELETE | `config.backup` |
| `/discovery` | POST | `device.write` |
| `/discovery/import` | POST | `device.write` |

### 2.3 Alerts / incidents / maintenance

| Endpoint | Method | Permission |
|---|---|---|
| `/alerts/[id]/acknowledge` | POST | `alert.ack` |
| `/alerts/[id]/resolve` | POST | `alert.ack` |
| `/alerts/[id]/assign` | POST | `alert.assign` |
| `/alerts/[id]/suppress` / `unsuppress` | POST | `alert.suppress` |
| `/alerts/[id]/create-incident` | POST | `incident.create` |
| `/alerts/rules` | POST | `admin.system` |
| `/alerts/rules/[id]` | PATCH/DELETE | `admin.system` |
| `/incidents/[id]/[action]` (ack/resolve/assign/save-pir/link-change/unlink-change) | POST | `incident.write` |
| `/incidents/[id]/[action]` (close) | POST | `incident.close` |
| `/incidents/from-change` | POST | `incident.create` |
| `/maintenance` | POST | `maintenance.write` |
| `/maintenance/[id]` | PATCH/DELETE | `maintenance.write` |

### 2.4 Platform / admin surface

| Endpoint | Method | Permission |
|---|---|---|
| `/admin/users`, `/admin/users/[id]`, `/admin/users/[id]/reset-password` | POST/PATCH | `admin` ROLE gate (`requireRole("admin")`) |
| `/admin/api-clients` (+`/[id]`, `/[id]/rotate`) | POST/PATCH/DELETE | `admin` ROLE gate |
| `/admin/webhooks` (+`/[id]`) | POST/PATCH/DELETE | `admin` ROLE gate |
| `/admin/notification-channels` (+`/[id]`) | POST/PATCH/DELETE | `admin` ROLE gate |
| `/admin/settings` | PATCH | `admin` ROLE gate |
| `/admin/audit-chain/backfill` | POST | `admin` ROLE gate |
| `/admin/collectors/rebalance-plan` | POST | `admin` ROLE gate |
| `/admin/roles` | GET only | any active session (read-only catalog) |
| `/metrics/retention` | PUT | `admin.system` |
| `/firmware/upgrade` | POST | `firmware.execute` |
| `/ztp/claims` | POST | `ztp.provision` |
| `/ha/failover-test` | POST | `admin.system` |
| `/jobs` | POST | `job.run` |
| `/jobs/[id]/retry` / `/jobs/[id]/cancel` | POST | `job.run` |
| `/cmdb/items` (+`/[id]`) | POST/PATCH | `cmdb.write` |
| `/cmdb/relations` | POST/DELETE | `cmdb.write` |
| `/reports/run` | POST | `report.create` |
| `/reports/schedules` | POST | `report.schedule` |
| `/reports/schedules/[id]` | PATCH/DELETE | `report.schedule` |
| `/reports/schedules/[id]/run` | POST | `report.schedule` |
| `/reports/runs/[id]/download` | GET | `report.read` (`*.read` holders pass) |

## 3. Machine (service) endpoints — scope enforcement

Every middleware-exempt machine route authenticates a service JWT AND
enforces a required scope (Phase 19-C / audit SVC-101 — scopes are
authorization, not metadata). Issuer allowlist: `fayanms:worker` for the
worker's outbound calls (override: `FAYANMS_SERVICE_ISSUERS`).

| Endpoint | Required scope |
|---|---|
| `/worker/claim`, `/worker/complete`, `/worker/progress`, `/worker/tick`, `/worker/drift-evaluate`, `/worker/change-step`, `/worker/firmware-upgrade`, `/worker/ztp-provision` | `jobs` |
| `/alerts/evaluate` | `alerts` |
| `/reports/execute` | `reports` |
| `/metrics/retention/prune` | `metrics` (service path) OR human session with `metrics.prune` |
| `/worker/status` | human session (diagnostic; deliberately not service-exempt) |

Worker HTTP surface (mini-services/worker, audit GATEWAY-101): `/simulate/*`
requires a control-plane service JWT with the `simulate` scope (issuer
`fayanms:control`); `/capabilities` requires a control-plane token; `/health`
stays open for liveness only.

## 4. Documented allowlist (no permission gate)

These POST routes are session-authenticated self-service with no persistent
mutation or are bootstrap surfaces. The contract test pins this list:

| Endpoint | Justification |
|---|---|
| `/api/v1/meta` | public bootstrap (branding/status, read-only) |
| `/api/v1/auth/*` | session bootstrap; answers its own 401 envelope |
| `/api/v1/ai/assist`, `/api/v1/ai/query`, `/api/v1/ai/change-draft`, `/api/v1/ai/rca-draft` | session-gated generation helpers; no persistent state change (drafts are returned, never stored) |
| `/api/v1/notifications/read` | user-scoped: marks the CALLER's own notifications read |

Anything not in §2, §3 or §4 is a violation — the contract test fails the
build.

## 5. Known limitations (honest disclosure)

- Approval-level entitlements are role/permission-based; CAB QUORUM
  (minimum_distinct_approvers ≥ 2) and approval-expiry fingerprints
  (audit §37/§38) are Phase 21 policy work.
- Resource-level scoping (site/device-group) is not yet part of
  `requirePermission` — audit §10 target model; permissions are currently
  global per role.
- Service JWTs remain symmetric-secret; per-service keys / asymmetric
  signing are Phase 21 (audit SVC-101 §11.3/§11.4).
