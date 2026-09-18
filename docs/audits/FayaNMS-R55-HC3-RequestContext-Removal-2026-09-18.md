# FayaNMS — R55 / HC-3: Deprecated `RequestContext` removal (mechanical)

**Date:** 2026-09-18 · **Branch:** `z_ai_v2` · **Base:** `49d33f3` (R54/HC-2) · **Roadmap item:** Phase HC-3

## 1. What the debt was

The SAFE-002 remediation moved rate limiting pre-handler into the proxy plane
(`src/proxy.ts` → `src/lib/api/rate-gate.ts`). The envelope builders in
`src/app/api/v1/_lib/api.ts` (`ok` / `fail` / `failWithMeta` / `failWithDetail`)
kept a trailing `RequestContext` argument — at that point dead weight kept "so
existing call sites compile": `requestContext(request)` was plumbed through
**40 route files (~100 references)** as a 4th/5th trailing arg, an own-line
trailing arg in multi-line calls, or via a `const ctx = requestContext(request)`
indirection passed onward. `api.ts` carried a `@deprecated` block ending with
*"Mechanical removal of the ~50 call sites is tracked as backlog."*

## 2. What changed

- **`src/app/api/v1/_lib/api.ts`**
  - `ok` / `fail` / `failWithMeta` / `failWithDetail`: the `_ctx?: RequestContext`
    parameter is REMOVED — future accidental use is a compile error.
  - `RequestContext` (interface) + `requestContext()` remain **exported as an
    inert no-op compat shim** for external consumers, per the roadmap test spec
    ("exported but no longer referenced outside `api.ts` internals"). The debt
    comment is RETIRED and replaced by the HC-3/R55 retirement record pointing
    at the enforcement pins.
- **40 route files** (all of `src/app/api/v1/**/route.ts` that referenced the
  shim): imports cleaned, every trailing-arg and `const ctx` indirection
  removed — net **−127 lines** (186 insertions / 313 deletions over the pass).
  Deliberately untouched (their `ctx` is unrelated): NextAuth route context
  (`[...nextauth]/route.ts`), zod `superRefine` contexts (`change-wizard.tsx`,
  `device-form-sheet.tsx`, `metrics/retention/route.ts`), login-guard
  `AtomicMutateContext` plumbing (`lib/auth/login-guard.ts`).
- **`README.md`** §Conventions: stale envelope description corrected —
  `{ success, data, meta, requestContext }` → `{ success, data, meta }` with
  `meta.requestId` + `X-Request-Id` (the envelope has not carried a
  `requestContext` key since SAFE-002).
- **`src/app/api/v1/firmware/route.ts`** doc comment: prose mention reworded so
  the zero-reference sweep stays machine-exact.

### Codemod discipline (honest engineering note)

The pass was script-driven (`tool-results/hc3-codemod.mjs`, gitignored). The
first cut had two bugs caught and fixed BEFORE anything was committed:

1. a `\bctx\b` pre-filter reached files whose `ctx` is NOT the shim's → 5
   unrelated files were reverted out of the pass (see the untouched list above);
2. the import-cleanup regex ran globally and corrupted inline call sites
   (`200, requestContext(request)` → `200(request)`) — the tree was fully
   reverted (`git checkout -- src/`) and the codemod re-ordered: inline-arg
   regexes first, `ctx` pass gated on a real `const ctx = requestContext`
   declaration, import cleanup scoped to import blocks, blank-line import
   artifacts collapsed. The final tree was verified by `rg` (zero shim tokens
   outside the shim file), full `tsc`, and the complete suite before staging.

## 3. Pins — `tests/audit/r55-requestcontext-removal.test.ts` (12 NEW)

| # | Pin |
|---|-----|
| 1 | shim stays exported (`export interface RequestContext` + `export function requestContext(...)`) |
| 2 | helper is an inert no-op — returns `{}` with and without a request |
| 3 | debt comment retired: no "tracked as backlog" / "Mechanical removal" / `@deprecated` / `_ctx` in api.ts; "HC-3 (R55)" stamp present |
| 4 | sweep: NO file under `src/` except `_lib/api.ts` contains `requestContext`/`RequestContext` (walk sanity-guarded: >50 files must be seen) |
| 5 | sweep: `_ctx` appears nowhere in `src/` |
| 6 | representative import proof: devices route imports the helpers without the shim |
| 7 | `ok()` unit: 200, `{ success, data, meta.requestId }`, header === meta.requestId |
| 8 | `ok()` unit: meta merge + custom 201 status unchanged |
| 9 | `fail()` unit: error envelope `{ success:false, error:{code,message}, meta.requestId }` + header |
| 10 | `failWithMeta` / `failWithDetail` keep extra payloads (contractVersion / detail) |
| 11 | WIRE: devices POST unparseable body → handler-level 400 `INVALID_BODY` with UUID requestId + header equality (fail() with zero context) |
| 12 | WIRE: devices GET on the real CI DB → 200 `ok()` envelope, 20 rows, UUID requestId + header equality |

## 4. Gates (CI env shape: `.env` stashed + full CI secret set exported)

- `bun run lint` → **0 findings**
- `bunx tsc --noEmit` (FULL) → **0 errors**
- `bun test` → **927 pass / 18 skip / 0 fail** (5,051 expects, 54 files, 4.31 s)
  — 915 → 927 (+12)

## 5. LIVE verification (browser + wire)

| Check | Result |
|---|---|
| Sign-in (admin demo) → shell | OK, session cookie set |
| Authed `GET /api/v1/devices` | 200, envelope `{ success, data[20], meta{page,pageSize,total,totalPages,sort,dir,requestId} }`; `x-request-id` header === `meta.requestId` — `ok()` stamps identically with zero per-call context |
| Authed `GET /api/v1/meta/users` | 200, `data: { users: [5] }` (R54 split surface intact), requestId stamped |
| Unauth `POST /api/v1/devices` | 401 `UNAUTHENTICATED` (auth-error envelope unchanged) |
| Exempt `GET /api/v1/meta` | 200 + `x-request-id` header |
| E2E assign journey | Alerts view → row actions → **Assign…** → combobox renders ALL 5 users from `/api/v1/meta/users` → selected `Yousef Ghalib · NOC Operator` → submit → toast *"Alert assigned — the owner now shows on the stream row"* |
| Console / page errors | **0 / 0** |
| Mobile 390×844 | no horizontal overflow (`scrollWidth <= innerWidth` → true) |
| Worker loop | claim/complete 200s flowing in dev.log throughout |

Screenshots: `agent-ctx/verify-r55-hc3-alerts-assigned.png`,
`agent-ctx/verify-r55-hc3-mobile-390.png`.

## 6. Honest scope

- The shim remains exported **by design** (roadmap test spec) — it is inert,
  unreferenced, and machine-pinned so it cannot silently grow callers; a future
  major can delete it in one commit with pin #1 flipped.
- The 5 historical cumulative FAILED job rows in the long-lived CI DB predate
  this round (fault-injection drills from earlier programs); the live worker
  loop shows only successful claim/complete cycles in dev.log.
- The auth-error 401 envelope (no `meta.requestId`) is pre-existing behavior of
  the session-error path (`authErrorToFail`), unchanged by this pass — noted,
  not silently "fixed".
- Acceptance from the roadmap is met verbatim: zero `_ctx` params in route
  handlers · tsc + full suite green · `api.ts` debt comment retired.
