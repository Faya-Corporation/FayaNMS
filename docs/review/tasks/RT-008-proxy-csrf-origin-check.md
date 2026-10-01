# RT-008 — Origin/Sec-Fetch-Site check for session-plane mutations (CSRF defense-in-depth)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-010 | A1-03 | P2 | S | Low-Medium — must not break same-origin fetches (app shell, TanStack Query mutations) or the API-client plane |

## Problem & evidence

`src/proxy.ts:193-209` — session-plane mutations are validated by the NextAuth cookie JWT only: `token = await getToken({...})` … `if (token.role === "auditor" && req.method !== "GET" && ...)`. Grep across `src/`: zero Origin/Referer/Sec-Fetch-Site/CSRF-token checks anywhere.

Cookie sessions rely solely on NextAuth v4's default `SameSite=Lax`. Modern browsers are covered; legacy/embedded browsers and any future cookie-policy regression (SameSite=None) would expose every mutating `/api/v1` endpoint to cross-site requests.

## Impact

Defense-in-depth gap on the whole mutation plane; no second factor behind the cookie policy.

## Root cause

The proxy (which already has the request in hand for every `/api/v1` call) never validates request origin; no CSRF token layer exists.

## Required change

1. **`src/proxy.ts`** — add a session-plane mutation check AFTER the session token resolves (i.e., only for requests authenticated by cookie; runs at step 4, before the auditor role check), gated to mutating methods:
   ```ts
   const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
   if (token && MUTATING.has(req.method)) {
     // API-client bearer plane already returned above (step 3b) — anything
     // reaching here with a mutation is cookie-session traffic.
     const site = req.headers.get("sec-fetch-site");
     const origin = req.headers.get("origin");
     const host = req.headers.get("host");
     const crossSite =
       (site !== null && site !== "same-origin" && site !== "none") ||
       (site === null && origin !== null && host !== null &&
         new URL(origin).host !== host);
     if (crossSite) return NextResponse.json(CSRF_REJECTED_BODY, { status: 403 });
   }
   ```
   Semantics (fail-open only where the browser gave us nothing at all — a request with neither `Sec-Fetch-Site` nor `Origin` is a non-browser client and cannot carry the cookie cross-site in practice; document this in a comment):
   - `sec-fetch-site: same-origin | none` → allow; `cross-site`/`same-site` → 403 (same-site is NOT safe enough — sibling-subdomain risk; note this in the comment).
   - No Sec-Fetch-Site but `Origin` present → compare `Origin` host to `Host` (NextAuth itself uses the origin check pattern); mismatch → 403.
   - Neither header → allow (non-browser client; cookie exfil is the only path and SameSite still guards it).
2. New constant `CSRF_REJECTED_BODY` with envelope `{ success: false, error: { code: "CSRF_ORIGIN_REJECTED", message: "Cross-site mutation rejected." } }` (matches the file's existing body constants).
3. Machine plane is untouched (verified service JWTs returned at step 1) and the public bootstrap surfaces (`/api/v1/meta`, `/api/v1/auth/*`) are untouched (they pass at step 3a; `/api/v1/auth/*` mutations are NextAuth's own CSRF-protected endpoints). Document this ordering in the header comment's evaluation-order list (insert as step 4, renumber the rest).
4. **`docs/security/authorization-matrix.md`** — add one row/paragraph documenting the Origin/Sec-Fetch-Site control (the audit cites §5 as the contract home).

## Tests to add

File: `tests/auth/csrf-origin-proxy.test.ts` (proxy unit test — invoke the exported `proxy(req)` with crafted `NextRequest`s and a mocked `getToken`; follow the mocking pattern used by `tests/auth/authorization-contract.test.ts` for proxy-level cases).

1. `same-origin mutation passes` — POST with `sec-fetch-site: same-origin` + valid session → `NextResponse.next()`.
2. `cross-site mutation rejected with 403` — POST with `sec-fetch-site: cross-site` → 403 `CSRF_ORIGIN_REJECTED` (the negative case).
3. `same-site mutation rejected` — POST with `sec-fetch-site: same-site` → 403 (documented strictness).
4. `origin/host mismatch rejected when no sec-fetch-site` — POST with `Origin: https://evil.example`, `Host: app.local` → 403.
5. `headerless non-browser client allowed` — POST with neither header → passes (documented fail-open branch).
6. `reads unaffected` — GET cross-site still passes the proxy (reads are cookie-carried but non-mutating) — asserts scope is mutations only.
7. `api-client bearer mutations unaffected` — POST with opaque bearer (step 3b) returns before the CSRF check → allowed.
8. `machine plane unaffected` — POST with verified service JWT → allowed regardless of headers.

## Acceptance criteria

- [ ] Every cookie-session mutation on `/api/v1` carries a server-side Origin/Sec-Fetch-Site validation; cross-site is 403 with a typed code.
- [ ] Same-origin app traffic (all TanStack Query mutations) unaffected — browser journeys pass.
- [ ] Machine plane, API-client plane and auth bootstrap routes untouched.
- [ ] Authorization matrix documents the control.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/auth/csrf-origin-proxy.test.ts          # new suite green
bun test tests/auth/                                    # auth suites green
bun test tests/                                         # no regressions
node_modules/typescript/bin/tsc --noEmit                # exit 0
bun run lint                                            # 0 errors
```

## Rollout & rollback notes

Middleware-only; revert = remove the block. Riskiest interaction is a legitimate same-site deployment topology (app behind a different-site reverse-proxy host) — if a valid deployment trips it, the short-term mitigation is setting `Sec-Fetch-Site`-compatible ingress or reverting the block; watch `CSRF_ORIGIN_REJECTED` volume in logs after rollout.
