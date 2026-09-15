# FayaNMS — Independent Audit of Current `main` (verification of the 2026-09-15 Superpowers audit)

**Repository:** `fayafatehi/FayaNMS`
**Branch:** `main`
**Audited HEAD:** `b9d3d50be0320addd2f3b35d3e78d3bfc679c7c1` (clean tree — zero uncommitted changes)
**Audit date:** 2026-09-15 (Asia/Riyadh)
**Method:** This review treats `FayaNMS-Superpowers-Independent-Audit-2026-09-15.md` as INPUT, NOT TRUTH. Every material claim was re-derived from the current repository and live GitHub APIs, and — unlike the supplied audit, which could not execute anything — **every locally executable verification gate was personally executed on the exact release SHA**. Prior audit/worklog claims were used only as leads.
**Delta vs the supplied audit:** none — the supplied audit audited exactly this HEAD; nothing changed since. All verdicts below are therefore direct re-verifications, freshly evidenced.

---

## 1. Executive summary

**Production-readiness score: 79 / 100 — BLOCKED for an unrestricted production release.**

The supplied audit is **accurate**: all 11 findings (2 × P0, 5 × P1, 3 × P2, 1 × P2-doc) reproduce against current `main` with concrete evidence. None is overstated; none is stale. Two of them (GOV-001 branch protection, CI-001 CI evidence) are the release blockers, and both live **outside the code** — settings-side and infrastructure-side respectively.

The genuinely new evidence this review adds: the complete local gate suite — lint, full typecheck, **419/419 tests (2,401 expects)**, six-flavor live-plane protocol certification (`certify.ts` exit 0), Prisma validate, migration deploy, migrations≡schema drift guard (exit 0), and the production build gate — **all pass on the exact release SHA**. The "regressions may have escaped untested code" risk that CI-001 represents is therefore materially contained: the release candidate is locally gate-proven; what is missing is the *independent, CI-produced* proof, which is an infrastructure problem (GitHub-hosted runner unavailability), not a code problem.

Recommended production position is unchanged and correct: **controlled pilot / pre-production**, not unrestricted network-change authority.

---

## 2. Repository fingerprint

| Field | Value |
|---|---|
| HEAD | `b9d3d50be0320addd2f3b35d3e78d3bfc679c7c1` |
| Branch / tree | `main`, clean (0 modified files) |
| Recent commits | `b9d3d50` (R33 CI addendum), `cbe2f58` (P2-1/P2-3/P1-019 config hygiene), `88f00ab`, `deb192d` (CERT-006), `32991ce`, `e114e2a` (P1-007), `f96e7c8`, `96944f1` (P1-005), `1adc870`, `613dee6` (P1-012), `76bb398` (P1-011), `cc3996b` (P1-010) |
| Runtime | Bun 1.3.14 (pinned in CI), Node API surface via Bun |
| Framework | Next.js 16.3.4 (App Router), TypeScript 5 |
| Database | PostgreSQL (compose `postgres:16-alpine`; Prisma 6 with committed `prisma/migrations` history) |
| Major services | Next.js app (port 3000, published as 80), worker (3030, never published), one-off `provision`, PostgreSQL |
| Deployment model | Single-host Docker Compose behind an external TLS proxy (runbook D2) |
| Worker architecture | Poll-based job engine (`claim/complete/progress`), service-JWT authenticated (HS256 or Ed25519), device credentials resolved worker-side from the vault |
| Supported vendors | cisco-ios, fortinet-fortios, hpe-aos-cx, juniper-junos, palo-panos (SSH exec) + sophos (SFOS WebAPI over TLS) |
| Transports | SIMULATOR (default), LIVE_SSH (read-only backup/probe + plan-validated controlled change), LIVE_WEBAPI (sophos, read-only) |
| Simulator vs real | All six vendors protocol-certified against in-repo harnesses; **no physical-hardware certification exists**; live restore is refused by design (`LIVE_RESTORE_NOT_CERTIFIED`) |

---

## 3. Verification matrix — every finding of the supplied audit

