# FayaNMS — R53 / HC-1 Evidence: Per-Endpoint Rate Budgets (2026-09-18)

**Increment:** HC-1 of the Production-Readiness Implementation Roadmap (`FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md`) — per-endpoint rate budgets for high-cost surfaces.
**Scope:** the carried CTRL-3 note closed — the AI LLM surfaces and the devices CSV import now draw their OWN tighter named budgets instead of the shared client-kind pools; every other route keeps the documented 300 GET / 120 mutation budgets byte-for-byte.

---

## 1. Design

- **Registry** (`src/lib/api/rate-gate.ts`): `resolveNamedRouteBudget(pathname)` maps a route family to its budget —
  - `/api/v1/ai/*` (prefix, trailing-slash anchored) → family `ai`, **10/min** (`RATE_LIMIT_AI`);
  - `/api/v1/devices/csv-import` (EXACT match) → family `devices:csv-import`, **5/min** (`RATE_LIMIT_CSV_IMPORT`);
  - anything else → `null` (documented client-kind budgets apply unchanged).
- **Semantics:** family match is method-agnostic (the ceiling governs the whole family — cheap traffic cannot ride a family it does not belong to); a matching request draws its slot from the family's OWN bucket (`${ip}:route:${family}`) so the shared `get`/`mutation` pools are untouched by high-cost traffic; non-matching requests behave exactly as before (bucket `${ip}:${kind}`).
- **Wiring:** the proxy is the single pre-handler enforcement point (SAFE-002) and now passes `pathname` through: `takeRateSlot(clientKey, kind, Date.now(), pathname)` (`src/proxy.ts`, rate-gate step). The legacy 2-arg/3-arg `takeRateSlot` signatures are unchanged — zero behavioral drift for every non-HC-1 caller.
- **429 envelope:** unchanged — `RATE_LIMITED` body + `Retry-After` + `X-Request-Id` headers, Retry-After derived from the sliding window of the family's own budget (≤60 s).

## 2. Regression pins (11 NEW in `tests/audit/rate-gate.test.ts`)

1. Budget-table literals: `RATE_LIMIT_AI === 10`, `RATE_LIMIT_CSV_IMPORT === 5`.
2. Registry: all four AI routes (`query`, `assist`, `change-draft`, `rca-draft`) → `{family:"ai", limit:10}`.
3. Registry: csv-import matches EXACTLY — `/api/v1/devices`, `/api/v1/devices/csv-export`, `/api/v1/devices/csv-import/review`, `/api/v1/devices/dev-1` all `null`.
4. Registry prefix discipline: `/api/v1/ai`, `/api/v1/aiques`, `/api/v1/aidevices`, `/api/v1/devices`, `/api/v1/meta` all `null` (sibling names can never collide).
5. Decision: ai family — 10 pass, 11th limited, sane Retry-After (1..60).
6. Decision isolation: exhausted ai bucket leaves the SAME client's plain mutation pool AND the csv-import family untouched.
7. Decision: csv-import — 5 pass, 6th limited, sane Retry-After.
8. Documented default: no pathname → legacy semantics; unknown route consumes the DEFAULT mutation bucket (120), not a named one.
9. Proxy wiring source pin: `takeRateSlot(clientKey, kind, Date.now(), pathname)` present in `src/proxy.ts`.
10. Proxy end-to-end: 11 rapid unauth POSTs on `/api/v1/ai/query` → exactly ten 401s + ONE 429 (`RATE_LIMITED`, `Retry-After` ≤ 60) — proving the named budget fires pre-auth, pre-handler.
11. Proxy end-to-end: exhausting the ai budget never throttles other routes for the same client (devices POST still reaches the session plane → 401, not 429).

## 3. Gates (CI env shape, `.env` stash/restore + exported CI secret set)

- lint **0** · tsc `--noEmit` full **0** · suite **905 pass / 18 skip / 0 fail** (894 → 905, +11 HC-1 pins), **4,979 expects, 52 files**, 3.80 s.
- Protocol note re-confirmed: the three SAFE-002 service-JWT pins fail OUTSIDE the CI env shape (local EdDSA keys auto-loaded → `SERVICE_ALG_REJECTED`) and pass with the CI secret set exported — environment shape, not code.

## 4. LIVE wire demonstration (deployed stack)

| Probe | Expected | Observed |
|---|---|---|
| 10 × unauth POST `/api/v1/ai/query` | 401 each (each consumes an ai slot; limiter fires BEFORE the session check) | `401 ×10` ✅ |
| 11th unauth POST `/api/v1/ai/query` | 429 from the ai budget | **`429 Too Many Requests`**, `retry-after: 60`, `x-request-id` present, body `RATE_LIMITED` "retry in 60s" ✅ |
| 5 × unauth POST `/api/v1/devices/csv-import` | 401 each | `401 ×5` ✅ |
| 6th unauth POST `/api/v1/devices/csv-import` | 429 from its own budget | **`429`**, body `RATE_LIMITED` ✅ |
| GET `/api/v1/meta` (while ai exhausted) | 200 — normal calls unaffected | **200** ✅ |
| POST `/api/v1/devices` (while ai exhausted) | 401 (session envelope) — NOT 429 | **401** ✅ |

Browser sanity pass (admin session over the modified proxy): sign-in → shell renders, authenticated `GET /api/v1/devices?pageSize=5` → 200 with 5 devices, **0 console errors**. Screenshot: `agent-ctx/verify-r53-hc1-shell.png`.

## 5. Documentation updated

- `docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md` — both SAFE-002 mentions now document the HC-1 named budgets (ai 10/min, csv-import 5/min) alongside the unchanged 120/300 client-kind budgets.
- `src/lib/api/rate-gate.ts` module contract — HC-1 paragraph (registry semantics, method-agnostic family ceiling, single enforcement point unchanged).

## 6. Honest scope

- Budgets are per client-key (per process, in-memory default; the postgres shared store option inherits the named buckets via the same `hit()` interface — fleet-wide when opted in). The gate remains a hardening gate, not an abuse-proof quota (unchanged posture).
- Machine-plane service JWTs remain exempt from ALL budgets (pre-existing design, unchanged).
- The 60 s demo windows exhaust the shared `local` ai/csv buckets transiently on the sandbox stack (single-host dev topology — direct access has no XFF → one shared key); production deployments key per client IP.
