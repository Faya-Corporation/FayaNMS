# FayaNMS — Full End-to-End Production ReAudit (branch `z_ai_v2` @ `1c6ab0c`)

**Date:** 2026-09-18
**Scope:** every plane, re-derived independently on the exact pushed tree — security (8 control families), supply chain / dependencies / migrations / docs-honesty, architecture / code-quality / test-surface / data-plane / UI-UX — plus a full gate battery in the CI environment shape and a live HTTP + browser pass over the deployed stack.
**Method:** three independent read-only audit passes (security, supply-chain/docs, architecture/tests) with fresh `file:line` evidence; remediation of every actionable finding in the same increment (R52); machine-pinned regression guards; live behavioral verification.
**Upload note:** the user-side upload of this report's namesake (and of the accompanying roadmap) did not land in the sandbox (`upload/` empty); per protocol the filenames defined the tasks.

---

## 1. Verdict

**PASS — production position: CONTROLLED PILOT, one step closer.** All previously claimed invariants re-derive TRUE on `1c6ab0c`; **zero P1/P2 findings**; **one new P3** (auth-ordering on the AI routes — fixed in this increment) plus a hygiene set (all fixed in this increment). The gap to production remains exactly what the prior audits said it is: **owner-side infrastructure (CI runners, branch protection)** and **lab-side real-device certification** — nothing authorable is open except the hardening backlog codified in the companion roadmap (`FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md`).

| Plane | Verdict | New findings |
|---|---|---|
| Security (8 control families) | 7 VERIFIED-HEALTHY, 1 VERIFIED-WITH-NOTES (rate/abuse budgets) | F-N1 (P3) — **FIXED in R52**; F-N2/F-N3 (INFO) — F-N2 fixed, F-N3 documented as a roadmap item |
| Supply chain / deps / migrations / docs | PASS — SOLID, **zero dependency drift, zero regressions** | 4 INFO polish notes (optional) |
| Architecture / code-quality / tests / data / UI-UX | SOLID and internally consistent | 3 P3 hygiene — **ALL FIXED in R52** |

**Gates on the remediated tree (CI env shape, ci.yml:91-96 with `.env` planes stashed/restored):**
lint **0** · `tsc --noEmit` **0** · suite **894 pass / 18 skip / 0 fail** (4,800 expects, 52 files) — up from 884/18/0: the new `tests/audit/r52-auth-ordering.test.ts` adds 10 pins.

---

## 2. R51-fix regression check — BOTH HELD under independent re-derivation

- **R51-A1 (dial-plane target policy):** `guardDialTarget` (`adapter-router.ts:135-148`) governs `resolveAdapter` on BOTH live transports (WebAPI :236-238, SSH :268-270) with the adapter dialing only the validated address (`live-ssh.ts:163`, `webapi-transport.ts:115` + `rejectUnauthorized` :121-124); `/live/fetch-config` (worker `index.ts:529` → dial :531-536), `/live/apply` (:823 → :833-838); CONFIG_BACKUP `runner.ts:255` dials only via `resolveAdapter`; detection keeps `resolveTargetForDial` (:644). Bypass hunt: no unguarded dial plane exists — `createLiveSshAdapter` has no HTTP-plane callers outside guarded paths, no `net/tls.connect` to payload hosts, all app-plane fetches target the worker base URL. Pinned by `r51-dial-target-policy.test.ts` (14 test blocks / 30 expects — see §5 note on pin counting).
- **R51-A2 (meta username):** held — `meta/route.ts:43-47` selects `{id, name, type}` with the R51-A2 comment; live wire confirms `credentialProfiles` keys = `id/name/type`.
- **R51-D1/D2/D3 (docs/hygiene):** held — matrix prose COVERED=24 machine-pinned; `/db/META-INF/` gitignored (tree now COMPLETELY clean — zero untracked artifacts); README OWNER-GOV-001 exactly ×3 (:202, :221, :1082).

## 3. Per-plane evidence (condensed; full detail in the pass records)

### 3.1 Security — 8/8 families re-verified

