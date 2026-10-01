# RT-023 — Remove (or gate) the unauthenticated `/api` "Hello, world!" stub

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-035 | A1-12 | P3 | S | Low — dead route removal; one test may reference it |

## Problem & evidence

`src/app/api/route.ts` (entire file, 5 lines):
```ts
import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ message: "Hello, world!" });
}
```
Unauthenticated stub OUTSIDE the `/api/v1` proxy gate (matcher is `/api/v1/:path*`, `src/proxy.ts:212-216`). No sensitive data, but it is dead attack surface that shows up in external scans, and it is the only handler in the repo with zero auth/rate-limit/envelope discipline.

## Impact

Attack-surface noise; inconsistent API discipline on a public path.

## Root cause

Scaffold leftover never deleted.

## Required change

1. Delete `src/app/api/route.ts` (preferred — the audit's primary suggestion: "Delete the route (or fold into /api/health with an explicit allowlist)").
2. Check for references first: `rg -rn "Hello, world" src/ tests/ docs/ scripts/` and `rg -n "'/api'" src/ tests/ scripts/` — remove/update any test or doc that pings `/api` (there is likely at least one smoke/probe reference; do NOT repoint anything to a deleted path).
3. Do NOT create `/api/health` here — that is RT-028 (F-059/A5-07), a separate scope with its own contract. If RT-028 lands first and wants a parent-route ping, it owns the file creation, not this RT.

## Tests to add

File: `tests/audit/rt023-hello-stub-removed.test.ts` (source police + e2e-style negative).

1. `stub route file is gone` — assert `src/app/api/route.ts` does not exist.
2. `no references remain` — grep-based: `"Hello, world"` appears nowhere in `src/`, `tests/`, `docs/` (update any stragglers this RT touches).
3. `GET /api answers 404` — negative case: e2e-server fetch of `/api` (reuse `tests/e2e/e2e-server.ts` boot if cheap, else a prod-build smoke note) → 404, not JSON hello.

## Acceptance criteria

- [ ] `src/app/api/route.ts` deleted; zero repo references to the stub.
- [ ] Nothing regressed (no client code fetched `/api` — verified by grep + e2e suite).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt023-hello-stub-removed.test.ts   # new suite green
bun test tests/                                          # no regressions
node_modules/typescript/bin/tsc --noEmit                 # exit 0
bun run lint                                             # 0 errors
```

## Rollout & rollback notes

Trivial revert (restore one file). If an unknown external script scraped `/api` for liveness, it must move to `/api/health` once RT-028 lands — note in the PR body.


## Status

Fixed (867e3c1)
