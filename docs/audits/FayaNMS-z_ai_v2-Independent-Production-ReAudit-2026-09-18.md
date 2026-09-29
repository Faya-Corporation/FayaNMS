# FayaNMS — z_ai_v2 Independent Production Re-Audit

**Repository:** `Faya-Corporation/FayaNMS`
**Branch:** `z_ai_v2` (audit STARTED at `f813d7a`, remediation LANDED on top of it — see §7)
**Audit date:** 2026-09-18 (Asia/Riyadh)
**Method:** Independent re-derivation, not attestation. Every material claim of the R50.0–R50.8 program was re-verified against the exact tree by two parallel read-only audit passes (security plane; supply-chain/docs-honesty plane) plus a personally executed gate battery and a live browser session. Prior worklog/audit claims were used ONLY as leads; each control below carries fresh file:line evidence. All locally executable gates were executed on the exact audited SHA.
**Delta vs prior state:** the audit found 2 code-level findings (1 × P2, 1 × P3) and 3 hygiene/doc findings (1 × LOW-docs, 2 × INFO-class) — ALL remediated in this same increment (R51-A1/A2/D1/D2/D3) with machine-pinned regression tests, then re-gated and live-verified.

---

## 1. Executive summary

**Production-readiness score: 88 / 100 — BLOCKED for an unrestricted production release by exactly two EXTERNAL items; recommended position unchanged: controlled pilot / pre-production.**

The R50.0–R50.8 remediation program re-verifies as TRUE on `z_ai_v2`: secrets hygiene, the four-plane auth chain, crypto at rest, the SAFE-001 host-key trust gate, execution/approval guards, and the production env boundary are all fail-closed with machine-pinned tests, and the dangerous-pattern sweep came back clean. The re-audit's genuinely new value:

1. **F-1 (P2, NEW, FIXED):** the target network policy (R50-T022) was a PROBE-PLANE control only. The other live dial planes — `CONFIG_BACKUP` jobs (`runner.ts`), `/simulate/connect` probes, `/live/fetch-config`, `/live/apply` controlled changes — dialed the RAW payload address with vault-resolved credentials. A `device.write`/`change.execute` holder could register a device at `127.0.0.1`/`169.254.169.254` and the worker would dial it. Remediated this increment (R51-A1): one `guardDialTarget` gate now governs EVERY live dial plane, refuses BEFORE any credential resolution, and dials the VALIDATED resolved address — pinned by a new 16-test suite.
2. **F-2 (P3, NEW, FIXED):** the session-exempt `/api/v1/meta` bootstrap endpoint disclosed credential-profile OPERATOR usernames pre-auth. Dropped (R51-A2) — no client ever consumed the field.
3. **N1 (LOW-docs, NEW, FIXED):** the R50.8 matrix doc's §4 summary claimed "26 cells COVERED" against 24 actual registry rows — prose drift the machine pin did not cover. Corrected AND count-pinned (R51-D1).

The release blockers are UNCHANGED in identity and are all outside the sandbox's control: **OWNER-CI-001** (GitHub Actions runner capacity — no independent CI proof since run #34) and **OWNER-GOV-001** (`main` branch protection), plus lab-side real-device certification (R50-T090..T092). Everything authorable is landed.

---

## 2. Repository fingerprint

| Field | Value |
|---|---|
| Audit start HEAD | `f813d7ab61af88b2e72066c2a67879bbb94794f0` (clean tree; only untracked runtime `db/`) |
| Remediation HEAD | see §7 (R51 increment: 10 files, 1 new test suite, 1 new audit doc) |
| Branch | `z_ai_v2`, tracking `origin/z_ai_v2`, up to date at audit start |
| Runtime | Bun 1.3.14 (CI-pinned; digest-pinned images) |
| Framework | Next.js 16.3.4 (App Router), TypeScript 5 |
| Database | PostgreSQL (embedded 16.4 on :5433 in this sandbox; compose `postgres:16-alpine`), Prisma 6.19.3, 9 committed migrations, migrations≡schema drift guard in CI |
| Architecture | Next.js app (:3000, the only published port) + worker mini-service (:3030, never published, no DB access) + PostgreSQL; poll-based job engine, service-JWT authenticated, vault-resolved device credentials worker-side |
| Transports | SIMULATOR (default), LIVE_SSH (5 CLI vendors, read-only backup/probe + plan-validated controlled change), LIVE_WEBAPI (sophos, fail-closed TLS trust) |
| Live restore | refused by design (`LIVE_RESTORE_NOT_CERTIFIED`) — honestly disclosed in README |

