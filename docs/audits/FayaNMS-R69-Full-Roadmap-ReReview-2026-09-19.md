# FayaNMS — R69 Full Roadmap Re-Review (Senior Independent Full-Stack Audit, 2026-09-19)

**Branch:** `z_ai_v2` · **Base tree reviewed:** `91d3f97` (R68) · **Remediation commit:** this round
**Scope:** EVERY item of `FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md` — R52 remediation, HC-1..HC-6, Phase OWNER (CI-001 / GOV-001), Phase LAB, the Go-live definition — re-reviewed as a senior independent full-stack engineer, against the **actual code**, not the audit pins alone.
**Verdict (executive):** **PASS — all substantive roadmap claims verified true in code**, with **four authorable findings** (one P1, two P3, one cosmetic) discovered and **remediated in the same round**. Authorable backlog after remediation: EMPTY again. Operator-side blockers unchanged (4): runner capacity, GitHub plan upgrade, LAB hardware, then the protected merge.

---

## 1. Method

1. **Three parallel deep-read verification passes** (independent of the original implementers' test pins):
   - Pass A — HC-1 (rate budgets) + HC-2 (meta/users split);
   - Pass B — HC-3 (RequestContext removal) + HC-4 (i18n chrome) + R52-F-N1 (AI auth ordering);
   - Pass C — R61 P0 (SSH first contact + IPv6) + R62 P1 (proxy isolation + read RBAC) + HC-5 (Dependabot) + R67 (gov-verify + ci.yml shape).
   Each pass read the implementation source, re-derived the claimed invariants from the code, re-executed the relevant pin suites, and ran fresh live wire probes.
2. **Full gate battery re-executed** from a cold shell under the R64 3-knob gate env (`/tmp/fayanms-ci-gate.env`).
3. **LIVE three-point verification** against the running topology (app · worker · fail-closed probe), plus fix-specific probes.
4. **Remediation + pins + re-gates** in the same round for every authorable finding (standing protocol).

---

## 2. Per-item verdicts

### R52 — ReAudit remediation (F-N1, F-N2, H1–H3) — ✅ VERIFIED IMPLEMENTED

- **F-N1 (P3, auth-before-DB on AI routes):** verified in all four routes — `ai/assist` (actor at `route.ts:69-72`, first DB at `:82-85`), `ai/change-draft` (`:171-174` → `:177`), `ai/rca-draft` (`:116-119` → `:121`), `ai/query` (`:704-707` → `:710-719`). All carry `force-dynamic` and zero module-scope DB work; 401 always precedes 404; the existence oracle is closed. Pins (`r52-auth-ordering.test.ts`, 18 pins) re-executed green.
- **Honest limitation (recorded, not remediated):** the ordering pins are **source-text `indexOf` assertions, not behavioral wire tests**; the runtime ordering was manually re-verified correct at this tree. A refactor that moved auth behind an awaited call while preserving the text markers would not be caught (the `ai/query` guard slices to the POST handler; the other three routes do not).
- Cosmetic: `ai/query` carries no in-source R52 comment (its ordering is guard-pinned only).

### HC-1 — Per-endpoint rate budgets (R53) — ✅ VERIFIED IMPLEMENTED (+ claim-path drift, cosmetic)

- Budget table verified verbatim at `src/lib/api/rate-gate.ts:61-70`: defaults `GET 300 / mutation 120` per minute unchanged; named budgets `RATE_LIMIT_AI = 10`, `RATE_LIMIT_CSV_IMPORT = 5`.
- Registry `resolveNamedRouteBudget` (`:85-93`): prefix match `/api/v1/ai/`, EXACT match `/api/v1/devices/csv-import`, everything else falls to client-kind budgets. Named buckets keyed `${ip}:route:${family}` — sibling pools untouched.
- Proxy wiring verified at `src/proxy.ts:137-150` (the single `takeRateSlot` caller; pathname passed through) with 429 + `Retry-After` from the family's own sliding window (`rate-gate.ts:213-221`). 41/41 pins re-executed green. **Live wire probe this round:** 11× unauth `POST /api/v1/ai/query` → 401×10 then **429** (`retry-after: 60`); 6× unauth `POST csv-import` → 401×5 then **429**.
- Senior notes: only two families are named — other heavy surfaces (`reports/run`, `devices/bulk`, discovery) still ride the 120/min mutation pool (consistent with the roadmap's "e.g."; recorded as headroom, not a defect). Budgets key by IP, not identity (per-client-kind design). Pre-auth slot consumption is intentional (protects LLM surfaces from pre-auth hammering). No bypass found; Postgres store advisory-lock-atomic and fail-closed.
- **Claim-path drift (cosmetic):** the roadmap prose cites `src/lib/security/rate-gate.ts` and `src/middleware.ts`; the actual files are `src/lib/api/rate-gate.ts` and `src/proxy.ts` (Next 16 convention). Corrected in the roadmap's R69 path-correction appendix.

### HC-2 — Authenticated bootstrap split (R54) — ✅ VERIFIED IMPLEMENTED (+ one P3 fixed)

- Unauth `GET /api/v1/meta` verified returning ONLY `vendors` / `sites` / `credentialProfiles` — no `db.user` query remains in the handler; credential profiles select `{id, name, type}` only. 10/10 pins re-executed green (incl. the wire-level `expect("users" in body.data).toBe(false)`).
- `GET /api/v1/meta/users` verified actor-gated before the DB read; proxy exemption is exact-match `/api/v1/meta` only. Both consumers verified migrated (`alert-action-dialogs.tsx`, `incident-detail-view.tsx` → `useMetaUsers()`).
- **R69-F2 (P3, FIXED THIS ROUND):** the users mapping fell back `name: user.name ?? user.email` — any active user with a null `name` would have had their **full email exposed**, contradicting the route's own "no emails beyond the local-part" contract. Fixed to `user.name ?? user.email.split("@")[0] ?? user.id` with an explanatory comment; source-pinned (`r69-roadmap-rereview-remediations.test.ts`). Seeded data has names, so no live leak ever occurred.
- Structural note (recorded): "fetched after hydration" is enforced by component placement (pickers only mount inside the authenticated shell), not by an explicit `enabled:` gate on `useMetaUsers` — fail-closed (a pre-auth mount would 401), but an `enabled` flag would make the invariant explicit.

### HC-3 — Deprecated `RequestContext` removal (R55) — ✅ VERIFIED IMPLEMENTED

- `_ctx` params: **0 matches across all of `src/`**. `ok`/`fail`/`failWithMeta`/`failWithDetail` verified context-free (`src/app/api/v1/_lib/api.ts:63-135`).
- The `requestContext()` shim remains exported-but-inert exactly as the roadmap acceptance specified; `requestContext|RequestContext` references: exactly 2 hits, both inside `_lib/api.ts`. Debt comment replaced by the R55 retirement record. 12/12 pins re-executed green (incl. wire-level envelope invariance with `X-Request-Id === meta.requestId`).
- Claim-path drift (cosmetic): plan prose says `src/lib/api.ts`; actual is `src/app/api/v1/_lib/api.ts`. Corrected in the R69 appendix.

### HC-4 — i18n completion of chrome copy (R56) — ✅ VERIFIED IMPLEMENTED (+ framing corrected)

- Dictionary parity **machine-measured this round: 1419 = 1419 leaf keys**, identical key sets both directions, 28 namespaces balanced (the roadmap's "1285 = 1285" was the pre-R56 figure — R56's own commit records the move to 1419). New `devices`/`deviceDetail` namespaces verified with genuine Arabic content.
- The two named views re-swept with the pin's exact regexes: `devices-view.tsx` → exactly `["LIVE"]` (the documented data-plane chip); `device-detail-view.tsx` → zero. All 139 `t()` references in the two views resolve in BOTH dictionaries. 8/8 pins re-executed green.
- **Honest framing correction:** the roadmap's "small documented allowlist" is in reality a **two-view zero-pin + a 32-view shrinking-ceiling debt ledger** (`PENDING_VIEWS` in `r56-i18n-chrome-sweep.test.ts:80-113`) holding **823 tolerated candidates** — it prevents growth but full-tree cleanliness is deferred until the ledger empties. Recorded in the R69 appendix; the ledger discipline itself is sound (per-file ceilings, no growth tolerated).
- Known accepted limitation (documented in the test header): lowercase-initial and ternary/template-literal strings evade the shallow regexes; independent deeper scans found nothing user-visible missed in the two target views.

### HC-5 — Supply-chain automation config (R57) — ✅ VERIFIED IMPLEMENTED

- `.github/dependabot.yml` verified: `version: 2`, exactly two `bun` entries — `/` (root app) and `/mini-services/worker` (the second manifest; this is what "both manifests" means) — weekly Monday 06:00 UTC both, security-updates grouped both, `allow: dependency-type "all"`, no `ignore:` block (nothing muted). 8/8 pins re-executed green (config ↔ on-disk manifests cross-checked).
- Honest caveat stands (documented in the config header): GitHub-side activation is runner-gated (OWNER-CI-001).

### HC-6 — Release gate on real CI — ✅ TRIGGER PATH TRIPLE-PROVEN; BLOCKED ON RUNNER CAPACITY (external)

- The `workflow_dispatch` trigger (added R63) has now been executed **three times across three SHAs** (`7cb6be4`→run `35406875963`, `0d28a34`→run `35408254887`, `13a8fcf`→run `35411315267`), each 204-accepted and correctly bound to branch/SHA, each failing at the gate job with **0 steps executed** — the identical runner-infra signature of runs #34/#89. The candidate PR's own `pull_request` checks remain the preferred vehicle once capacity exists (checks attach to the PR as the required-check record).
- Honest environmental note (R68, stands): the in-sandbox e2e/browser HARNESS suites are not executable here (`.next/standalone` absent — the ≥8 GB `build:gate` OOM caveat; `:3030` collision with the session worker). Not a regression; UI unchanged since the R47–R58 green runs. Substituted verification: the R68 live browser golden-path journey (zero console/page errors, EN + AR/RTL) and this round's HTTP wire probes.

### Phase OWNER-CI-001 — external, unchanged

Runner capacity is the sole CI blocker; the workflow is complete, SHA-pinned, digest-pinned, and trigger-proven three times.

### Phase OWNER-GOV-001 — ✅ ACCEPTANCE EXECUTABLE (R67) + hardened this round (R69-F3)

- `scripts/gov-verify.ts` re-verified: dual-mechanism read-back, four-check invariants, approvals ≥ 1, code-owner review, typed exits 0/1/2, plan-blocker classification, token env-only and never printed.
- **R69-F3 (P3, FIXED THIS ROUND):** the ruleset plane previously verified ONLY `required_status_checks` + `pull_request` approvals — it silently ignored `non_fast_forward`, `deletion`, `required_conversation_resolution`, `required_linear_history`, so a ruleset-only governance setup could pass with those guarantees unverified. Fixed: `evaluateRulesets` now asserts all four protective rule types as hard invariants. Also reconciled: the header's incorrect "first source that reports an ACTIVE enforcement wins" wording (the code in fact REQUIRES both mechanisms — a missing classic protection or a missing ruleset is itself a FAIL) and the linear-history check's mislabel "(advisory — record-only)" (it is enforced as a hard invariant). All changes source-pinned.
- The GitHub-Free **plan gate** (R67 live discovery) remains the first operator prerequisite, documented as runbook step 0.

### Phase LAB — external, unchanged

Step 0 (public demo device plane + `bun run demo:fleet`) ready; R50-T090..T092 certification and TASK-CERT-HW-001-A ride hardware access.

### Go-live definition — re-assessment

| # | Criterion | State |
|---|---|---|
| 1 | HC-1..HC-5 LANDED; re-audit PASS, zero open P1/P2/P3-authorable | **RE-MET this round** (R69-F1..F4 were open during review → remediated and pinned in the same round; queue EMPTY again) |
| 2 | OWNER-CI-001 closed (green 4-job run on release SHA) | blocked: runner capacity (trigger triple-proven) |
| 3 | OWNER-GOV-001 closed (`main` protection, 4 required checks) | blocked: GitHub plan upgrade → ruleset config → `bun scripts/gov-verify.ts main` exit 0 |
| 4 | LAB certification (one representative per vendor family) | blocked: hardware access |
| 5 | Fresh independent full re-audit on release SHA + checklist re-run | **this report is the strongest in-sandbox precursor** (full code-level re-review + remediation); the release-SHA re-audit after items 2–4 remains the formal final gate |

---

## 3. Findings register (this round)

| ID | Severity | Finding | Status |
|---|---|---|---|
| R69-F1 | **P1** | `GET /api/v1/devices/[id]/snapshots/diff` had **no handler-level authorization**: it decrypted BOTH snapshots and returned full configuration text (raw or normalized — `mode=raw` ≈ whole config) to ANY authenticated session (viewer/auditor included); the R62 invariant ("snapshot texts config.download-gated; decrypt only on the privileged path; React masking is not an authorization boundary") was not enforced here; neither the R62 test nor doc covered this route | **FIXED + pinned** — route now `requirePermission(request, "config.download")` BEFORE any DB work (401/403, never a 404 oracle), denials audited `CONFIG_DIFF_DENIED` (mirroring the download route); intentional fail-closed consequence for viewer/auditor recorded; wire + source + role-matrix pins added |
| R69-F2 | P3 | `/api/v1/meta/users` `name: user.name ?? user.email` would expose a full email for null-name users (contradicting the route's own contract) | **FIXED + pinned** — fallback is the email local-part |
| R69-F3 | P3 | `gov-verify.ts` ruleset plane blind spots (four protective rule types unasserted) + header "first source wins" wording contradicting the both-required code + linear-history "advisory" mislabel | **FIXED + pinned** |
| R69-F4 | Cosmetic | ci.yml governance header still carried pre-R47 "runs gate + scan (+ e2e)" narrative | **FIXED + pinned** — names ALL FOUR jobs; marker line untouched |
| — | Recording | R52 ordering pins are textual, not behavioral (runtime order manually re-verified correct) | recorded; candidate future behavioral pins |
| — | Recording | HC-4 ledger semantics (823-candidate shrinking-ceiling ledger vs "small allowlist" framing) + parity figure 1419=1419 | corrected in roadmap R69 appendix |
| — | Recording | HC-1 headroom: `reports/run`, `devices/bulk` still on the 120/min pool | recorded as future headroom |

No other P1/P2/P3-authorable findings. Historical evidence documents are intentionally left untouched (snapshot discipline); corrections live here and in the roadmap's R69 path-correction appendix.

---

## 4. Remediation details (R69-F1 — the P1)

**Before:** `snapshots/diff/route.ts` — no import from `@/lib/auth/session`; GET resolved no actor; first DB work (`db.device.findUnique`) ran unauthenticated-adjacent; `decryptSnapshotTexts(fromSnap/toSnap)` unconditional; response rows carried full config text. Any session (viewer/auditor `*.read`) could read decrypted device configuration.

**After (mirror of the download route's certified pattern):**
1. `requirePermission(request, "config.download")` immediately after the INVALID_ID shape check (which precedes it only as a non-DB shape validation, matching the download route's ordering);
2. denial audited `CONFIG_DIFF_DENIED` (best-effort, denial response wins) with correlation `newCorrelationId("DF")`;
3. only then query parse → `db.device` → snapshots → decrypt → diff;
4. docstring records the R69 authorization contract.

**Role-matrix intent (pinned):** `config.download` held by admin (`*`), operator, engineer, manager → their diff dialogs keep working; auditor and viewer (`*.read` only) → 403 fail-closed, consistent with the raw download route's existing behavior toward them. UI permission-aware gating of the diff affordances is listed in NEXT-TASKS as optional polish (the server boundary is the authorization boundary).

**Pins:** `tests/audit/r69-roadmap-rereview-remediations.test.ts` — wire-level unauth 401-before-404 on the handler; source order (gate → first DB call → decrypts); no ungated decrypt path; role-matrix holder/non-holder assertions; meta/users fallback; gov-verify four rule types + header contract + label; ci.yml four-job narrative + marker + job-shape; roadmap appendix presence.

---

## 5. Gates (cold shell, 3-knob gate env — this round, post-remediation)

- `bun run lint` → **0 errors** (exit 0)
- `bunx tsc --noEmit` (src/ + worker) → **0 errors** (exit 0)
- `bun test tests/` → **997 pass / 18 skip / 0 fail** (8,354 expects, 64 files) — 986 → 997 (+11 pins: the R69 suite)
- Honest harness note: the first cold-shell run surfaced **one failure in the R69 pin itself** (the ci.yml job-id extraction regex also matched the `push:` trigger key) — fixed by anchoring extraction to the `jobs:` block only, then re-run to the green state recorded above. The battery is executed in the foreground (the sandbox reaps backgrounded process groups — both earlier background attempts died silently; recorded for the runbook).

## 6. LIVE verification (running topology, this round)

- `GET /api/v1/meta` (unauth) → **200** (bootstrap shape: vendors/sites/credentialProfiles only)
- worker `GET /health` → **200**
- unauth `POST /simulate/connect` → **401 `WORKER_UNAUTHENTICATED`** (fail-closed)
- unauth `GET /api/v1/devices/whatever/snapshots/diff` → **401** (proxy session plane) — and handler-level 401-before-404 proven by the R69 wire pin
- unauth `GET /api/v1/meta/users` → **401**
- HC-1 re-demo: unauth `POST /api/v1/ai/query` ×11 → 401×10 then **429** (`retry-after: 60`); `csv-import` ×6 → 401×5 then **429**

## 7. Conclusion

The roadmap's authorable content is **true in code, not merely in docs** — every phase re-verified at implementation level, every claim either confirmed or corrected in the same round. The single substantive discovery (R69-F1) closed the last known gap in the sensitive-read RBAC surface. The path to production is exactly the documented operator sequence: **plan upgrade → runner capacity → candidate PR (pull_request checks = HC-6) → `main` ruleset (four checks) → `gov-verify.ts main` = GOV-VERIFIED(0) → protective merge (squash OFF, 35-commit linear history) → LAB certification → release-SHA final re-audit.**

Evidence chain: this document · roadmap R69 appendix + ledger row · NEXT-TASKS updates · both worklogs · commit on `z_ai_v2` pushed to `origin/z_ai_v2`.