| ID | Sev | Status | File(s) | Evidence (current implementation) | Required action | Tests |
|---|---|---|---|---|---|---|
| GOV-001 | P0 | **CONFIRMED** | live GitHub API; `.github/workflows/ci.yml` L5–6 | API read-back 2026-09-15: `branches/main → protected:false`, `protection.enabled:false`, required checks `enforcement_level:off`, zero contexts. `ci.yml` header still asserts "Branch protection: active — PRs require 1 approval incl. CODEOWNERS review". | Enable ruleset/branch protection with required `gate`+`scan`; align the workflow header with live truth. | None possible client-side; add a governance verification job per supplied audit. |
| CI-001 | P0 | **CONFIRMED** (infra) | Actions API | Run 34910745679 on HEAD `b9d3d50`: `gate` "failure" with **0 steps executed, no runner assigned**; `scan` skipped. Latest successful run: 34790383489 at `5cc0a5f` (2026-09-13) — 12+ security-relevant commits behind. Runs #34–#47 share the identical zero-runner signature; workflow unchanged since green #28–#33. **New evidence:** every local gate equivalent passes on HEAD (§5), so the candidate is locally proven; independent CI proof remains required for release. | Restore runner capacity/minutes; re-run `gate`+`scan` on current HEAD from the UI; do not release until green. | Local equivalents executed — see §5. |
| SEC-ENV-001 | P1 | **CONFIRMED** | `compose.yml` L65/L97/L123; `docs/deploy/env.production.example` L9–11, L36–43, L81–90 | All three services (`app`, `worker`, `provision`) receive the identical `env_file: .env.production`. The template self-describes as "double duty" and carries `FAYANMS_VAULT_*` device credentials in the same file as `NEXTAUTH_SECRET`, `FAYANMS_CONFIG_ENC_KEY`, `POSTGRES_PASSWORD`. Worker receives DB/session/KEK material it never touches; app receives device vault material it never resolves. | Split per-service env sets (app.env / worker.env / provision.env) or use compose secrets; enforce with a config-drift test. | None today; add a compose/template consistency test. |
| AUTH-001 | P1 | **CONFIRMED** | `src/proxy.ts` L46–47, L125–129; `src/lib/auth/options.ts` L52+ | Proxy matcher is `["/api/v1/:path*"]` and its comment states `/api/auth/*` "never touched". `authorize()` performs credential verification with no throttling, backoff, lockout, or shared attempt store (zero matches for `lockout`/`backoff`/`attempt` in `src/lib/auth/`). Online guessing is bounded only by network-level controls. | Pre-auth limiter keyed by IP+account, lockout/backoff, sign-in audit events, trusted-proxy-aware identity. | No negative tests exist; add per the roadmap. |
| SVC-001 | P1 | **CONFIRMED** | `src/lib/startup/security-policy.ts` L97–108; `docs/deploy/env.production.example` L17 | Production startup unconditionally requires `FAYANMS_SERVICE_SECRET` (missing → violation → refuse to start); the template marks it "required". The P1-007 EdDSA plane exists (verifier accepts Ed25519 public-key sets) but **an EdDSA-only production deployment cannot boot**: removing the shared secret trips the startup policy. Phase 2 of the documented rotation is unreachable in production today. | Policy: require at least one valid trust plane (shared secret OR Ed25519 keys per role); validate key material at startup; update template/runbook. | `tests/auth/service-identity.test.ts` covers JWT semantics, not startup policy; add policy tests. |
| SCALE-001 | P1 | **CONFIRMED** | `src/lib/api/rate-gate.ts` L36, L53 | `const rateBuckets = new Map<string, number[]>()` — process-local; L36 documents the limitation. Adequate for the documented single-host shape; not a fleet quota. | Shared store (Redis/Postgres) with atomic ops when multi-instance. | Existing rate-gate tests cover single-process semantics. |
| FUNC-001 | P1 (product) | **CONFIRMED (by design)** | `src/lib/change/restore-op.ts` (typed `RESTORE_TARGET_*` refusals); `live-plan.ts` (`LIVE_RESTORE_NOT_CERTIFIED`) | Snapshot-exact restore is implemented and certified for the SIMULATOR plane only (sha pre-commit, commit echo, VALIDATE re-assert); LIVE restore is refused typed, honestly documented in README + deploy note. This is a product gap, not a hidden defect. | Vendor-safe live restore strategies + hardware certification before enabling, per roadmap Phase 3. | Simulator restore certified (`tests/audit/restore-op.test.ts`, `live-restore-guard.test.ts`). |
| TEST-001 | P1 | **CONFIRMED** | `.github/workflows/ci.yml` | No Playwright/browser/multi-container integration steps exist (zero matches for `playwright|browser|e2e` beyond a comment). Protocol certification uses in-repo harness personas (`certify.ts`, exit 0, six flavors). | Add automated browser journeys + multi-container integration; hardware matrix (Gate D/E). | 419 unit/contract/audit tests + protocol certification exist. |
| DEPLOY-001 | P2 | **CONFIRMED** | `compose.yml` L77–82; `docs/deploy/env.production.example` L28–34 | App publishes `"${FAYANMS_HTTP_PORT:-80}:3000"` — plain HTTP by default; TLS termination is external (runbook D2); the template's example origin is `http://fayanms.example.corp`. Misdeployment exposes sessions over HTTP. | Reference TLS proxy profile or HTTPS-required startup policy/HSTS guidance. | None. |
| SUPPLY-001 | P2 | **CONFIRMED** | `Dockerfile` L26/32/43, `Dockerfile.worker` L18, `compose.yml` L36, `.github/workflows/ci.yml` L293–297 | Base images are tag-pinned (`oven/bun:1.3.14`, `oven/bun:1.3.14-slim`, `postgres:16-alpine`), not digest-pinned; Trivy runs `scan-type: fs` (filesystem) — built images are never scanned. | Digest-pin bases; build+scan images in CI; image SBOM/provenance/signing. | None. |
| DOC-001 | P2 | **CONFIRMED** | `ci.yml` L5–6; `docs/deploy/env.production.example` L17; `README.md` (P1-017 banner) | `ci.yml` claims protection active vs live `protected:false` (GOV-001 doc half). Template says `FAYANMS_SERVICE_SECRET` "required" while the EdDSA design makes it removable (SVC-001 doc half). README carries the truthful corrected banner — the drift is localized to the workflow header and template. | Make live policy truth authoritative; drift-check docs against GitHub settings. | Brand honesty tests pin some doc claims; extend to the workflow header. |