---

## 3. Security plane — control-by-control re-verification

| ID | Control | Verdict | Key evidence (fresh, this audit) |
|---|---|---|---|
| S-1 | Secrets hygiene | **VERIFIED-HEALTHY** | `.gitignore:39` covers `.env*` (only `.env.example` tracked); harness PEMs test-only per `mini-services/worker/harness/tls/README.md` + `.gitignore:27-30` whitelist; demo material clearly labeled (`prisma/seed.ts:111` `DEMO_PASSWORD="faya123"`, production seed REFUSED `seed.ts:2517-2530`); webhook secrets `randomBytes(32)` |
| S-2 | Auth chain | **VERIFIED-HEALTHY** | 4-plane gate `src/proxy.ts:99-185`; `session.ts:96-114` re-verifies active account; deny-by-default `permissions.ts:56-57`; service-JWT alg allowlist (HS256\|EdDSA only, no "none") + `timingSafeEqual` `service-jwt.ts:288-322`; login guard dual-enforced; ALL 125 `/api/v1` routes swept — every non-GET route gated by permission/role/scope helpers (36 helper-less files are GET-only) |
| S-3 | Rate/abuse | **VERIFIED-WITH-NOTES** | 300 GET / 120 mutation per min pre-handler `proxy.ts:110-120`; spoof-resistant keying; fail-closed shared store `rate-store.ts:34-41,220-228`; per-process scope honestly documented `rate-gate.ts:36-45`. Note: no per-endpoint budgets beyond the generic mutation budget for AI/discovery/import (self-declared hardening gate, not an abuse-proof quota) |
| S-4 | Network policy | **VERIFIED — 1 FINDING (F-1), FIXED** | Probe plane verified (`target-policy.ts` app+worker, parity-pinned; SSRF two-plane guard + redirect policy + 5 s abort `delivery.ts:80`; HMAC webhook signing `webhook-sign.ts:18-30`). **F-1:** backup/change/test-connection dial planes bypassed the policy — see §5; fixed this increment |
| S-5 | Crypto at rest | **VERIFIED-HEALTHY** | AES-256-GCM DEK-per-row + KEK wrap, AAD row binding `config/crypto.ts:75-157`; fail-closed 64-hex key requirement `:84-93`; host-key fail-closed pin `ssh/host-keys.ts:73-80`; vault exec = argv spawn, no shell, no secret logging (`vault.ts:230-257`); audit hash chain `audit/chain.ts:9-34` |
| S-6 | Execution guards | **VERIFIED-HEALTHY** | DB-enforced leases/locks `execution-guard.ts:24-26`; CAB 2-person quorum on CRITICAL `approval-policy.ts:30-33`; SoD self-approval ban `actor.ts:26,49-55`; `LIVE_RESTORE_NOT_CERTIFIED` enforced `change-step:1667-1668`; typed `RESTORE_TARGET_*` refusals `restore-op.ts:79-107` |
| S-7 | Env boundary | **VERIFIED-HEALTHY** | Production startup aborts on weak/known-bad/demo/postgres-URL `startup/security-policy.ts:7-17,76-89`; `env-boundary.test.ts` 30 pins incl. "reasons NEVER echo the received values"; worker control-auth alg/issuer/scope gating `/simulate/*`+`/live/*` (`control-auth.ts:177-249`, wired `worker/index.ts:185-191`) |
| S-8 | Dangerous-pattern sweep | **CLEAN** | No `eval`/`new Function`/`child_process` (vault spawn is argv-only)/`$queryRawUnsafe`/`$executeRawUnsafe`/CORS `*`/JWT "none"/secret logging; `timingSafeEqual` at every secret comparison |

**Cosmetic notes (no action required):** stale `src/middleware.ts` comment in the auth catch-all; unused shadcn `chart.tsx:83` `dangerouslySetInnerHTML` with static config and no call sites; documented/accepted SSRF DNS-TOCTOU residual (`ssrf-guard.ts:40-55`).

---

## 4. Supply-chain / dependency / docs plane — re-verification

