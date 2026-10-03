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
| `/me/mfa/enroll` | POST | `admin`/`operator` ROLE gate (`requireRole("admin","operator")`) — self-service TOTP enrollment (F-034); pending until confirm; answers `MFA_DISABLED` under `FAYANMS_MFA_MODE=disabled` |
| `/me/mfa/confirm` | POST | `admin`/`operator` ROLE gate — first valid code enables the factor and issues single-use recovery codes (plaintexts shown once) (F-034) |
| `/me/mfa` | DELETE | `admin`/`operator` ROLE gate — fail-tight disable: password re-entry AND current TOTP code or unused recovery code (F-034) |
| `/admin/users` | GET | `admin`/`auditor` ROLE gate (`requireRole("admin","auditor")`) — the full email directory; other roles use `/meta/users` (local-part picker only) (F-029) |
| `/admin/users`, `/admin/users/[id]`, `/admin/users/[id]/reset-password` | POST/PATCH | `admin` ROLE gate (`requireRole("admin")`) — password SETs enforce the F-034 role-aware policy (privileged roles ≥ 12 chars, offline common-password denylist for all roles) |
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

## 2.1 Read-plane handler gates (F-008 series — COMPLETE)

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
| 2 | events / alerts (`events`, `alerts`, `alerts/rules` GETs) | **Gated** |
| 3 | devices / interfaces (`devices`, `devices/[id]/*`, `interfaces`) | **Gated** |
| 4a | incidents / changes / cmdb (11 GETs) **Gated** + admin reads RECOGNIZED as already admin-gated (`resolveAdminActor` → `requireRole("admin")` — a wrapper marker the matrix had not recognized, no code change; −19 → 28) | **Gated** |
| 4b | the long tail (backup-policies ×2, baselines, compliance/backup, discovery ×2, drift, firmware, flows ×2, ha, jobs, maintenance, metrics/retention, notifications, performance ×5, predictive, search, sites, snapshots, topology, ztp/claims) + the meta/reference DECISION (gated — with the sweep complete there is no remaining justification for a handler-bare authenticated surface; the public PRE-AUTH bootstrap stays `/api/v1/meta`, empty data by the RT-024 contract) | **Gated** |

**End-state:** the ungated read allowlist is down to exactly
`["meta/route.ts"]` (public bootstrap — pre-auth branding/status,
deliberate non-gate, empty data by contract), pinned BY NAME in the
matrix test. Every other GET handler under `/api/v1` verifies the human
session itself. Seven no-param GETs gained `request: Request`
signatures to feed the gate; locally-wrapped stricter permission gates
(`discovery/policies` → `device.read`, `flows/retention` →
`admin.system`) run AFTER the session gate, untouched.

**API-client read scopes — WIRED (the F-008 follow-up, batch 7):** the
proxy's old read-plane refusal (`API_CLIENT_READS_NOT_WIRED_BODY`) is
DELETED (984c479). With every read handler principal-gated, opaque
bearer candidates are admitted to BOTH planes and the handlers are the
validation authority: `requireSessionRead` authenticates API clients
through `authenticateApiClientRead` over `API_CLIENT_READ_DOMAINS` — a
CODE table (pathname prefix → route permission) deliberately narrower
than the human surface (devices/interfaces/cmdb/discovery →
`device.read`; alerts/events → `alert.read`; incidents →
`incident.read`; changes/approvals → `change.read`; metrics/performance
→ `metrics.read`; backup/baseline/compliance/snapshots → `config.read`).
`admin.read` stays catalog-RESERVED: admin surfaces are ROLE-gated
(`resolveAdminActor` → `requireRole("admin")`) and never consult the
client branch. Unwired domains answer a VALID client 403
`API_CLIENT_READS_DOMAIN_NOT_WIRED` (precise signal, never silent data);
stricter local gates keep their place AFTER the read gate
(`discovery/policies` → `requirePermission("device.read")` without the
opt-in → 403 `API_CLIENT_HUMAN_REQUIRED`; permission-gated reads such as
`credentials` → `admin.credential` answer with their own codes).

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
| `/api/v1/ai/assist`, `/api/v1/ai/query`, `/api/v1/ai/change-draft`, `/api/v1/ai/rca-draft` | session-gated generation helpers; no persistent state change (drafts are returned, never stored). F-030: each route consumes a durable per-user daily quota in-handler (`consumeAiDailyQuota` → `AiUsageDay`, `FAYANMS_AI_DAILY_LIMIT` default 200/day UTC; over-limit → 429 `AI_DAILY_QUOTA_EXCEEDED`; store failure → fail-closed 503) — the in-handler complement to the proxy's IP-keyed 10/min `ai` burst budget |
| `/api/v1/notifications/read` | user-scoped: marks the CALLER's own notifications read |

