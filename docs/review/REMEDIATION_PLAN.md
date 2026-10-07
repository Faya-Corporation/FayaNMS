# REMEDIATION PLAN — FayaNMS GA program (2026-10-06 re-audit)

Input: the 2026-10-06 full re-audit (`docs/review/STATE.md` carries the verified finding register).
Ordering follows the mission priority: P0 blockers → site-scope/tenancy → API-client expiry/scoping →
report scoping → `/sites` → backup-policy cross-site → collector/DLQ hardening → staging/release/DR → remaining P2/P3.
The audit's own wave order (GA-01 authorization first) is preserved inside that priority.

Rules of engagement (unchanged for every wave):
inspect first → write/adjust tests → implement → lint + tsc + targeted suites (+ full sweep before ship) →
update progress docs → Conventional Commit → PR → CI → merge per precedent → post-merge live probes.
Never weaken/skip/delete tests or gates. Never fabricate evidence; external blockers are labeled `BLOCKED — EXTERNAL`.

## Wave GA-1 — tenancy completion I: `/sites` + backup-policy actuation (no schema change)

| Item | Finding | Fix shape |
|---|---|---|
| 1 | P1-A02 `/sites` global | Filter site rows by the session's site scope (`sessionScopeFor` + `sessionAllowsSite`); aggregate counts intersect the same scope; wildcard sessions keep the global view byte-for-byte. |
| 2 | P1-A03 backup-policy POST | For non-wildcard sessions: every `scope.siteCodes` entry must be in the session's allowed codes; `*` → 403 SITE_SCOPE_FORBIDDEN. Wildcard sessions unchanged. |
| 3 | P1-A03 backup-policy PATCH | Same rule on the PATCH handler (`[id]/route.ts`), applied to the EFFECTIVE scope (existing row merged with the patch). |
| 4 | Tests | New suite: sites filtering (site-limited vs wildcard), backup-policy POST/PATCH subset enforcement + `*` refusal + audit rows. Run all touched pre-existing suites. |

## Wave GA-2 — tenancy completion II: report data scoping + notification receipts (schema change)

| Item | Finding | Fix shape |
|---|---|---|
| 1 | P1-A01 scope model | `ReportSchedule.scopeJson` column (migration); `ReportRun`/artifact path carries the immutable effective scope. |
| 2 | P1-A01 generator | `generateReport(reportType, opts)` gains a required scope object; every fleet query (availability/backup-compliance/change/incident/capacity) intersects it via the scope helpers. |
| 3 | P1-A01 freeze-at-creation | `POST /reports/schedules` freezes the creating session's resolved scope into the row; `POST /reports/run` freezes the acting session's scope for the run; `/reports/execute` (worker) uses the SCHEDULE's frozen scope, never the worker's global identity. |
| 4 | P2 notification receipts | `NotificationReceipt(notificationId, userId, readAt)` migration + read route marks PER-USER receipts (broadcast read no longer global); read-state aggregation updated; stale "SQLite demo" comment removed. |
| 5 | Tests | Generator scope-intersection suite per report type; schedule freeze immutability; per-user receipt behavior; migration replay. |

## Wave GA-3 — API-client lifecycle + resource scope (schema change)

| Item | Finding | Fix shape |
|---|---|---|
| 1 | P1-A04 expiry columns | `ApiClient.expiresAt` (+ `rotatedAt`, `lastRotatedFromId` audit linkage) migration; max-lifetime policy knob (env, clamped, default 90 d) enforced at creation. |
| 2 | P1-A04 enforcement | `resolveActiveClient()` refuses expired clients centrally (typed failure); expiry/rotation/revocation audit events. |
| 3 | P1-A05 resource scope | `ApiClient.siteScopeJson` (same claim semantics as humans: null = wildcard for compat with existing rows, `[]` = deny-all); enforcement on device-scoped faces via the existing scope helpers; admin UI shows expiry warning + scope; tests for both. |