**Summary: 11/11 CONFIRMED — 0 FIXED, 0 PARTIAL, 0 REGRESSED, 0 NOT REPRODUCIBLE, 0 OUTDATED.**

---

## 4. Security assessment (adversarial, per prompt §6)

**Authentication.** NextAuth v4 credentials; DB-backed users; session revalidation against active users; sign-in audit events exist. Gaps: `/api/auth/*` is outside every application rate control and `authorize()` has no throttling/lockout (AUTH-001); cookie `maxAge` 30 days is long for an admin plane (P3 observation). Secure-cookie behavior depends on the HTTPS posture — reinforcing DEPLOY-001.

**Authorization.** Route-level enforcement is swept and strong: 49 route files call `requirePermission`, 13 `requireRole`, 13 `resolveAdminActor` (127 route files total; the remainder are `_lib`, read-only meta/bootstrap, and worker routes gated by service-JWT verification). The Phase 19-C sweep removed synthesized admin identities; approval-level entitlements, SoD, and two-person CAB quorum (POL-001) are enforced server-side; P1-012 made API-client bearer auth fail-closed with scoped permissions; machine principals cannot decide approvals.

**Service-to-service auth.** Ed25519/EdDSA mint+verify is implemented and tested (24-pin suite), HS256 coexists for Phase-1 rotation, issuer allowlist + scope enforcement present, algorithm-confusion refusals tested. **The deployment-consistency defect is real (SVC-001):** the startup policy still mandates the symmetric secret, so the documented EdDSA-only end state cannot boot in production.

**Secret management.** Ownership (current, single-file topology):

| Secret | App | Worker | Provision | DB | Browser |
|---|---|---|---|---|---|
| NEXTAUTH_SECRET | ✔ (needed) | ✔ *(not needed — SEC-ENV-001)* | ✔ *(not needed)* | — | — |
| FAYANMS_CONFIG_ENC_KEY (KEK) | ✔ (needed) | ✔ *(not needed)* | ✔ *(not needed)* | — | — |
| POSTGRES_PASSWORD | ✔ (via URL) | ✔ *(not needed)* | ✔ (needed) | ✔ | — |
| FAYANMS_SERVICE_SECRET(S) | ✔ | ✔ | ✔ *(not needed)* | — | — |
| FAYANMS_SERVICE_PRIVATE_KEY | ✔ | ✔ | ✖ | — | — |
| FAYANMS_SERVICE_PUBLIC_KEYS | ✔ | ✔ | ✖ | — | — |
| FAYANMS_VAULT_* (device creds) | ✔ *(not needed — SEC-ENV-001)* | ✔ (needed) | ✔ *(not needed)* | — | — |
| Webhook signing secrets | ✔ (KEK-encrypted at rest; plaintext shown once) | — | — | (enc) | — |

