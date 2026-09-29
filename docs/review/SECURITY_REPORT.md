# Security Report — FayaNMS (branch `GLM/full-audit-and-fix`)

Base: `main @ 38fbdfb` · Findings register: [`FINDINGS.md`](./FINDINGS.md) · Module notes: `docs/review/notes/A1..A5`. This report is defensive: it describes posture and hardening gaps only. It contains no secrets and no exploit instructions.

## Executive summary

The security posture of FayaNMS at base `38fbdfb` is **strong for its class** (multi-protocol NMS with a device-facing worker trust boundary), with **no P0 findings and no exploitable auth bypass identified** in ~148 API routes, the worker, the data layer, or the deploy stack. All 66 deduplicated findings are P1–P3; the seven P1s are resilience/data-integrity and configuration-scoping issues (alert lifecycle bug, half-built rollup pipeline, unbounded ingest queue retention, missing frontend error boundaries, two i18n systemic gaps, one compose env-scoping leak) rather than open doors.

The core trust boundaries hold: browser↔Next (session cookie + contract-tested mutation RBAC), worker↔Next (Ed25519/HS256 service JWTs with audience/issuer/expiry/scope), device↔worker (fail-closed host-key pinning, credential-free first contact, bounded outputs, plan-tokenized changes), ingest↔internet (rate gates, HMAC, SNMPv3 replay gating). The residual risk concentrates in **defense-in-depth** (single-proxy-gate reads, no app-layer security headers, no server-side CSRF check), **default-open opt-in endpoints** (`/api/metrics` token optional at three planes), and **operational blast radius** (monolithic OCI compose env file).

## Verified strengths (from the module audits)

- **Fail-closed startup:** security policy refuses known-bad configuration, enforces postgres-only URLs, blocks demo mode in production boot (`src/lib/startup/security-policy.ts`; A1/A3 clean lists).
- **Hash-chained audit trail with fork protection:** `AuditEvent` hash chain with DB-level `@@unique([prevHash])` fork protection; mutations audited; verify tooling (with the scope caveat F-015). Gaps found are bypass *edges* (F-014 bulk `createMany`), not design flaws.
- **Ed25519 machine plane:** service JWTs pinned to `HS256|EdDSA`, configured trust plane (no `alg` confusion), audience/issuer allowlists, ±30 s skew, timing-safe HMAC compares, Ed25519-only keys, fail-tight on malformed key material; all worker/ingest routes enforce per-route scopes (A1 positive verifications).
- **Credential-free first contact:** SSH host-key capture happens before any credential use and aborts during KEX on mismatch; unpinned live connections refused; pins fail closed (SAFE-001, A2).
- **SNMPv3 replay gating:** traps verified (HMAC with `timingSafeEqual`, authPriv decrypt) with boots/time monotonic rejection and a conditional-update race guard (A2).
- **secretRef payloads:** secrets cross every boundary as vault references — worker resolves them worker-side; claim enrichment carries `secretRef` only; webhook secrets encrypted at rest + AAD-bound; snapshots AES-256-GCM with per-row DEK; credentials/API-client routes return vault pointers or prefix-only tokens; vault never logs secret values (A1/A2/A3).
- **SSRF guard:** webhook/notification egress behind a two-plane guard (admission + per-resolved-address delivery recheck, redirects refused); probe targets are DB-sourced; `mgmtIp` IPv4-literal-validated (A1/A2).
- **Also clean:** mutation RBAC enforced handler-level and contract-tested; pre-handler rate gate with rightmost-trusted-hop XFF; HMAC-keyed login brute-force guard; uniform login failure (no enumeration); parameterized SQL only; no fs/path traversal surface; CSV RFC-4180 escaping; digest-pinned non-root distroless containers; SHA-pinned CI actions with checksum-verified downloaded binaries; fail-closed deploy/backup/rollback/restore-drill scripts; committed-secret sweep clean (only an allowlisted loopback test fixture).

## Findings by theme (F-IDs per FINDINGS.md)

### Authentication & session
- F-034 (P3): single-factor auth, no TOTP/WebAuthn, password policy = length ≥ 8.
- F-032 (P3): rate/login budgets are per-process by default; scale-out multiplies budgets.
- F-019 (P2, UX overlap): sign-in gate hardcoded English incl. error copy (localization gap, not auth weakness).

### Authorization & defense-in-depth
- F-008 (P2): ≈35 read-plane GETs have no handler-level authn — the proxy matcher is the sole gate (single point of failure).
- F-033 (P3): `/worker/status` accepts any-scope service JWT; matrix says human-session-only.
- F-029 (P3): `/admin/users` GET lists all emails to any active user.
- F-031 (P3): permissions are global per role; no site/device-group scoping (single-tenant by design, documented).

### CSRF, headers & browser-plane
- F-010 (P2): no server-side Origin/Sec-Fetch-Site/CSRF-token validation on cookie-session mutations (SameSite=Lax is the only control).
- F-009 (P2): no app-layer security headers (CSP/HSTS/nosniff/frame-ancestors/Referrer-Policy) — optional TLS Caddy profile only.
- F-056 (P3): sole `dangerouslySetInnerHTML` sink is dev-defined chart config (no current injection path; guard suggested).