| ID | Check | Verdict | Evidence |
|---|---|---|---|
| SC-1 | Base image pinning | **PASS** | All FROMs digest-pinned (`Dockerfile:31,48`, `Dockerfile.worker:19`, `compose.yml:53`), test-enforced by `supply-chain.test.ts:50-77` |
| SC-2 | Port exposure | **PASS** | Exactly ONE published port (app 80→3000, `compose.yml:102`); worker and postgres NEVER published — machine-pinned by `deploy-hardening.test.ts` |
| SC-3 | Container hardening | **PASS** | healthchecks, `cap_drop`, `no-new-privileges`, read-only rootfs, non-root uid 10001 |
| SC-4 | CI gate design | **PASS** | 4 jobs: lint/tsc/test/certify/brand/prisma-validate/migrate-deploy/drift-guard/seed-smoke/i18n/build:gate + scan (gitleaks, semgrep, osv-scanner both lockfiles, syft SBOM, trivy fs AND built images) |
| SC-5 | Action/binary pinning | **PASS** | all third-party actions @ full SHA; osv-scanner/syft sha256-verified before exec (`ci.yml:358,374`) |
| SC-6 | CI-001 claim consistency | **PASS** | `ci.yml:16-17` "infrastructure-blocked — no runner assigned" ≡ NEXT-TASKS "signature since run #34" — docs match reality |
| SC-7 | Prisma drift | **PASS** | 9 migrations, `provider="postgresql"`, schema validates; CI drift guard `migrate diff --exit-code` |
| SC-8 | Seed hygiene | **PASS** | demo-labeled material only; production seed refuses without `FAYANMS_DEMO_MODE=true` (`seed.ts:2522-2528`) |
| SC-9 | Dependency inventory | **PASS** | 66 deps + 13 devDeps; `next 16.3.4 / react 19.2.3 / prisma 6.19.3 / next-auth 4.24.15 / zod 4.6.2 / ssh2 1.16.0` exact-locked; BOTH lockfiles committed and frozen-lockfile-clean (no drift); ssh2 isolated to the worker plane with its own lockfile |
| SC-10 | Docs honesty | **PASS (1 FINDING → FIXED)** | README declares branch protection UNPROTECTED (`:201-202`) and discloses the live-restore refusal (`:221-226`); NEXT-TASKS ACTIVE section lists exactly the owner/lab-side residue. **N1:** R50.8 matrix §4 said "26 COVERED" vs 24 registry rows — fixed + pinned (R51-D1) |

**INFO-class notes:** `db/META-INF` (Zonky extraction scratch) untracked-but-visible in `git status` → gitignored (R51-D2); README tracks branch protection under the retired ID "OPS-001" → renamed OWNER-GOV-001 consistently (R51-D3); no `engines` field (bun pinned via CI + digest images; README badge "Bun ≥ 1.1" is looser than the tested 1.3.14 — cosmetic); sandbox shell exports a stale SQLite `DATABASE_URL` (neutralized by `tests/_setup.ts` preload; CI unaffected).

---

## 5. New findings of THIS re-audit (all remediated in §7)

