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
| `/me/mfa/confirm` | POST | `admin`/`operator` ROLE gate — first valid code enables the factor and issues single-use recovery codes (plaintexts shown once) (F-034). Post-register audit wave 5: gated by `FAYANMS_MFA_MODE` like enroll; the ENABLED flip is a conditional claim (concurrent confirms cannot both win); failed code checks are audited `MFA_CONFIRM_FAILED` and feed the login guard's ACCOUNT budget (locked account → 429) |
| `/me/mfa` | DELETE | `admin`/`operator` ROLE gate — fail-tight disable: password re-entry AND current TOTP code or unused recovery code (F-034). Post-register audit wave 5: failed password re-entry / code checks are audited `MFA_DISABLE_FAILED` and feed the login guard's ACCOUNT budget (locked account → 429) — an online guessing attack can no longer ride the shared per-IP pool un-logged |
| `/admin/users` | GET | `admin`/`auditor` ROLE gate (`requireRole("admin","auditor")`) — the full email directory; other roles use `/meta/users` (local-part picker only) (F-029) |
| `/admin/users`, `/admin/users/[id]`, `/admin/users/[id]/reset-password` | POST/PATCH | `admin` ROLE gate (`requireRole("admin")`) — password SETs enforce the F-034 role-aware policy (privileged roles ≥ 12 chars, offline common-password denylist for all roles); with `FAYANMS_HIBP_MODE=enforce` a k-anonymity breach check also gates the SET (5-char SHA-1 prefix only; breached → `PASSWORD_BREACHED`, check unavailable → fail-closed `PASSWORD_BREACH_CHECK_UNAVAILABLE`; never at login) |
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
| `/worker/claim`, `/worker/complete`, `/worker/progress`, `/worker/tick`, `/worker/drift-evaluate`, `/worker/change-step`, `/worker/firmware-upgrade`, `/worker/ztp-provision`, `/worker/discovery/reconcile`, `/worker/snmpv3-poll/complete`, `/worker/protocol-events/drain` | `jobs` |
| `/alerts/evaluate` | `alerts` |
| `/reports/execute` | `reports` |
| `/metrics/retention/prune` | `metrics` (service path) OR human session with `metrics.prune` |
| `/metrics/rollup/aggregate` | `metrics` (service path) OR human session with the admin permission (requireServiceOrPermission) |
| `/protocol/queue/retention/prune` | `jobs` (service path) OR human session with `admin.system` (requireServiceOrPermission) |
| `/flows/retention/prune` | `jobs` |
| `/ingest/protocol`, `/ingest/protocol/snmpv3-profile`, `/ingest/protocol/snmpv3-profile/poll`, `/ingest/protocol/snmpv3-profile/accept` | `telemetry` |
| `/worker/status` | human session (diagnostic; deliberately not service-exempt) |

Proxy confinement (R62 P1, extended; post-register audit wave 5): a VERIFIED
service JWT passes the proxy ONLY on the machine surface — the
`/api/v1/worker/` prefix plus the exact non-worker routes above. The
pass-through list (3a) now DERIVES from the same `MACHINE_EXACT_ROUTES`
constant as the verified-token surface (step 1) — a single source of truth,
so the two can never drift. A REGISTRATION SCAN
(tests/audit/machine-surface-registration coverage inside
tests/audit/post-register-audit-fixes.test.ts) walks every handler under
src/app that authenticates a service principal and asserts its route is
covered by the machine-surface rules — a future unregistered machine route
fails the suite instead of failing production (the wave-4 lesson). Every
route in this table enforces token+scope at the
HANDLER layer (`authenticateServiceRequest` / `requireServiceOrPermission`);
the proxy merely confines the principal.

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
  treating it as wildcard is forbidden. The claim is SIZE-BOUNDED like the
  write surface: more than `SITE_SCOPE_MAX_CODES` (32) codes, or any
  member longer than `SITE_SCOPE_MAX_CODE_CHARS` (64 chars), is malformed
  too — deny-all, never truncated.

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

**Device-domain migration (site-scope waves 2 + 7, wired today).** The
migrated device-domain surface is exactly the list below — nothing more
(no claim that any sibling route is covered without being listed here):