## Wave GA-4 — DLQ operator recovery + simulation honesty gating

| Item | Finding | Fix shape |
|---|---|---|
| 1 | P1-O03 DLQ surface | Dead-letter list API (reason/attempt details, bounded), requeue one/many with replay idempotency, quarantine marker, permission gate + audit trail; alert threshold wiring into the existing alert rules. |
| 2 | P0-R05/P1-O02 HA honesty | HA/failover-test + collector rebalance surfaces refuse (or label-only, feature-flagged OFF by default) when `FAYANMS_DEMO_MODE` is not true; production boot policy warning; UI labels preserved. |
| 3 | P0-R06 (phase 1) | Real collector control-plane primitives: registration + heartbeat + assignment lease epochs + fencing + failover/rebalance that actually moves ownership rows (DB-backed), replacing the static in-code fleet for assignment decisions; static simulation stays only as seed/demo data, clearly labeled. Scoped to what the sandbox can honestly verify end-to-end; anything requiring real remote collectors is documented, not simulated silently. |

## Wave GA-4b — collector REAL control plane (P0-R06/P1-O01)

| Item | Finding | Fix shape (as shipped) |
|---|---|---|
| 1 | Control-plane primitives | `src/lib/collectors/control-plane.ts`: idempotent registration (reactivation on re-register), heartbeat liveness + lease renewal + FENCING (stale-epoch / not-owner / unknown-assignment / agent-suspended, one aggregated audit row per anomalous heartbeat), deterministic reconcile (site-resident → peer-site → fallback-regional; siteless devices NEVER assigned), deterministic failover (region → site → any, capacity-first; optional suspension), lease reaper (silent-agent failover + row-level stale-lease re-targeting). Ownership mutations are conditional single-row updates (deviceId @unique is the lock; leaseEpoch is the fencing token — the User.credentialEpoch / JobExecution.attempts pattern). |
| 2 | Planes | Machine plane: `POST /api/v1/collectors/register`, `POST /api/v1/collectors/heartbeat`, `GET /api/v1/collectors/assignments` (telemetry-scoped service JWT — the same plane the real protocol relay uses). Admin plane: agents list, `[agentKey]/failover`, `assignments/reconcile`, `assignments/reap` (requireRole admin). |
| 3 | Dual-plane honesty | `distribution` + `rebalance-plan` routes serve the REAL fleet (ownership-based loads, real apply with epoch bumps, genuine planId staleness, no demo gate) when ≥1 ACTIVE agent is registered; otherwise the documented simulation is unchanged (GA-4 gate order + cooldown preserved, meta.plane="simulated"). UI honesty note swaps per plane (+1 i18n key per side, 3395). |
| 4 | Documented external | Real remote agent rollout (an agent process registering + heartbeating from outside the sandbox) is a deploy-side concern — the control plane is real and exercised end-to-end by the route-level suite; scheduled reaper execution is a deploy-side cron on `assignments/reap` (same posture as the DR backup sidecar). |

## Wave GA-5 — reporting formats

| Item | Finding | Fix shape |
|---|---|---|
| 1 | PDF/XLSX honesty | Implement REAL, dependency-free renderers (hand-rolled PDF 1.4 writer; minimal OOXML/SpreadsheetML writer) OR remove the formats. Decision recorded in-wave after inspecting artifact consumers; format-honesty comments/labels updated to match reality. |
| 2 | Tests | Byte-level artifact tests (PDF header/xref validity, XLSX zip structure), pipeline matrix for all 4 formats. |

## Wave GA-6 — release evidence, docs truth, session lifetime, DR tooling