- **CTRL-1 secrets:** `.gitignore` `.env*` + `!.env.example` (:39/:62); tracked PEMs = 2 SFOS harness certs (test-only loopback, documented); seed `DEMO_PASSWORD` labeled + production guard `seed.ts:2521-2530`; secret-literal sweep of src/ + worker clean (only negative-test values); `.env.example` keys empty.
- **CTRL-2 auth chain:** proxy 4-plane gate `proxy.ts:99-185` (verified service JWT → rate gate BEFORE side effects → public/service list → opaque-bearer MUTATIONS-ONLY :148-155 → session; auditor mutation block :175-177; next-auth v4 GHSA-xmf8-cvqr-rfgj crash guard :157-169); `requireUser` re-verifies active account per request (`session.ts:96-114`); deny-by-default permissions (`permissions.ts:56-63`); login guard enforced twice (pre-check + in-authorize, escalating lockout, fail-closed shared store); service-jwt alg allowlist HS256|EdDSA (:288-289), timingSafeEqual (:319-321), issuer allowlist (:383-389). **Full sweep of 125 v1 route files: 0 non-GET routes lack an auth gate** (77 named helpers + 5 `resolveActingUser` wrappers + 43 GET-only proxy-session-gated; all session-exempt service routes handler-gated).
- **CTRL-3 rate/abuse — VERIFIED-WITH-NOTES:** 300 GET / 120 mutation per min, unknown method → stricter budget, rightmost-trusted-hop keying, bounded buckets; postgres shared store fails closed (advisory-lock-serialized, denied attempts insert nothing); login plane has dedicated per-source + per-account HMAC-hashed budgets with exponential lockout. **Note (carried):** budgets are per client-kind, not per-endpoint — no stricter budget on the AI/CSV-import surfaces (codified as roadmap item HC-1).
- **CTRL-4 network policy:** app probe classes (`target-policy.ts:59-73` + hatch :75) wired `auto-detect:337-360`; worker `resolveTargetForDial` fail-closed across the RRset; webhook two-plane SSRF guard (admission :226-258, delivery re-check :269-301 with redirect refusal + 5 s timeout); HMAC-SHA256 + timingSafeEqual signing. **R51-A1 held (§2).**
- **CTRL-5 crypto:** AES-256-GCM DEK-per-row + KEK wrap + AAD row-binding (`config/crypto.ts`); SAFE-001 fail-closed known_hosts pinning enforced pre-auth (`ssh-transport.ts:181-193`); vault references-only + argv-template spawn `shell:false` (`vault.ts:252-257`); sha256 audit chain with mutex + backfill semantics.
- **CTRL-6 execution guards:** 4 h leases / 15 min device locks / TTLs (`execution-guard.ts`); CAB two-person quorum on CRITICAL; SoD self-approval ban; `LIVE_RESTORE_NOT_CERTIFIED` enforced at change-step (:1667-1668); typed restore refusals + audit.
- **CTRL-7 env boundary:** production aborts (demo-mode, non-postgres, secret strength/known-bad blocklist, service-identity modes; static reasons — no values echoed); worker control-auth full verifier gating `/simulate/*` + `/live/*`.
- **CTRL-8 sweep:** zero eval/new Function; child_process only vault argv-spawn + harness + SSH client.exec on the guarded channel; zero raw-unsafe prisma; no CORS headers (same-origin default); no JWT "none"; timingSafeEqual in all 5 comparison modules; git history clean (the sole historical `.env` held a sqlite file URL, no secrets).

### 3.2 Supply chain / dependencies / migrations / docs