- Core reads (wave 2): `GET /api/v1/devices` composes its where clause
  through `scopedDeviceWhere`; `GET /api/v1/devices/[id]` and the six
  sub-resource reads `GET /api/v1/devices/[id]/{alerts,audit,changes,
  incidents,interfaces,metrics}` gate through the fused row predicate
  `!device || !sessionAllowsSite(...)` — an out-of-scope device answers
  the SAME `DEVICE_NOT_FOUND` envelope a wildcard session gets for a
  missing device (404-not-403; a 403 would confirm existence). The fleet
  inventory `GET /api/v1/interfaces` composes the device relation filter
  through `scopedDeviceWhere` — out-of-scope interfaces vanish from the
  rows AND the summary block; wildcard keeps the byte-unchanged where
  shape.
- Sibling device routes (wave 7): the snapshot reads —
  `GET /api/v1/devices/[id]/snapshots` (list), `GET .../snapshots/diff`,
  `GET .../snapshots/[snapshotId]/download` — fuse the scope into the
  same DEVICE_NOT_FOUND 404; `POST .../snapshots/[snapshotId]/restore`
  answers 403 `SITE_SCOPE_FORBIDDEN`; `GET /api/v1/devices/[id]/host-key`
  is fused-404 while `POST/PUT/DELETE .../host-key` answer 403;
  `POST /api/v1/devices/[id]/snmp/poll` and
  `POST /api/v1/devices/test-connection` answer 403; and
  `POST /api/v1/devices/bulk` walks each id through the row predicate —
  an out-of-scope id lands in the `notFound` bucket (indistinguishable
  from a missing device — leak-free, no whole-request 403), in-scope ids
  process normally.
- Mutations (403 `SITE_SCOPE_FORBIDDEN`, the documented mutation contract
  — no 404 shape here): `PATCH /api/v1/devices/[id]` requires the
  device's CURRENT site in scope AND the repoint target `siteId` in scope
  (an operator cannot move an in-scope device beyond their own
  visibility), and `POST /api/v1/devices` requires the target `siteId`
  in scope (ordering: vendor 400 first, then the scope 403).
- Create surfaces (wave 7): `POST /api/v1/devices/csv-import` marks each
  row whose resolved site is out of scope failed with the route's
  existing row-error shape and a `SITE_SCOPE_FORBIDDEN` reason (valid
  rows still import; the request never aborts; wildcard sessions are
  byte-unchanged); `POST /api/v1/discovery/import` gates the target site
  through `requireSiteScope` (403) after the `SITE_NOT_FOUND` check;
  `POST /api/v1/ztp/claims` gates the claim's `siteId` the same way
  (existence 422 first, then the scope 403).
- Pins: `tests/audit/site-scope-device-domain.test.ts` +
  `tests/audit/site-scope-wave7-siblings.test.ts` (the wave-2/7 sibling
  routes, minted JWTs) and `tests/audit/site-scope-hardening.test.ts`
  (the parser length cap, requireSiteScope strictness, create surfaces,
  hostname probe).

**Read-plane migration (wave 9, wired today).** The wave-9 audit (Task 9-c)
found every derivative read plane OUTSIDE the device domain still trusting
the role gate alone — fleet-level lists that quietly defeated the wave-7
fused-404 gates. All of the following now compose the same central
primitives: scope-filtered lists (`scopedDeviceWhere` / scope-relative where
clauses), keyed singles through the row predicate with 404-not-403
semantics, and mutations through `requireSiteScope` (403
`SITE_SCOPE_FORBIDDEN`):

- Global snapshots `GET /api/v1/snapshots` (fleet-wide ConfigSnapshot
  history): the where clause composes the scope through the device
  relation, so the previously scope-blind list — including the
  `?deviceId=<out-of-scope>` bypass that reached past the per-device
  sibling's fused-404 gate — answers the SAME 200 + empty-list envelope an
  unknown id gets (no existence leak; byte-consistent empty shape). The
  `deviceId` filter is also length-bounded (max 64) now.
- Search `GET /api/v1/search`: every leg is scope-composed — the device leg
  rides `scopedDeviceWhere` (hostname/displayName/mgmtIp hits no longer leak
  cross-scope) and the incident/change legs merge the SAME codes into their
  `site` relation (a site-less row is hidden, row-level fail-closed parity).
- Topology `GET /api/v1/topology`: the device scan, the per-device discovery
  evidence (open ports, OS fingerprints) and the site/neighbor legs are
  bounded to the session's sites/devices.