| ID | Sev | Finding | Evidence (pre-fix) | Remediation |
|---|---|---|---|---|
| **F-1** | **P2** | Target network policy enforced on the DETECTION probe plane only. Backup (`runner.ts:263`), test-connection (`index.ts:262` via `/simulate/connect`), `/live/fetch-config` (`index.ts:519`), and `/live/apply` (`index.ts:804`) dialed the RAW payload address with vault-resolved credentials, breaching the T022 invariant ("refused BEFORE any credential work"). Bounded by SAFE-001 pinning + typed perms, but a `device.write` holder could point a device at `127.0.0.1`/`169.254.169.254` (cloud-metadata shape) and force worker dials at them. | dial sites listed above; `devices/route.ts:157` accepts any IPv4 mgmtIp | **R51-A1:** `guardDialTarget()` in `adapter-router.ts` governs resolveAdapter (both LIVE transports), `/live/fetch-config`, `/live/apply`; refusal = typed `TargetPolicyError` → 400 BEFORE vault resolution; the dial uses the VALIDATED resolved address (no second DNS lookup — rebinding window stays closed); lab hatch `FAYANMS_PROBE_ALLOW_SPECIAL` honored unchanged. Pinned by NEW `tests/audit/r51-dial-target-policy.test.ts` (16 tests, incl. pre-vault-order proof and runner wiring) |
| **F-2** | **P3** | `/api/v1/meta` (session-exempt bootstrap surface, `proxy.ts:125`) selected credential-profile `username` pre-auth. | `meta/route.ts:36-40` (pre-fix) | **R51-A2:** column dropped from the select + `MetaPayload` type; zero client consumers (pickers render `name · type` only); pin added |
| **N1** | LOW (docs) | R50.8 matrix §4 claimed "26 cells COVERED"; the §3 registry has 24 (24+14+2+1=41). The governance pin did not pin prose counts. | `FayaNMS-R50.8-Test-Matrix-2026-09-17.md:107` (pre-fix) | **R51-D1:** prose corrected with an in-doc correction note; NEW pin in `r50-test-matrix.test.ts` — all four disposition counts + their 41-partition + the literal §4 sentences are now machine-enforced |
| N2 | INFO | `db/META-INF/` (Zonky embedded-PG manifest) untracked but not gitignored — noise in `git status`. | `.gitignore:69-79` (pre-fix) | **R51-D2:** `/db/META-INF/` added to `.gitignore` |
| N3 | INFO | README tracked branch protection under the retired ID "OPS-001" vs NEXT-TASKS "OWNER-GOV-001" (states agreed; naming drifted). | `README.md:202,221,1082` (pre-fix) | **R51-D3:** renamed consistently (3 sites) |

---

## 6. Verification gates — personally executed during this audit

| Gate | Command | Result |
|---|---|---|
| Lint | `bun run lint` | **0 errors** |
| Typecheck (FULL) | `bunx tsc --noEmit` | **0 errors** |
| Test suite (CI env shape, pre-remediation baseline) | `bun test tests/` with ci.yml:91-96 env + `.env` stash/restore | **869 pass / 18 skip / 0 fail** (4,712 expects, 50 files) — reproduces the landed R50.8 state exactly |
| Test suite (post-remediation) | same protocol | **884 pass / 18 skip / 0 fail** (4,754 expects, 51 files) — +15 pins from R51 |
| Protocol note | — | The suite MUST run in the CI env shape (ci.yml:91-96, `.env` stashed). Running it bare (local `.env` auto-loaded) injects EdDSA keys that reject the HS256 test mints and produce ~24 environment-caused failures — a verification-protocol trap, not a code defect; now documented here. |

Not executed (recorded honestly): `build:gate` — sandbox memory ceiling OOM-blocks `next build` with the deployment stack resident (recorded since Phase 8); remote CI — platform-blocked since run #34 (OWNER-CI-001).

---

## 7. Remediation increment (R51) — executed in this session, on top of `f813d7a`

| Task | Files | Content |
|---|---|---|
| R51-A1 (F-1) | `mini-services/worker/adapter-router.ts`, `mini-services/worker/index.ts` | `TargetPolicyError` + `guardDialTarget()`; enforcement in resolveAdapter (SSH + WebAPI branches, BEFORE vault), `/live/fetch-config`, `/live/apply`, `/simulate/connect` catch-mapping; dial host = validated resolved address |
| R51-A1 tests | `tests/audit/r51-dial-target-policy.test.ts` (NEW, 16 tests) | guard decision matrix (literals/hostnames/fail-closed RRset/deterministic pick/hatch), both LIVE transports refuse pre-vault, endpoint 400s with vault UNRESOLVABLE (order proof), SIMULATOR untouched, runner + index wiring pins |
| R51-A2 (F-2) | `src/app/api/v1/meta/route.ts`, `src/lib/api-client.ts` | username dropped from the pre-auth meta surface (+ pin in the R51 suite) |
| R51-D1 (N1) | `docs/audits/FayaNMS-R50.8-Test-Matrix-2026-09-17.md`, `tests/audit/r50-test-matrix.test.ts` | 26→24 prose correction + full disposition-count pin |
| R51-D2/D3 (N2/N3) | `.gitignore`, `README.md` | `/db/META-INF/` ignored; OPS-001 → OWNER-GOV-001 (×3) |
| Evidence | `agent-ctx/verify-r51-device-detail.png`, `agent-ctx/verify-r51-device-detail-mobile.png` | live browser evidence (§8) |