- **Dependencies:** root 66 deps + 13 devDeps + 15 overrides — **identical to prior audit, zero drift**; worker 1 dep (ssh2 1.16.0 exact) + own committed lockfile; both lockfiles pass `--frozen-lockfile --dry-run` (exit 0, tree stayed clean).
- **Supply chain:** all release bases digest-pinned (Dockerfile:31/:48, Dockerfile.worker:19, compose.yml:53, compose.tls.yml:76) and machine-pinned by `supply-chain.test.ts`; exactly ONE published port (app); worker + postgres publish nothing; healthchecks + non-root (uid 10001 / bun user); SEC-ENV-001 env split incl. worker out-of-zone deny list; ci.yml 4 jobs, all third-party actions SHA-pinned, osv dual-lockfile scan + syft SBOM + gitleaks/semgrep/trivy, honest CI-001/GOV-001 header.
- **Migrations:** 9 dirs + postgres lock; `prisma validate` (postgres URL) → **"The schema at prisma/schema.prisma is valid"**; **42 CREATE TABLE statements = 42 schema models, 1:1**; last migration matches `LoginGuardState` column-for-column.
- **Docs honesty:** README claims spot-checked vs implementation (30 devices/7 vendors = seed; badge versions = lockfile; every doc referenced exists); NEXT-TASKS ACTIVE = exactly owner-side + lab-side; R50.8 matrix counts sum 41 ✓ with the R51-D1 pin.
- **INFO notes (optional polish):** ci.yml service-container postgres is tag-pinned (CI-only, ephemeral); `.gitignore:29` comment path imprecision; README "Bun ≥ 1.1" loose floor vs CI 1.3.14; no dependabot/renovate (codified as roadmap item HC-5).

### 3.3 Architecture / code-quality / test surface / data plane / UI-UX

- **Architecture:** single published port + DB-blind worker (structural: no prisma in worker deps, out-of-zone env denial); dual transport CERT-006 (`LIVE_WEBAPI_VENDORS = ["sophos"]`); **7/7 adapter ↔ detection registry parity** with static driver derivation; **46 ViewKeys ↔ 46 router cases ↔ 46 VIEW_REGISTRY entries, exact 1:1** (programmatic set comparison); auth gate wraps the entire shell (`app-shell.tsx:112-141`).
- **Code quality:** zero dangling imports (programmatic sweep vs both manifests); zero real TODO/FIXME markers; `dangerouslySetInnerHTML` = the known unreachable chart scaffold only; error handling sampled across 5 routes — typed envelopes, fixed messages, `X-Request-Id` everywhere, zero stack echoes.
- **Test surface:** exactly 51 files pre-R52 (49 `.test.ts` + 2 `.test.tsx`: audit 38 / auth 5 / brand 4 / browser 2 / config 1 / e2e 1); all 18 skips are conditional `test.skipIf` with documented reasons; no assertion-free tests (per-file expect-count ≥ test-count everywhere); no duplicate fixtures (md5-checked).
- **Data plane:** 42 models, 0 enums, hot-path indexes verified (Device/JobExecution/AuditEvent/CredentialProfile).
- **UI-UX:** sticky-footer flex rule + iOS safe-area inset (`app-footer.tsx:23`); skip-link, RTL-aware drawer; **en/ar key parity exact 1285 = 1285**; shadcn + next-intl + aria-labels consistent across sampled views.

## 4. Findings and remediation (all landed in this increment)