- Performance (all five routes) `GET /api/v1/performance/{devices,overview,
  availability,capacity,interfaces}`: every device pool composes
  `scopedDeviceWhere`, so the caller-chosen `?siteCode=` INTERSECTS the
  session scope instead of overriding it — a sites-limited session asking
  for an out-of-scope site gets 200 with zero rows (the list empty state),
  never the unscoped set. The divergent-twins split is closed: the fleet
  `/api/v1/interfaces` list and the performance plane now share one
  contract.
- CMDB (all four routes) `cmdb/items` (list+create), `cmdb/items/[id]`,
  `cmdb/relations`, `cmdb/impact`: a CI is visible when its LINKAGE is in
  scope — the linked device's site code governs for device-linked CIs, the
  CI's own `siteId` tag for device-less ones, and a CI with NO linkage is a
  GLOBAL resource (the documented unscoped-resource rule). The same
  predicate scopes the device join, the site catalog, the KPI counts, the
  relation counts and the CMDB_* audit history (rows whose `CI-NNNNNN`
  references are out-of-scope or unresolvable drop fail-closed); the detail
  read fuses the row predicate into the SAME `CMDB_NOT_FOUND` envelope a
  wildcard session gets for a missing CI (byte-consistent 404-not-403). The
  owner fallback label is the email LOCAL-PART (R69/F-029 discipline) — a
  name-less owner no longer ships the full address.
- Dashboard `GET /api/v1/dashboard`: every device-derived leg composes the
  scope — KPI aggregates (status/compliance/lastBackup via
  `scopedDeviceWhere`; alert/drift counts via the device relation;
  incident/change counts and lists via the `site` relation), the
  utilization trend and capacity risks (bounded to the session's device
  ids). Honest residuals below.
- Baselines `GET/POST /api/v1/baselines` (+ `[id]` DELETE): the GET joins
  and the "devices without a baseline" strip are scope-bounded; the POST
  resolves the target device and then requires its site in scope — a
  sites-limited session approving a baseline on an out-of-scope device gets
  403 `SITE_SCOPE_FORBIDDEN` (existence 404 first; mutations accept
  existence confirmation, so 403-not-404 here).