| Item | Finding | Fix shape |
|---|---|---|
| 1 | P0-R07 | `docs/release/GA-READINESS.md` — the ONE canonical gate table (machine-verifiable rows per audit §16); refresh `docs/implementation/CURRENT-STATE.md` to current truth; fix `MATRIX.md` §4 stale GOV/CI rows. |
| 2 | P2-S01 | Absolute session lifetime: enforce a token-age cap (configurable `FAYANMS_SESSION_MAX_AGE_HOURS`, default 12, 0 = legacy off) on the session callback; documented decision note replaces the "deliberately NOT implemented" comment. |
| 3 | P0-R03 (in-repo) | WAL archiving/PITR config template + scheduled encrypted-backup sidecar in `deploy/oci/compose.yml` + drill documentation updates. Actual off-host/key custody/restore target stay `BLOCKED — EXTERNAL`. |
| 4 | P0-R01 | Dispatch `container.yml` on the post-remediation main SHA; record run IDs/digests in GA-READINESS if green. If publish fails on infra, record the run as evidence-with-blocker (never fabricated). |
| 5 | P3 | Regenerate release-evidence manifest for the final SHA; draft release notes/CHANGELOG. Tag/GA approval remains an owner decision. |

## Waves NOT executable in-repo (documented, never fabricated)

- **GA-7 vendor T3 certification** — needs real/vendor-virtual appliances (`BLOCKED — EXTERNAL`).
- **GA-8 final independent re-audit + staging burn-in (P0-R02)** — needs OCI staging secrets/host and owner sign-off.
- Monitoring alert-fire drills (P2) — depend on staging.

## Wave OPS-1 — cross-platform fresh-install operations (post-GA waves; owner-requested final wave)

| Item | Fix shape |
|---|---|
| 1 | One operator surface for every environment: `ops/ops.sh` (bash, Linux/macOS) and `ops/ops.ps1` + `ops/ops.bat` (Windows PowerShell core + cmd dispatcher) — 24-command surface (install/doctor/db:up/db:up:docker/migrate/seed/db:reset/dev/build/start/test/lint/typecheck/keys:service/health/docker:build/docker:up/docker:down/docker:logs/backup/restore-drill/release:evidence/help), parity test-pinned. |
| 2 | Windows path: embedded PostgreSQL ships Linux binaries only — `db:up` routes to `db:up:docker` (ops/docker-compose.dev.yml, SAME byte-strict postgres digest as CI + oci compose, same 127.0.0.1:5433 endpoint/URL); DR bash tooling routed through WSL/Git Bash with an honest refusal otherwise. |
| 3 | Docker path: `db:up:docker` (dev DB) + `docker:build` (local app/worker/migrator images from the repo Dockerfiles) + `docker:up/down/logs` wrapping the production-grade `deploy/oci/compose.yml` (requires the operator's SEC-ENV-001 env files — never fabricated). |
| 4 | Fresh-install dev identity: `ops/bootstrap-dev-identity.ts` generates per-install Ed25519 control+worker keypairs, NEXTAUTH secret and config-enc key ONCE into gitignored `.fayanms/dev-identity.env` (mode 600, quoted values, idempotent, never committed); `dev` wires the two-plane trust correctly (worker verifies control AND its own self-call tokens; operator-provided env always wins). |
| 5 | Guards: DATABASE_URL scheme guard (foreign schemes like an inherited SQLite `file:` URL fall back to the dev URL — same semantics as the package.json `dev` script); line-ending discipline via `.gitattributes` (`*.sh` LF, `*.bat`/`*.cmd`/`*.ps1` CRLF). |
| 6 | Tests: `tests/audit/ga9-ops-scripts.test.ts` (13 pins: file presence/executability, command-list parity sh↔ps1, dispatch coverage, help smoke, unknown-command fail-closed, bat CRLF, gitattributes eol, byte-strict digest parity across ops/oci/CI, no secrets/no absolute paths, identity-bootstrap shape+idempotency, self-call trust posture). |

## Exit criteria for this program

Every finding in the STATE register is either (a) fixed with tests at a green CI merge, (b) documented as
`BLOCKED — EXTERNAL` with the exact missing owner input, or (c) an explicitly recorded architecture/owner decision.