- **F-N1 (P3 — FIXED, R52-F-N1):** `ai/assist`, `ai/change-draft`, `ai/rca-draft` resolved the actor only AFTER building their DB context (e.g. `ai/assist` context build + 404 at :74-93, actor at :96) — a half-authenticated principal (deactivated user with a live JWT, or an opaque-bearer API client admitted on the mutation plane) got a 404-vs-401 existence oracle plus free pre-auth DB work. **Fix:** `resolveActingUser` hoisted above ALL DB work on the three routes (mirroring `ai/query`'s correct ordering). **Pins:** `tests/audit/r52-auth-ordering.test.ts` — actor-before-DB ordering on all three routes + exactly-once actor resolution + an `ai/query` within-handler regression guard. **Live proof:** unauthenticated POST → 401; authenticated + nonexistent device → `DEVICE_NOT_FOUND` (honest 404, gate passed first); authenticated + real device → full `{answer, correlationId, contextSummary}` LLM response; the `ai/query` dialog answered from live data ("31 devices: 25 ONLINE, 1 DEGRADED, 2 UNMANAGED … 100% backup success").
- **F-N2 (INFO — FIXED, R52-F-N2):** stale comments corrected — `api/auth/[...nextauth]/route.ts` now points to `src/proxy.ts` (the Next 16 successor of the deleted `src/middleware.ts`); `meta/route.ts` + `api-client.ts` `users`-map justification now names the real consumer (alert assign/suppress picker) instead of the removed SEC-001 "act as" feature.
- **F-N3 (INFO — ACCEPTED + ROADMAP):** the pre-auth `/api/v1/meta` users map (id/name/role + email local-part) remains a documented demo-lab tradeoff, distinct from the closed F-2; production hardening = split the bootstrap surface (roadmap item HC-2).
- **R52-H1 (P3 — FIXED):** dead `src/components/views/credentials-view.tsx` deleted (imported nowhere; the router mounts `AdminCredentialsView`); pin: file absent + router clean.
- **R52-H2 (P3 — FIXED):** 9 unused runtime dependencies removed (`@dnd-kit/core/sortable/utilities`, `@mdxeditor/editor`, `@reactuses/core`, `@tanstack/react-table`, `react-markdown`, `react-syntax-highlighter`, `uuid` — each verified zero imports repo-wide before removal); the `socket.io` pair (used ONLY by the tracked `examples/websocket` scaffold) demoted to devDependencies. Pins: dependencies surface + socket.io placement.
- **R52-H3 (P3 — FIXED):** the schema's "NO Prisma Json type" portability rule now documents its SINGLE SANCTIONED EXCEPTION (`LoginGuardState.failures Json @default("[]")`, JSONB by migration `20260915223000_scale001b_login_guard_state` — read/rewritten whole, never queried field-wise); pin: `failures` is the ONLY Json column in the schema + the governance note exists.

**Pin-count correction (carried from R51):** the R51 commit/worklog prose called `r51-dial-target-policy.test.ts` a "16 pins" suite; the actual file contains **14 test() blocks / 30 expects**. Historical worklog text is append-only audit trail and is not rewritten; this report states the countable truth, and the R52 suite uses exact counts.

## 5. Live verification (deployed stack)

- Stack: app :3000 (200) · worker :3030 healthy (236 jobs completed, 0 failed) · embedded PG :5433 ready.
- AI plane end-to-end (post-F-N1): unauthenticated POSTs → 401 proxy envelope; authenticated `ai/assist` with a nonexistent device id → `DEVICE_NOT_FOUND` (404 — the actor gate passed first, the oracle is closed); authenticated `ai/assist` with a real device (`dev-br1-access-sw-01`) → structured LLM answer (`{answer, correlationId, contextSummary}`); `ai/query` dialog (browser) → real answer from live data.
- Mobile 390×844: **NO horizontal scroll** (precise diagnosis: scrollWidth 390 = clientWidth 390, zero overflowing elements). Screenshot: `agent-ctx/verify-r52-ai-assist-auth-order.png`.
- 0 console errors on the exercised surfaces.

## 6. Honest limitations

- `build:gate` remains unexecuted in this sandbox (documented OOM ceiling with the deployment stack resident — unchanged since R50.8); compile-plane evidence is full `tsc --noEmit` 0 + the 52-file suite.
- GitHub Actions cannot run (OWNER-CI-001 — no runner capacity); branch protection off (OWNER-GOV-001); gitleaks binary not installed locally (CI runs it) — the history sweep was targeted pattern/entropy screening, not a full gitleaks pass.
- Live GitHub state (branch protection, badge, registry digest freshness) unverifiable offline — the in-repo DOC-001-A reconciliation and machine pins are the evidence basis.
- Arabic translations: key parity verified exact (1285 = 1285); prose linguistic quality not audited.
- The half-authenticated F-N1 exploit narrative (deactivated user with a live JWT) was verified by construction (ordering pins + honest-404 behavior) — not by provisioning a deactivated user on the live stack.

## 7. Conclusion

The tree at `1c6ab0c` + R52 remediations is the strongest verified state so far: every prior claim reproduces, the one new code finding is fixed with regression pins, the dependency surface shrank, the documentation is self-consistent, and the live stack proves the remediated behavior end-to-end. Production readiness is now gated ONLY by: (a) owner-side infrastructure — CI runner capacity (OWNER-CI-001) and branch protection (OWNER-GOV-001); (b) lab-side real-device certification (R50-T090..T092); and (c) the authorable hardening backlog codified in the companion Production-Readiness Implementation Roadmap (HC-1..HC-6), of which the first slice is ALREADY LANDED as this increment.
