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
- Bindable approvals (POL-001/002/003 — audit §6 P1-001/P1-002, landed
  2026-09-14): every decision is a `ChangeApprovalDecision` row bound to the
  SHA-256 fingerprint of the canonical approved spec and carrying a
  risk-tiered validity horizon (CRITICAL 14d · HIGH 30d · MEDIUM 90d ·
  LOW 180d). A level is satisfied by a QUORUM of DISTINCT approvers — 1
  everywhere except CAB on CRITICAL changes, which requires TWO distinct
  approvers; one principal can never fill two slots (a wildcard holder that
  already decided the level gets `DECISION_STILL_VALID`). The execute route
  re-computes the fingerprint inside the SAFE-003 transaction and refuses
  `APPROVAL_FINGERPRINT_MISMATCH` on any spec drift; a lapsed quorum refuses
  `APPROVAL_EXPIRED` and flips the change back to `AWAITING_APPROVAL`
  (`CHANGE_APPROVALS_INVALIDATED` audit) for a fresh approval cycle.
  Pre-POL approval data refuses `APPROVALS_REBIND_REQUIRED` — never a silent
  bypass.

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
are rejected by `requireUser` before entitlement is evaluated; bindable-approval
guards (POL-001/002/003): quorum of distinct approvers per level, re-cast
blocked while a decision is live (`DECISION_STILL_VALID`), fingerprint and
validity re-verified at execute time (`APPROVAL_FINGERPRINT_MISMATCH`,
`APPROVAL_EXPIRED`, `APPROVALS_REBIND_REQUIRED`).

### 2.2 Configuration / devices

| Endpoint | Method | Permission |
|---|---|---|
| `/devices` | POST | `device.write` |
| `/devices/[id]` | PATCH | `device.write` |
| `/devices/bulk` | POST | `device.write` |
| `/devices/csv-import` | POST | `device.write` |
| `/devices/test-connection` | POST | `config.backup` (data-plane probe; session-attributed audit) |
| `/devices/auto-detect` | POST | `device.detect` (R50-T020: DEDICATED active-probe permission — operator + engineer; admin via wildcard; target network policy + detection rate budgets enforced in-route) |
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

## 2.1 Read-plane handler gates (F-008 series — in progress)

Audit finding F-008 (P2): operational GETs under `/api/v1` were
authenticated ONLY by the proxy matcher (`/api/v1/:path*`) — a single
point of failure for the whole read plane. The remediation is a
defense-in-depth second layer: each read handler verifies the human
session itself via the typed helper `requireSessionRead()` in
`src/lib/auth/session.ts` (getToken + active-user DB re-verification,
per-request cached; fail-closed — 401 `UNAUTHENTICATED` /
`ACCOUNT_DISABLED`, machine and API-client bearer credentials refused).

Rollout order (one PR per domain group; the read-route matrix in
`tests/auth/authorization-contract.test.ts` enforces per-GET-handler
gates and pins the ungated allowlist at its phase-1 size — the list may
only shrink as the sweep lands):

| Phase | Domain | Status |
|---|---|---|
| 1 | dashboard (`/api/v1/dashboard`) | **Gated** |
| 2 | events / alerts (`events`, `alerts`, `alerts/rules` GETs) | pending |
| 3 | devices / interfaces (`devices`, `devices/[id]/*`, `interfaces`) | pending |
| 4 | the rest (admin reads, incidents, changes, cmdb, performance, …) | pending |

The proxy's API-client READ refusal (`API_CLIENT_READS_NOT_WIRED_BODY`,
src/proxy.ts) stays in force until every read handler is gated — only
then can the documented API-client read scopes ship safely.

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

- Resource-level scoping (site/device-group) is not yet part of
  `requirePermission` — audit §10 target model; permissions are currently
  global per role.
- Service JWTs remain symmetric-secret; per-service keys / asymmetric
  signing are Phase 21 (audit SVC-101 §11.3/§11.4).

### 5.1 CSRF origin control on cookie-session mutations (RT-008 / F-010)

Every mutating request (POST/PUT/PATCH/DELETE) authenticated by the
NextAuth cookie session carries a server-side Origin/Sec-Fetch-Site
validation in `src/proxy.ts`, as a second factor behind the
`SameSite=Lax` cookie policy:

- `Sec-Fetch-Site: same-origin` (or `none`) → allowed;
  `cross-site` AND `same-site` → 403 `CSRF_ORIGIN_REJECTED`
  (`same-site` is rejected deliberately — sibling-subdomain risk).
- No `Sec-Fetch-Site` but an `Origin` header → the Origin host must equal
  the `Host` header (the NextAuth origin-check pattern); mismatch → 403.
- Neither header → allowed (non-browser client; the cookie cannot be
  carried cross-site in practice, and SameSite still guards it).

The machine plane (verified service JWTs — they send no cookies) and the
API-client opaque-bearer mutation plane are exempt by evaluation order;
the public bootstrap surfaces (`/api/v1/meta`, `/api/v1/auth/*`) are
untouched (`/api/v1/auth/*` mutations are NextAuth's own
CSRF-protected endpoints).