### Information disclosure & pre-auth surface
- F-027 / F-040 / F-061 (P3): the optional metrics-token condition at three planes (app route default-open; worker route default-open + non-timing-safe compare; TLS edge profile missing the 404 block).
- F-028 (P3): pre-auth `/meta` exposes credential-profile names/types, vendors, full site inventory.
- F-035 (P3): unauthenticated "Hello, world!" stub route.
- F-043 (P3): worker error messages leak internals (vault paths, DNS codes, device output excerpts) to control-plane callers; unbounded `worker.log`.

### Worker / protocol plane
- F-011 (P2): WebAPI transport accumulates device responses unbounded (OOM class).
- F-012 (P2): timed-out jobs keep running and can double-report terminal states.
- F-036 (P3): UDP hostname field can spoof device attribution (contradicts the stated invariant).
- F-037 (P3): unauthenticated UDP flood amplifies into authenticated app round-trips + per-packet vault resolution.
- F-038 (P3): discovery CIDR policy accepts governed address classes the SSH dial plane refuses.
- F-039 (P3): concurrent host-key enrollment captures can cross (global slot).
- F-040 (P3): HS256 legacy plane still accepted (documented Phase 2 pending); 401/403 semantics; no `jti` replay tracking.
- F-041/F-042 (P3): CLI session scan desync on >64 KiB output; soft per-stream output bound (one-chunk overshoot).
- F-044 (P3): change-job timeout budget vs step math can mislabel slow-but-healthy changes FAILED.

### Data integrity & audit chain
- F-014 (P2): `auditEvent.createMany` bypasses hash stamping (unhashed bulk rows).
- F-015 (P2): chain verification walks only the oldest 5,000 rows — tail never verified.
- F-013 (P2): snapshot retention cascade-deletes OPEN drift records / baseline history.
- F-016/F-051/F-052 (P3): max+1 sequence races (incident/change numbers, snapshot versions, tick enqueue).
- F-003 (P1): ProtocolEventQueue + mirrored audit rows grow without bound (retention gap).
- F-048 (P3): ingest retries duplicate FlowRecords (no idempotency key).

### Deploy, CI/CD & operations
- F-007 (P1): OCI compose monolithic `env_file: .env` leaks KEK/session secret/DB password into worker/postgres/caddy containers (violates the repo's own SEC-ENV-001 zone split).
- F-024 (P2): container images are pushed to GHCR before the HIGH/CRITICAL Trivy gate runs.
- F-025 (P2): the repo's own governance gate cannot pass on the branch protection actually applied; required-check contract unsatisfiable while container.yml is disabled.
- F-026 (P2): published client bundles freeze a non-routable build-time origin.
- F-023/F-060/F-066 (P3): worker Prometheus target permanently 404s; zero alert rules shipped; Prometheus lifecycle API enabled unauthenticated on the internal network.
- F-059 (P3): app health probes hit the root page, not a DB/auth readiness endpoint.
- F-058 (P3): Caddy file-log path unmounted (logs lost / likely provision error).
- F-062 (P3): plaintext full-DB dump window during backup (default umask).
- F-063 (P3): restore-drill DB URL visible in argv/`ps`.
- F-064/F-065 (P3): stale CI governance header; no Dependabot github-actions ecosystem (pinned SHAs rot).

### Availability & data growth (operational security)
- F-001 (P1): root-suppressed alerts never re-activate → silent monitoring blind spot.
- F-002 (P1): rollup pipeline has no runtime producer (monitoring/reporting reads stale demo data).
- F-004 (P1): any view crash kills the whole shell (no error boundary).
- F-017/F-018/F-046/F-047/F-049/F-050 (P2/P3): unchunked prunes, hot-loop queries, missing indexes, unbounded ops tables.

## Methodology

- Five parallel read-only module audits (A1 auth/API over all 148 route files + proxy + auth libs; A2 protocol engines/worker; A3 Prisma schema/data services; A4 frontend/i18n/a11y; A5 ops/CI/deploy), each producing evidence-quoted findings re-verified against the working tree; grep-verified headline claims (e.g., zero `protocolEventQueue.deleteMany`, zero runtime `metricRollup` writers, zero Origin checks).
- Baseline re-run in-sandbox: lint PASS, `tsc --noEmit` PASS, 1340 tests pass / 18 skip / 2 environment-dependent fails (missing local `sshd`, reproducible on `main`), `build:gate` PASS.
- Findings deduplicated into FINDINGS.md (one documented merge: A2-03 + A3-03 → F-003).
- Committed-secret sweep repo-wide (gitleaks allowlists respected); no live credentials found; none reproduced here.

## Limitations

- No PostgreSQL, no sudo, no Docker in the sandbox: no live post-auth runtime testing, no container runtime checks, no SNMP/SSH lab against real devices. Runtime behaviors marked **Unverified** in FINDINGS.md (e.g., F-012 app-side guard, F-044, F-052, F-058) rest on code shape only.
- GitHub-side org/repo settings (branch protection, workflow enablement) verified via recorded API reads from earlier tasks, not re-read during this phase.
- Dependency-advisory scanning could not be executed in-sandbox (see DEPENDENCY_REPORT.md); CI's own osv-scanner/Trivy gates (checksum-verified, `--redact`) are the standing advisory control and were green at base.
- Static analysis cannot prove the absence of vulnerabilities; findings are defect-anchored to file:line evidence, not heuristic scores.
