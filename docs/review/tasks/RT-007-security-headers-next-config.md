# RT-007 — Security headers at the app layer (next.config.ts headers())

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-009 | A1-02 | P2 | S | Low-Medium — an overly strict CSP could break the app's inline scripts/styles; header set must mirror the proven Caddy TLS profile |

## Problem & evidence

- `next.config.ts:3-12` — `const nextConfig: NextConfig = { output: "standalone", typescript: {...}, reactStrictMode: true }` — **no `headers()` block**.
- Security headers exist only in the OPTIONAL TLS Caddy profiles: `deploy/oci/Caddyfile:4-11` (HSTS, nosniff, Referrer-Policy, Permissions-Policy, CSP, `-Server`) and `docs/deploy/Caddyfile.tls:25-30` (subset). The sandbox gateway Caddyfile (lines 17-37) sets none; the base compose profile publishes plain :80.

Result: on the base profile (and any direct-to-app path) the app serves with zero security headers — no CSP/frame-ancestors (clickjacking), no nosniff, no Referrer-Policy — and plain-80 deployments ship a non-Secure `SameSite=Lax` session cookie (the `__Secure-` prefix only applies on https origins).

## Impact

Clickjacking / MIME-sniffing / referrer leakage on every deployment that does not enable the TLS Caddy profile; header posture depends on ingress choice instead of being intrinsic to the app.

## Root cause

Headers were delegated to the edge (single-owner principle in the TLS profile) but never made intrinsic at the app layer; `next.config.ts` never grew a `headers()` block.

## Required change

1. **`next.config.ts`** — add an `async headers()` block returning one source for `path: "/:path*"` with exactly the header set proven in `deploy/oci/Caddyfile:4-11`:
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
   - `Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https: wss:; upgrade-insecure-requests` — copy the Caddy value VERBATIM (it was tuned for this app: Next injects inline scripts; Recharts/next-intl need the current allowances). Do NOT add HSTS here — HSTS on plain-HTTP origins is ignored/misleading and the TLS Caddy profile keeps single ownership (document this in a comment, mirroring the Caddyfile's ownership note).
   - `X-Frame-Options: DENY` is redundant with `frame-ancestors 'none'` — omit it to keep one owner per directive.
2. Keep `deploy/oci/Caddyfile` as belt-and-braces (unchanged); add one comment line in each Caddyfile noting the app now also sets the set (so a future editor knows both exist).
3. Note in the RT/PR: `upgrade-insecure-requests` under plain-80 can force https subresource loads — this is already shipped to real browsers via the Caddy TLS profile, so behavior parity is expected; if the browser-e2e suite (`tests/browser/`) flags a plain-80 regression, scope the CSP header to be set only when `process.env.NODE_ENV === "production"`... do NOT silently drop headers; instead raise it in review (flagged here as the one known risk).

## Tests to add

File: `tests/audit/rt007-security-headers.test.ts` (config-shape test, style of `tests/audit/deploy-hardening.test.ts`).

1. `next.config defines a headers() block for all paths` — import/read `next.config.ts`, assert `headers` is defined and the single source covers `/:path*`.
2. `header set matches the TLS Caddy profile` — assert the exact CSP string equals the value in `deploy/oci/Caddyfile` (keeps the two owners in lockstep; a divergence fails the test with a message pointing at this RT).
3. `no HSTS at the app layer` — negative case: assert `Strict-Transport-Security` is NOT in the app header list (single-owner rule).
4. `frame-ancestors none present` — clickjacking guard asserted.

## Acceptance criteria

- [ ] Every deployment (base compose, sandbox gateway, direct app) serves CSP, nosniff, Referrer-Policy, Permissions-Policy.
- [ ] CSP value is byte-identical to `deploy/oci/Caddyfile` (single proven policy, two layers).
- [ ] HSTS remains edge-owned only.
- [ ] Browser journeys (`tests/browser/`) pass against the dev/prod server with the headers on.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt007-security-headers.test.ts   # new suite green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
# Manual: bun run build:gate && bun run start; then
curl -sI http://localhost:3000/ | grep -i content-security-policy   # header present
```

## Rollout & rollback notes

Revert = delete the `headers()` block. The only realistic breakage is CSP too strict for a newly added third-party origin — the fix is to extend the CSP in BOTH next.config.ts and deploy/oci/Caddyfile together (the test pins them equal). No DB/API impact.