All compose services receive every row (SEC-ENV-001). KEK handling is fail-closed (AES-256-GCM, AAD row-binding, keyId envelopes, `enc1:` format; snapshot + webhook-secret migration tools exist). No fail-open crypto found: decrypt failures throw typed errors, startup refuses insecure config, the audit chain verifies `FULLY/PARTIALLY/INVALID`.

**SSRF.** Two-plane guard verified in source: admission classifier (scheme/userinfo/loopback/RFC1918/link-local/metadata, IPv6 incl. mapped/NAT64/ULA, encoded IP literal forms) + delivery-time DNS re-check of every resolved address + `redirect: "error"`. Residual TOCTOU window honestly documented in `ssrf-guard.ts`; closing it fully requires connection pinning (P3 backlog).

**Cryptography.** See above; audit hash chain has DB-level fork prevention (`@@unique(prevHash)`) with retry convergence; drift-guarded migrations verified this session (exit 0).

---

## 5. Verification gates — personally executed on HEAD `b9d3d50`

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` (app + worker) | OK (frozen, no drift) |
| `bun run lint` | exit 0 |
| `bunx tsc --noEmit` (full, unfiltered) | exit 0 |
| `bun test tests/` | **419 pass / 0 fail, 2,401 expects, 25 files** |
| `bun mini-services/worker/certify.ts` | exit 0 — LIVE_SSH (5 flavors) + sophos WebAPI protocol certification |
| `bunx prisma validate` | OK |
| `bunx prisma migrate deploy` (local PostgreSQL 16) | OK — no pending migrations |
| Drift guard (`migrate diff --exit-code` vs shadow DB) | exit 0 — history ≡ schema |
| `bun run build:gate` (production build) | exit 0 |
| New-problem sweeps | TODO/FIXME in src+worker: **0**; no empty-catch fail-open patterns surfaced in security paths; no hardcoded secrets surfaced (gitleaks not runnable — below) |
| Docker build / Compose startup / healthchecks | **NOT VERIFIED — infrastructure limitation** (no Docker in this environment) |
| Trivy / OSV / Semgrep / gitleaks binaries | **NOT VERIFIED — infrastructure limitation** (not installed; CI runs them when a runner is available) |
| Playwright / browser E2E | **NOT VERIFIED — none exist to run** (TEST-001) |
| Real hardware certification | **NOT VERIFIED — no devices** (Gate D open) |

---

## 6. Score (independent, per prompt §26 weights)

| Dimension | Weight | Score | Weighted | Basis |
|---|---:|---:|---:|---|
| Architecture | 10 | 90 | 9.00 | Strong two-process boundary, typed contracts; flat env secret injection is the main deduction |
| Functional completeness | 10 | 82 | 8.20 | Broad operational product (43 views, incidents/alerts/reports/jobs/integrations); live restore intentionally unsupported |
| Change/config safety | 15 | 88 | 13.20 | All P0 execution-safety landed and source-verified; snapshot-exact simulator restore; LIVE restore refused typed |
| Authentication/authorization | 10 | 76 | 7.60 | Swept RBAC + scoped API clients + EdDSA plane; login throttle absent; EdDSA-only cannot boot |
| Security | 15 | 78 | 11.70 | SSRF/host-keys/KEK envelopes/startup policy strong; shared env secrets, login abuse, plain-HTTP default |
| Data integrity/audit | 10 | 90 | 9.00 | Drift guard verified this session; hash chain w/ fork prevention; AAD-bound encryption |
| Testing/certification | 10 | 78 | 7.80 | 419/419 + certify exit 0 **personally run on HEAD** (new vs supplied audit); no browser/multi-container/hardware gates |
| Deployment/operations | 10 | 68 | 6.80 | Non-root users, healthchecks, migrate-deploy path; plain HTTP default, tag-pinned images, per-process limiter |
| CI/release governance | 5 | 45 | 2.25 | Current HEAD has no successful required run (infra); `main` unprotected; stale workflow header |
| UX/accessibility | 5 | 78 | 3.90 | Recorded 1920px/320px/WCAG sweeps + EN≡AR parity gate; not independently replayed in this session |
| **Total** | **100** | | **79.45 → 79** | |

**Verdict: BLOCKED for unrestricted production release** (P0: GOV-001, CI-001 — both non-code). Controlled pilot/pre-production with the documented compensating controls is defensible today.

---

## 7. New findings (this review; none rise to P0/P1)

| ID | Sev | Finding | Action |
|---|---|---|---|
| NEW-1 | P3 | `/api/v1/meta` and `/api/v1/auth/*` are excluded from the rate gate (`src/proxy.ts` L125–126). Currently read-only/bootstrap, but any future side-effectful route added under `/api/v1/auth/*` would silently inherit the exemption. | Add a guard test: any `/api/v1/auth/*` route with a mutation must either opt into governance or the exclusion must be narrowed. |
| NEW-2 | P3 | `package.json` `start` pipes production stdout through `tee server.log` without rotation — log-growth hazard on long-lived hosts (compounds the P2-1 fix, which already removed query noise). | Reference log-rotation (logrotate/Docker json-file limits — compose already sets json-file limits for services; align bare-metal runbook). |
| NEW-3 | P3 | NextAuth session `maxAge` 30 days for an administrative plane. | Consider 8–12 h sliding sessions or re-auth for approval/execute actions (policy decision; document trade-off). |
| NEW-4 | P3 | SSRF delivery-time re-check retains a theoretical TOCTOU window (documented in `ssrf-guard.ts`); full closure needs connection pinning to the validated address. | Custom dispatcher/agent pinning when the egress model is next touched. |

No new P0/P1 defects were found in the high-risk paths re-inspected (authn/authz sweep counts, crypto, SSRF, SSH/WebAPI transports, restore chain, execution guards, Prisma schema/migrations, CI workflow, Dockerfiles, compose).

---

## 8. CI state and GitHub governance (live, 2026-09-15)

- Branch protection: `main.protected=false`, `enforcement_level:off`, zero required checks (API read-back) — GOV-001.
- Actions: HEAD run `34910745679` failed with zero executed steps and no runner assigned; `scan` skipped. Twelve most recent runs (one per push since `cc3996b`) share the identical zero-runner signature. Latest success: `5cc0a5f`, 2026-09-13. Workflow file unchanged since green runs #28–#33 → infrastructure (runner availability/minutes), not code.
- This review re-affirms the honest posture recorded per-commit in `worklog.md`: local gates green on every pushed SHA; independent CI evidence pending runner restoration.

---

## 9. Prioritized remediation (summary — full detail in the roadmap doc)

1. **Gate A (P0, user-side):** protect `main` + restore runner capacity + green `gate`+`scan` on the release SHA. No code required.
2. **Gate B (P1, code):** per-service env split; login throttle/lockout; EdDSA-only startup policy.
3. **Gate C (P1/P2, code+ops):** shared rate store; compose hardening (resource limits, `no-new-privileges`, read-only where practical); HTTPS-by-default reference profile.
4. **Gate D (hardware):** vendor certification matrix on real/virtual appliances.
5. **Gate E:** Playwright journeys, image digest pinning + built-image scanning, DR exercise.

## 10. Production acceptance gate

A release may be called production-ready when: release SHA has green required CI + scan; live GitHub reports `main` protected; secrets compartmentalized per service; EdDSA-only deployable and tested; login abuse bounded; fleet-wide limiter for multi-instance; DB backup/restore drill passed; per-vendor live certification published; live restore certified or removed from claims; images digest-pinned and scanned; HTTPS mandatory and reproducible; browser journeys + a11y checks continuous. Today: **0 of 12 fully satisfied** (several partially — see roadmap).

## 11. Limitations

- Docker, Compose, Trivy/OSV/Semgrep/gitleaks, Playwright and real hardware could not be executed here (recorded `NOT VERIFIED — infrastructure limitation` above).
- The worker review re-verified the load-bearing paths (transports, auth, vault, change/restore planes, guards) rather than asserting line-by-line coverage of every file.
- UX was assessed from recorded sweeps, source, and the i18n parity gate; no live browser session was driven in this audit.

---

*Independent review — 2026-09-15. Reviewer: FayaNMS engineering (verification pass per the Independent Audit Review Agent Prompt). Source was not modified for this review; deliverable documents only.*
