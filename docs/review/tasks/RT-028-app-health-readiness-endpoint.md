# RT-028 — `/api/health` readiness endpoint (DB connectivity → 200/503) + probe switch

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-059 | A5-07 | P3 (main-agent decision: fix in Wave 1.5, S-M) | S-M | Medium — health-check semantics change: containers/drains now fail when the DB is unreachable (that is the point), so rollout notes matter |

## Problem & evidence

- `Dockerfile:123-124`, `deploy/oci/compose.yml:88`, `deploy/oci/health-check.sh:19-21` — every app probe is `fetch('http://127.0.0.1:3000/')` — the marketing root page.
- No `/api/health` route exists under `src/app/api` (verified in audit A5-07).

"Healthy" only proves the HTTP listener, not DB/auth wiring: the root page can 200 while the app is functionally down (pg_isready covers the DB PROCESS only, not the app's connection path). Worker is fine — its `/health` is a real liveness endpoint (`mini-services/worker/index.ts:137-147`).

## Impact

Deploy gates and Docker recovery act on a signal that cannot detect app-side DB failure; a broken app shows green.

## Root cause

Health plumbing was written against the only page that existed; a readiness route was never added.

## Required change

1. **New route `src/app/api/health/route.ts`** (readiness, NOT liveness):
   - `export const dynamic = "force-dynamic";`
   - `GET`: `await db.$queryRaw\`SELECT 1\`` (Prisma parameterized raw is the repo's allowed raw usage) with a short timeout guard (`AbortSignal`-style: wrap in `Promise.race` with a 3 s timer); on success → `NextResponse.json({ ok: true, service: "fayanms-app", db: "up", uptimeSec }, { status: 200 })`; on any failure → `{ ok: false, db: "down", error: "database unreachable" }` with **503**. Never include the DB URL, error text, or stack in the response (log server-side with a correlation id instead, mirroring RT-027's discipline).
   - Session/CSRF NOT required (probe endpoint); it lives OUTSIDE the `/api/v1` matcher so the proxy is unaffected. Rate limiting: untouched (probes are low-rate; document that in the route comment).
2. **Switch the probes** (three places):
   - `Dockerfile:123-124` HEALTHCHECK → `fetch('http://127.0.0.1:3000/api/health')`.
   - `deploy/oci/compose.yml:88` app healthcheck test → same URL.
   - `deploy/oci/health-check.sh:21` → `... fetch("http://127.0.0.1:3000/api/health"); process.exit(r.ok ? 0 : 1)` (r.ok is false on 503 — the gate then fails correctly).
3. Optional but recommended (cheap): ALSO probe it in `deploy/oci/deploy.sh` post-up gate if it pings `/` today (`rg -n "3000/" deploy/oci/deploy.sh`).
4. `tests/browser` / e2e boot code that waits on `/` for readiness (if any, `rg -n "localhost:3000/?\"" tests/e2e/ tests/browser/`) may keep using `/` — do NOT force-migrate e2e readiness waits in this RT (they want "server up", not "db up"); note the distinction in the PR.

## Tests to add

File: `tests/audit/rt028-health-readiness.test.ts` (DB-backed route test; env-fail-skip convention like other DB tests).

1. `healthy when db reachable` — with the local DB up → GET `/api/health` → 200 `{ ok: true, db: "up" }`.
2. `503 when db unreachable` — point DATABASE_URL at a dead port (subprocess/env-scoped) → 503 `{ ok: false, db: "down" }` (the negative case that justifies the whole RT).
3. `no internals in the failure body` — failure body contains no URL/host/PG error text (log-hygiene assertion on the response string).
4. `route is fast and uncached` — `dynamic = "force-dynamic"` present; response has `cache-control: no-store` (add the header in the route).
5. `probes point at the readiness route` — source assertions: Dockerfile, compose.yml, health-check.sh all reference `/api/health` (the contract that keeps them from drifting back).

## Acceptance criteria

- [ ] `/api/health` returns 200 only when the app can actually query PostgreSQL; 503 otherwise.
- [ ] No secrets/error text in the response; failure detail goes to logs.
- [ ] All three app probes (Dockerfile, compose, health-check.sh) use the readiness route.
- [ ] e2e/browser suites unaffected (they may keep using `/` for boot-wait).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt028-health-readiness.test.ts   # new suite green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
# Local smoke (DB up):
bun run dev & curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health   # 200
```

## Rollout & rollback notes

The semantics change (container restarts when DB access breaks) is the FEATURE — but stage it: merge the route first, flip probes in the same PR only after staging ran a day with the route deployed. Rollback = revert probe lines (route can stay). Caution: during a Postgres restart window the app container will now flap healthy/unhealthy — expected; compose `start_period: 30s` already absorbs short blips.


## Status

Fixed (0571878)