Anything not in §2, §3 or §4 is a violation — the contract test fails the
build.

## 5. Known limitations (honest disclosure)

- Service JWTs remain symmetric-secret; per-service keys / asymmetric
  signing are Phase 21 (audit SVC-101 §11.3/§11.4).

### 5.1 Resource-level site scoping (F-031 — infrastructure landed, single-tenant default)

The finding: permissions are global per role — `requirePermission` answers
"does this ROLE hold this PERMISSION" and nothing constrained a session to
a site or device group. Product tenancy is NOT landing now; what shipped is
the SCOPING INFRASTRUCTURE with single-tenant-safe defaults, so the
mechanism exists centrally, is enforced where wired, and today's behavior
is byte-unchanged.

**Claims.** The session JWT carries an OPTIONAL `sites: string[]` claim
(site `code` values), minted ONLY at sign-in from the user's nullable
`User.siteScopeJson` column (additive migration
`20261003024531_add_user_site_scope`) by the credentials `authorize` path
(`src/lib/auth/options.ts`). Enforcement is centralized in
`src/lib/auth/scope.ts` (pure helpers: `sessionSiteScope`, `assertSiteScope`,
`scopedDeviceWhere`, `userSiteScopeClaim`) plus the
requirePermission-family extensions in `src/lib/auth/session.ts`
(`sessionScopeFor`, `requireSiteScope`).

**Wildcard default (the parity guarantee).** ABSENT claim = wildcard =
every site. Every session minted before F-031 — and every user whose scope
was never set (a null column mints no claim) — resolves wildcard, so
pre-F-031 behavior is byte-unchanged. A `null` claim value is treated the
same as absent.

**Fail-closed rules (the only two narrow states).**

- `sites: []` (empty array) → deny-all: no site matches.
- MALFORMED claim (present but not an array of non-empty strings —
  classified at enforcement by `sessionSiteScope`, at mint by
  `userSiteScopeClaim` for a hand-edited `siteScopeJson` row) → deny-all
  with a console.warn log line. A malformed scope can never widen access;
  treating it as wildcard is forbidden.

**Unscoped resources.** `assertSiteScope(session, null)` BYPASSES site
scoping: a resource with no site dimension is global (the documented rule).
Row-level parity note: a DEVICE whose `siteId` is unset (nullable column,
`SetNull` on site delete) can never match the `site.code IN (…)` filter, so
sites-limited sessions do not see it (wildcard sessions do). Devices
normally always carry a site — this edge is safety-only.

**Reference migration (wired today).** `GET /api/v1/devices` composes its
where clause through `scopedDeviceWhere(sessionScopeFor(req), baseWhere)`
and `GET /api/v1/devices/[id]` answers through the row-level predicate
`sessionAllowsSite` — the exact semantics of the list filter, so a device
hidden from the list cannot leak through the detail route. Detail reads use
404-NOT-403: an out-of-scope device returns the SAME `DEVICE_NOT_FOUND`
envelope a wildcard session gets for a missing device (a 403 would confirm
existence).

**Scope administration.** `PATCH /api/v1/admin/users/[id]` accepts
`siteScope: string[] | null` (admin-only; ≤ 32 codes, each ≤ 32 chars,
pattern-validated, trimmed and deduped; `null` = wildcard reset), audited
as dedicated `USER_SCOPE_SET` / `USER_SCOPE_CLEARED` rows. EFFECT TIMING
(honest): the JWT is minted at login, so a scope change lands on the
user's NEXT sign-in — the session-refresh callback deliberately does not
re-read the claim; there is no live token revocation.

**Plane boundaries (honest).** Site-scope claims apply to HUMAN session
JWTs only. API-client opaque-bearer principals and machine service JWTs
remain unscoped (global) — their scope model is future work. `sites` is a
SITE-code dimension only; device-group scoping does not exist yet.

**Migration note (next signal).** The remaining `/api/v1` routes still
trust their role gate alone. When multi-site customers actually arrive,
migrate routes per domain with the same two primitives — list routes:
`scopedDeviceWhere(scopeClaims, baseWhere)`; detail/singleton reads: the
`sessionAllowsSite` row predicate with 404-not-403 semantics; mutation
routes may prefer `requireSiteScope(req, siteCode)` (403
`SITE_SCOPE_FORBIDDEN`). The devices routes are the reference. The sites
catalog (`GET /api/v1/sites`) stays global until a consumer needs it
filtered.

### 5.2 CSRF origin control on cookie-session mutations (RT-008 / F-010)

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
