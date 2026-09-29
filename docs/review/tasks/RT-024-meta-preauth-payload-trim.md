# RT-024 — Trim the pre-auth `/api/v1/meta` payload (credential profiles + sites behind session)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-028 | A1-05 | P3 | S | Medium — removing fields from a public payload can break the sign-in flow IF any pre-auth consumer exists; the RT mandates a verification step first |

## Problem & evidence

`src/app/api/v1/meta/route.ts:25-47` — the SESSION-EXEMPT bootstrap route (proxy exact-match exemption, `src/proxy.ts:155`) returns:
- `db.credentialProfile.findMany({ select: { id, name, type } })` (lines 35-39) — unauthenticated callers can enumerate credential-profile names/types ("Network Admin — SSH password" style = recon material),
- `db.site.findMany({ select: { id, name, code } })` (lines 31-34) — full site inventory (id/name/code).

Documented as reviewed (R51-A2 removed usernames) but names+types still leak. R54 already split the user directory out to the authenticated `/api/v1/meta/users` (`src/app/api/v1/meta/users/route.ts`) — this RT finishes the job for the remaining sensitive blocks.

**Pre-auth usage verification (MANDATORY first step, binding):** grep every consumer of `useMeta()` (`rg -n "useMeta\(" src/`) and any raw `apiFetch("/api/v1/meta")`: as of this writing all consumers (`alert-rules-panel.tsx:169`, `device-form-sheet.tsx:486`, `maintenance-view.tsx:195,478`, `devices-view.tsx:456`, `interfaces-view.tsx:215`, `incidents-view.tsx:98`, `perf-devices-view.tsx:75`, `backups-view.tsx:565`) render BEHIND the session shell, and `sign-in-gate.tsx` does NOT call `useMeta`. If this verification passes, proceed; if ANY pre-auth consumer is found, mark the affected block Deferred in this RT and only trim the truly unused ones.

## Impact

Recon material (credential profile names/types, site inventory) served to unauthenticated callers, contradicting the stated "only pre-auth-needed reference data" contract in the route's own doc comment.

## Root cause

Bootstrap route retained more reference data than the sign-in transition actually needs.

## Required change

1. **Verify** (see above) that no pre-auth surface consumes `credentialProfiles`/`sites`.
2. **Split the payload** following the R54 pattern:
   - `GET /api/v1/meta` (still session-exempt) returns ONLY what pre-auth truly needs — per the verification, that is at most `vendors` (if nothing pre-auth needs even vendors, return `{}` and let the shell fetch post-auth; choose the minimal set the verified evidence supports and document it in the route comment).
   - New `GET /api/v1/meta/reference` (AUTHENTICATED; proxy matcher already gates it — no proxy change needed) returning `{ vendors, sites, credentialProfiles }` with the exact same shapes.
   - `src/hooks/api/use-meta.ts`: `useMeta()` switches to `/api/v1/meta/reference` (all consumers are post-auth) — OR keep `useMeta` for vendors-only and add `useMetaReference()`; pick the smaller diff: a single `useMeta()` retarget is smallest and safe post-auth.
   - `src/lib/api-client.ts`: update `MetaPayload` typing/split as needed (`MetaReferencePayload`).
   - Update the route doc comments (both routes) to state the disclosure contract, mirroring the R54 note; update `queryKeys` if a key splits.
3. Keep response envelope + cache semantics identical (`staleTime` unchanged).

## Tests to add

File: extend `tests/audit/r54-meta-users-split.test.ts`-style checks → new `tests/audit/rt024-meta-preauth-trim.test.ts`.

1. `pre-auth payload carries no credential profiles or sites` — fetch `/api/v1/meta` unauthenticated → JSON contains NO `credentialProfiles` and NO `sites` keys (the core negative/security case).
2. `authenticated reference fetch returns the full payload` — with a session, `/api/v1/meta/reference` returns vendors+sites+credentialProfiles with unchanged shapes.
3. `reference route requires a session` — unauthenticated `/api/v1/meta/reference` → 401 envelope (proxy gate; negative/permission case).
4. `post-auth consumers unaffected` — the `useMeta` hook points at the new route (source assertion) and `queryKeys.meta` unchanged so caches invalidate coherently.
5. `sign-in flow still works` — existing browser/e2e sign-in journey (`tests/browser/browser-journeys.test.ts` sign-in case) stays green (guards the verification step's conclusion).

## Acceptance criteria

- [ ] Unauthenticated `/api/v1/meta` leaks no credential-profile names/types and no site inventory (verified by test 1).
- [ ] All post-auth pickers/filters keep working (same data, new route).
- [ ] Route doc comments document the disclosure contract.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt024-meta-preauth-trim.test.ts   # new suite green
bun test tests/audit/r54-meta-users-split.test.ts       # R54 contract still green
bun test tests/                                          # no regressions
node_modules/typescript/bin/tsc --noEmit                 # exit 0
bun run lint                                             # 0 errors
```

## Rollout & rollback notes

If the verification step finds a pre-auth consumer (it did not at planning time), STOP per the RT's binding instruction and mark Deferred. Rollback = revert; no data changes. Coordinate the merge with no other in-flight `useMeta` refactor to avoid a trivial conflict.
