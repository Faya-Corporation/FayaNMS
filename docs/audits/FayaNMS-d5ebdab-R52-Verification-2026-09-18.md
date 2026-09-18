# FayaNMS — R52 Increment Verification Report (commit `d5ebdab`)

**Date:** 2026-09-18
**Scope:** Independent verification of the R52 full end-to-end production re-audit + remediation increment (commit `d5ebdab` on branch `z_ai_v2`) — every remediation claim re-derived from the tree, all gates reproduced in the CI environment shape, and the deployed stack exercised live (HTTP wire + browser) for behavioral proof of the F-N1 auth-ordering fix.
**Method:** fresh read-only derivation (no reliance on the increment's own prose), full gate battery with `.env` stashed/restored per the CI-shape protocol, unauth/authed × real/nonexistent wire matrix on all three AI routes, browser session + console/mobile checks.
**Upload note:** `upload/` empty at session start; per protocol the standing instruction ("read and audit and append then start") defined the task — independently verify the latest landed increment `d5ebdab` (R52).

---

## 1. Verdict

**PASS — the R52 increment is verified true on the audited tree.** Every claim in the R52 increment (commit message, NEXT-TASKS LANDED block, repo worklog) reproduced exactly:

| Claim | Expected | Observed | Verdict |
|---|---|---|---|
| Tree fingerprint | `z_ai_v2` @ `d5ebdab`, clean, pushed | `git status` clean; HEAD == `origin/z_ai_v2` @ `d5ebdab` | ✅ |
| Gate: lint | 0 issues | 0 issues (eslint clean exit) | ✅ |
| Gate: tsc full | 0 errors | 0 errors (exit 0) | ✅ |
| Gate: suite | 894 pass / 18 skip / 0 fail, 4,800 expects, 52 files | **894 / 18 / 0, 4,800 expects, 52 files** (4.37 s) | ✅ exact |
| R52-F-N1 (P3): actor-before-DB on the 3 AI routes | `resolveActingUser` hoisted above ALL DB work | verified statically (§3.1) AND on the live wire (§4.1/§4.2) | ✅ |
| R52-F-N2: stale comments corrected | auth route → `src/proxy.ts`; meta.users → alert assign/suppress picker | `route.ts:11`, `meta/route.ts:21-22` | ✅ |
| R52-H1: dead view deleted | `credentials-view.tsx` absent; router mounts AdminCredentialsView only | file gone; `view-router.tsx:7` imports `admin-credentials-view` only | ✅ |
| R52-H2: dep surface shrunk | 9 unused runtime deps removed; socket.io pair → devDeps; zero source imports | package.json + source grep (§3.3) | ✅ |
| R52-H3: Json-rule discipline | `LoginGuardState.failures` is the ONLY Json column; exception documented | `schema.prisma:1121` + `:16` "SINGLE SANCTIONED EXCEPTION" | ✅ |
| r52 pin suite | 10 test blocks | exactly 10 `test()` blocks in `tests/audit/r52-auth-ordering.test.ts` | ✅ |

---

## 2. Environment at verification time

- Branch `z_ai_v2` @ `d5ebdab` ("audit(R52): full end-to-end production re-audit 2026-09-18 — PASS, zero P1/P2; F-N1 auth-ordering + hygiene set remediated; production-readiness roadmap authored"); working tree clean; HEAD identical to `origin/z_ai_v2`.
- Deployed stack: app :3000 (200), worker :3030 (`bun --hot`, health `ok`), embedded PostgreSQL :5433 — all healthy for the duration of the session.
- Gates run in the CI env shape (`ci.yml:91-96`): `.env` and `mini-services/worker/.env` stashed to `*.ci-stash` for the battery, restored immediately after — no local EdDSA keys auto-loaded, matching the CI secret set exactly.

## 3. Static verification (file:line re-derivation)

### 3.1 R52-F-N1 — actor resolved BEFORE any DB work on every AI route ✅

- **`ai/assist`** (`src/app/api/v1/ai/assist/route.ts`): the R52-F-N1 guard comment at `:66-70`, `const actor = await resolveActingUser(request)` at `:71`, the 401 return at `:72-74`; the first DB touch (`buildDeviceContext(id)`) at `:86`. Actor precedes DB.
- **`ai/change-draft`** (`src/app/api/v1/ai/change-draft/route.ts`): comment `:171`, actor `:173`, first DB touch (`db.device.findMany`) `:179`.
- **`ai/rca-draft`** (`src/app/api/v1/ai/rca-draft/route.ts`): comment `:116`, actor `:118`, first DB touch (`db.incident.findUnique`) `:123`.
- **`ai/query`** (regression guard): within the POST handler slice, actor (`:18` relative) precedes `db.site.findMany` (`:25` relative) — the pre-existing correct ordering held.
- **Exactly-once resolution:** each of the four routes contains exactly one `resolveActingUser(request)` (suite-pinned; grep-confirmed).
- **Pin suite:** `tests/audit/r52-auth-ordering.test.ts` — exactly 10 `test()` blocks: 3 per-route hoisting pins, 1 exactly-once pin, 1 ai/query POST-slice regression guard, 1 dead-view pin, 2 dependency-surface pins, 2 schema-discipline pins. All pass in the reproduced suite.

### 3.2 R52-F-N2 — stale comments corrected ✅

- `src/app/api/auth/[...nextauth]/route.ts:11`: comment now points at `src/proxy.ts` as the `/api/v1` enforcement surface (Next 16 proxy).
- `src/app/api/v1/meta/route.ts:21-22`: `users` documented as the alert assign/suppress picker consumer (id/name/role + email local-part username-style key).

### 3.3 R52-H2 — runtime dependency surface shrunk ✅

- `package.json`: the nine packages (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `@mdxeditor/editor`, `@reactuses/core`, `@tanstack/react-table`, `react-markdown`, `react-syntax-highlighter`, `uuid`) absent from BOTH `dependencies` and `devDependencies`; `socket.io` + `socket.io-client` present at `:94-95` inside `devDependencies` only.
- Source tree grep (`src/` + `mini-services/`): **zero** imports of any removed package — verified no dead references remain.
- `bun.lock` regenerated (539 lines removed in the diff), consistent with the shrunk dep surface.

### 3.4 R52-H3 — schema Json-rule discipline ✅

- `prisma/schema.prisma:1121`: `failures Json @default("[]")` (LoginGuardState) — the single non-comment `Json` column in the schema.
- `prisma/schema.prisma:16`: the header rule now names the "SINGLE SANCTIONED EXCEPTION (R52, Full E2E ReAudit 2026-09-18)" explicitly, with the governance note that every future Json use requires the same explicit decision.

### 3.5 R52-H1 — dead view removed ✅

- `src/components/views/credentials-view.tsx` does not exist; a repo-wide grep for `credentials-view` yields only `src/components/shell/view-router.tsx:7` importing `AdminCredentialsView` from `@/components/views/admin-credentials-view` (the live admin variant).

## 4. Live verification (deployed stack)

### 4.1 F-N1 on the wire — the existence oracle is closed ✅

Unauthenticated POSTs with a **nonexistent** target id (`definitely-not-a-real-device-id-999`) — pre-fix these leaked a `404 DEVICE_NOT_FOUND`-style oracle; post-fix every route answers with the actor gate first:

| Route | Unauth + nonexistent target | Observed |
|---|---|---|
| `POST /api/v1/ai/assist` | must 401 BEFORE device lookup | `401 UNAUTHENTICATED` ✅ |
| `POST /api/v1/ai/change-draft` | must 401 BEFORE inventory snapshot | `401 UNAUTHENTICATED` ✅ |
| `POST /api/v1/ai/rca-draft` | must 401 BEFORE incident lookup | `401 UNAUTHENTICATED` ✅ |

### 4.2 F-N1 authenticated complement + positive path ✅

Browser-signed-in admin session (`admin@faya.local`), fetch from page context:

- **`ai/assist` + nonexistent device** → `404 DEVICE_NOT_FOUND` — the authenticated path now legitimately reaches the device lookup (the two halves together prove the ordering: 401 unauth / 404 authed for the SAME body).
- **`ai/assist` + real device** (`dev-br1-edge-rtr-01`) → `200` with `{answer, correlationId: "AI-Z9K8NC", contextSummary}` — the answer cites live device state ("CPU utilization at 39.2%"), contextSummary.alertsConsidered = 1: full context-build → LLM → audit path healthy.
- **`ai/rca-draft` + nonexistent incident** → `404 INCIDENT_NOT_FOUND` (post-auth lookup reached; same ordering semantics).
- **Bonus incidental:** `ai/rca-draft` with a wrong body shape → `400 INVALID_BODY` (zod contract enforced on the wire).

### 4.3 Browser + viewport hygiene ✅

- Admin sign-in → operator shell renders with live data (31 devices listed via `/api/v1/devices?pageSize=100`).
- **0 console errors** on the exercised pages.
- Mobile 390×844: `document.documentElement.scrollWidth > clientWidth` → **false** (no horizontal scroll). Screenshots: `agent-ctx/verify-r52ver-ai-assist-200.png`, `agent-ctx/verify-r52ver-mobile-390.png`.

### 4.4 Stack health after verification ✅

- Worker `/health`: `{"ok":true, jobs:{claimed:305, completed:305, failed:0, running:0}, consecutiveClaimFailures:0}`.
- App `/` → 200; unauthenticated `GET /api/v1/meta` → live bootstrap payload.

## 5. Honest scope

- `build:gate` remains sandbox-OOM-blocked (unchanged from R51 verification); compile-plane evidence is `tsc --noEmit` full 0 + the full suite in CI shape.
- The wire matrix exercises the ordering semantics (401-before-lookup / authed-lookup-reached); a half-authenticated JWT (deactivated user with live session) cannot be minted in the sandbox without modifying auth data, so that specific actor variant is covered by the hermetic suite pins (ordering + exactly-once) rather than a live dial — the ordering code path is identical for both unauth and deactivated outcomes (`resolveActingUser` → null → 401).
- Owner-side blockers unchanged and outside sandbox control: OWNER-CI-001 (Actions runner capacity), OWNER-GOV-001 (branch protection), R50-T090..T092 / LAB-FUNC-001 / LAB-CERT-HW-001 (real-device certification). The authorable queue (Phase HC-1..HC-6) in the Production-Readiness Implementation Roadmap remains the forward path.

## 6. Verdict statement

The R52 increment (`d5ebdab`) is **independently verified PASS**: every gate number reproduces exactly, every remediation claim re-derives from the tree at file:line precision, and the F-N1 auth-ordering fix is proven behaviorally on the live wire in both directions (unauth 401 pre-lookup; authed post-auth lookup with real-LLM positive path). No regressions observed; the execution backlog remains empty of sandbox-authorable items outside the documented Phase HC queue.