- Maintenance `GET/POST /api/v1/maintenance` + `PATCH/DELETE
  /api/v1/maintenance/[id]`: a window is visible when its device's site —
  or, device-less, its site — is in scope; a fleet-wide window (no device,
  no site) is a GLOBAL resource and stays visible (it suppresses the
  session's own devices too, and leaks nothing). The KPI counters ride the
  same base where (scope-relative). Mutations gate every referenced
  device/site AND the existing window's linkage, ordered existence-400
  first, then the scope 403 (the POST /devices ordering).

Byte-consistency across the plane: on every migrated route the WILDCARD
path keeps the exact pre-wave-9 query shape (the parity guarantee), and a
deny-all scope (`sites: []`) answers empty lists / zeroed KPIs / the
linkage-less-only CMDB view rather than errors.

Pins: `tests/audit/site-scope-read-planes.test.ts` (the snapshots envelope
parity, search, performance siteCode∩scope, cmdb linkage + owner label,
baselines/maintenance 403-vs-wildcard pairs, artifactToCsv neutralization,
pagination cap) alongside the wave-2/7 suites above.

**Wave-9 read-plane hardening (same wave, pinned).** Three P3s landed with
the migration: the shared pagination schema caps `page` at 1000 (deep-
pagination abuse bound — the same shared `INVALID_QUERY` 400 envelope every
paginated route already produces); `artifactToCsv` neutralizes spreadsheet
formula prefixes (`=`, `+`, `-`, `@`, tab) with the OWASP leading-`'` guard
while plain numbers and clean cells stay byte-unchanged; and the snapshots
`deviceId` query filter is length-bounded.

**Documented scope rules and edges (honest).**

- Create edge: `POST /api/v1/devices` with an OMITTED `siteId` creates a
  site-less device that bypasses scoping per `assertSiteScope(null)` (the
  unscoped-resource rule) — it is invisible to sites-limited sessions
  (the row filter cannot match a null site) and manageable only by
  wildcard sessions. Accepted edge; in practice only wildcard operators
  reach it.
- Site-detach edge: `PATCH /api/v1/devices/[id]` with `siteId: null`
  (detach) is refused 403 for sites-limited sessions and remains a
  wildcard-session operation (the current site is in scope, but a detach
  is not an in-scope repoint).
- Matching is EXACT-CASE on `site.code` today (no canonicalization at
  the parser): a scope granted "hq-san" does not match site code
  "HQ-SAN". The admin write surface pattern-validates codes; the
  enforcement parser deliberately does not rewrite them.
- Scope is grant-by-code, not by id: renaming a site orphans every
  stored scope that named its old code (fail-closed — the orphaned codes
  match nothing), and delete-then-recreate of the same code is honored
  on the next mint.
- Bulk semantics: `POST /api/v1/devices/bulk` reports per-id outcomes —
  an out-of-scope id is reported exactly like a missing id (`notFound`
  bucket), so the response leaks nothing about out-of-scope existence.

**Remaining (honest, next signal).** The device domain AND the read/derivative
planes above are migrated. Still on the role gate alone — or deliberately
residual — is everything NOT listed above. When the next domain migrates,
use the same two primitives — list routes:
`scopedDeviceWhere(scopeClaims, baseWhere)`; detail/singleton reads: the
`sessionAllowsSite` row predicate with 404-not-403 semantics; mutation
routes may prefer `requireSiteScope(req, siteCode)` (403
`SITE_SCOPE_FORBIDDEN`). The devices routes and the wave-9 read planes are
the references. Specifically (so the boundary stays explicit):

- AI plane (`/api/v1/ai/*`) and the `GET /api/v1/ztp/claims` list: MIGRATED
  in wave 9 (same-wave fix batch landed). `ai/query` scopes every executor
  (inventory/incidents/changes/jobs/predictive/summary) via
  `scopedDeviceWhere` + site-relation legs, with the NL plan's site filter
  INTERSECTED with the session scope; `ai/assist`/`ai/rca-draft` fuse
  `sessionAllowsSite` into the context builders (`src/lib/ai/context.ts`,
  optional scopeClaims param, backward-compatible) so an out-of-scope
  device/incident answers the existing not-found envelope;
  `ai/change-draft` scopes AND caps (200) the prompt inventory and drops
  out-of-scope hostnames from `matchedDevices` exactly like unknown ones.
  `GET /api/v1/ztp/claims` scopes claims, device enrichment, the site
  catalog and the ZTP audit history to the session's sites (a claim's
  effective site = target site, else provisioned device's site;
  unresolvable → hidden; site-less claims hidden — SQL-relation parity).
  The session-read posture on the ZTP list is kept deliberately: no
  `ztp.read` permission exists in the role catalog (minting one is an
  owner decision), the route docstring documents the rationale.
- Dashboard residuals (the landed posture, stated exactly):
  `kpis.activeJobs` stays GLOBAL — JobExecution rows carry no site linkage
  and the bare count exposes no resource identity. `recentActivity` (the
  global AuditEvent stream): rows carry NO site linkage and `resourceLabel`
  is free text that frequently names out-of-scope resources (device
  hostnames from the alert/snapshot/drift/job/ZTP writers, user emails, CI
  labels) — sites-limited sessions therefore receive the stream with
  `resourceLabel` STRIPPED (actor/action/result/time survive; no
  cross-scope identity), while wildcard sessions keep the verbatim labels.
  The deep fix — a site dimension on audit rows — is a deferred owner
  decision (it needs a resourceLabel audit first).
- CMDB items with NO device/site linkage remain GLOBAL — visible to every
  session, including deny-all ones (they have no tenancy signal to scope
  by; the documented unscoped-resource edge).
- Reports: the GENERATOR is not scoped this wave — a generated report's
  CONTENTS remain fleet-wide for any principal that can read the artifact
  (GET-gating posture and content scoping are deferred owner decisions).
  The wave-9 change to the reports plane is the CSV formula-injection
  neutralization in `artifactToCsv` only.
- The sites catalog (`GET /api/v1/sites`) stays global until a consumer
  needs it filtered.

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

**Migration note (next signal).** See the "Remaining" paragraph above: the
device domain, the wave-9 read/derivative planes, the AI plane and the
`ztp/claims` list GET are the migrated references; everything else (reports
content scoping, the sites catalog) migrates on demand with the same two
primitives.

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