**Gates after remediation:** lint 0, tsc FULL 0, suite **884/18/0** (CI env shape).

---

## 8. Live + browser verification (deployed stack, this session)

Stack: app :3000 (restart with remediated code), worker :3030 (restart, health `ok:true`), embedded PG :5433 (`pg_isready` accepting).

- Sign-in gate renders with demo accounts → admin sign-in succeeds → full app shell with live data (1 critical alert, 3 notifications, 1 running job).
- **Devices** view renders the seeded inventory (BR1-Access-SW-01 et al.) from the live API.
- **Add Device sheet** (F-2 consumer): every field renders; the credential-profile picker lists the three seeded profiles as `name · type` — the remediated meta payload feeds it correctly; Detect correctly disabled until a hostname exists (D6 behavior preserved).
- **Test connection** on a simulator device through the governed `/simulate/connect` path: **"Connection OK — 776 ms"**, device Online — the dial-plane enforcement did not disturb the legitimate probe flow (SIMULATOR plane intentionally ungoverned; LIVE refusals are machine-pinned hermetically, incl. real-handle 400s).
- Worker `/health` after the session: `ok:true`, jobs completing, `consecutiveClaimFailures: 0`. App 200. PG ready.
- **0 console errors / 0 page errors** across the whole journey; mobile 390×844: no horizontal scroll (`scrollWidth ≤ 391` → true); screenshots captured (desktop + mobile).

---

## 9. Score (independent)

| Dimension | Weight | Score | Basis |
|---|---|---|---|
| Secrets & crypto | 15 | 15/15 | S-1, S-5 all healthy, fail-closed |
| AuthN/AuthZ | 20 | 20/20 | S-2 verified across all 125 routes; deny-by-default; alg pinning |
| Abuse controls & network policy | 10 | 10/10 | S-3 + F-1 FIXED with pinned enforcement on every dial plane |
| Execution safety | 15 | 15/15 | S-6 guards + typed live-restore refusal |
| Supply chain & deploy hardening | 10 | 10/10 | SC-1..SC-5, SC-9 |
| Code quality & architecture | 10 | 9/10 | two-plane shape clean, self-contained worker; −1 for cosmetic notes + missing `engines` |
| Test & verification depth | 10 | 10/10 | 902 tests/51 files, governance pins, harness journeys; +R51 suite |
| Docs honesty | 5 | 5/5 | N1 fixed + pinned; README honest on unprotected main + restore refusal |
| **Total** | **95** | **94/95 → 88/100 after the release-blocker penalty** | −12: no independent CI-produced proof (OWNER-CI-001) and no pre-merge enforcement (OWNER-GOV-001); the two items no sandbox increment can close |

---

## 10. Production acceptance gate

| Gate | Status |
|---|---|
| All authorable remediation landed and re-verified | ✅ (R50.0–R50.8 + this R51 increment) |
| Local gate battery on the exact SHA | ✅ lint 0 / tsc 0 / 884-pass suite / hermetic certification suites |
| Independent CI proof on the release SHA | ❌ OWNER-CI-001 (infrastructure) |
| Pre-merge enforcement on `main` | ❌ OWNER-GOV-001 (settings-side) |
| Real-device certification of the live plane | ❌ R50-T090..T092 (lab-side; Step 0 = `bun run demo:fleet` public demo plane) |
| Live restore | refusal by design — disclosed, typed, audited |

**Verdict: unchanged production position — controlled pilot / pre-production.** The code plane is now internally consistent with its own stated invariants (the F-1 gap the re-audit exposed is closed and pinned). What separates this tree from an unrestricted release is exclusively infrastructure (CI runners), governance (branch protection), and hardware certification — all operator-side.

## 11. Limitations

- The security-plane and supply-chain passes were re-derivations from source with targeted command execution (git/grep/prisma validate/bun install --frozen-lockfile --dry-run); they did not execute a production build (sandbox OOM ceiling — recorded) nor real-network probes against physical hardware (out of scope for this environment).
- CI evidence could not be re-produced locally by construction: its value IS independence (OWNER-CI-001).
- The web-hosted `main` branch and GitHub settings (branch protection, Actions runs) were NOT re-queried in this pass; their state is carried from the 2026-09-15/16/17 audits and is consistent with every doc claim in the tree.
