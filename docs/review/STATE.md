# Audit State — GLM/full-audit-and-fix

## Current phase
P5 Wave 1 data P2s FIXED: RT-011 5a22d36, RT-012 a2932e0, RT-013 0909ef9, RT-014 bbb5475, RT-015 f88e411 (additive index migration), RT-016 1668edf, retotal 38e2755; suite 1493 pass/18 skip/2 env-fail, tsc 0, lint 0. ENV CORRECTION: PostgreSQL IS running at localhost:5433 (seeded demo data; earlier 'no DB' assumption wrong — only CLI tools absent), post-auth UI walks possible. Prior: i18n RT-005 55db23a, RT-020 04534bc, RT-021 9117774, RT-022 19b91de, RT-037 7e78c8f (dict 3312/side); Wave 0 P1s RT-001 8c5200d, RT-002 fdb3dcf, RT-003 e97007e, RT-004 a2f2278; docs (4881a96, 3517ce7); baseline GREEN (1340 pass/18 skip/2 env-fail, build:gate exit 0), 5 module audits (67 raw), UX before-screenshots captured

## Ground truth
- Repo: /home/z/faya-nms, branch GLM/full-audit-and-fix (from main @ 38fbdfb). Base branch NEVER touched.
- Stack: Next.js 16 App Router + TS 5.9.3, Bun 1.3.14, Prisma + PostgreSQL (provider postgresql; dev URL localhost:5433), worker in mini-services/worker (bun, port 3030), i18n en/ar, tests `bun test tests/`.
- CI env (public demo values from ci.yml, reused locally): NEXTAUTH_URL=http://localhost:3000, NEXTAUTH_SECRET/FAYANMS_SERVICE_SECRET/FAYANMS_CONFIG_ENC_KEY=6b1f0f4c...9a03 (see ci.yml:114-117).

## Reviewed (module -> status)
A1 auth/API: 12 (0 P0/0 P1/3 P2/9 P3); A2 protocol/worker: 13 (3 P2/10 P3); A3 data/core: 16 (3 P1/6 P2/7 P3); A4 frontend/i18n: 12 (3 P1/4 P2/5 P3); A5 ops/CI: 14 (1 P1/4 P2/9 P3). Total raw 67; P1s individually re-verified by main agent (all confirmed). Dedupe pending: A2-03 == A3-03.

## Remaining
All modules; plan: A1 auth/API, A2 protocol/worker/ingest, A3 data/core services, A4 frontend/i18n, A5 ops/CI/deploy, UX browser walk.

## Findings so far
(being collected into docs/review/notes/*.md by audit agents A1-A5)

## Assumptions
- PostgreSQL is not installed in sandbox (pg_isready/postgres/initdb not found). App run attempted anyway; if DB unavailable, UI audit covers screens reachable without DB and the limitation is documented in BASELINE.md.
- Local test runs use CI demo keys; no real credentials anywhere.

## Blockers / errors
A1 auth/API: 12 (0 P0/0 P1/3 P2/9 P3); A2 protocol/worker: 13 (3 P2/10 P3); A3 data/core: 16 (3 P1/6 P2/7 P3); A4 frontend/i18n: 12 (3 P1/4 P2/5 P3); A5 ops/CI: 14 (1 P1/4 P2/9 P3). Total raw 67; P1s individually re-verified by main agent (all confirmed). Dedupe pending: A2-03 == A3-03.

## Post-audit round-trip (2026-09-30, main agent)
- PR #14 opened (Faya-Corporation/FayaNMS, GLM/full-audit-and-fix -> main @ 38fbdfb; 57 commits, 239 files, +16.5k/-1.3k).
- First CI run 36768543791: gate FAILED — 6 tests failed (1626 pass/18 skip). All six were audit-added suites with fresh-DB dependencies the seeded sandbox had masked:
  (a) rt012 x3, rt014 x2, rt015 x1 — findUnique(admin@faya.local) null on a migrate-only DB; the two route-level suites also 403'd because the seeded admin ROLE row was missing (loadRolePermissions resolves User.role -> Role.name).
  (b) protocol-queue-retention source-police test shelled out to `rg -l ... || true` — ripgrep absent on the runner image, spawn failure swallowed, zero hits, false red.
- Fix 2027fb2: rt012/rt014 ensure-helpers upsert the admin Role (permissions from ROLE_MATRIX, the seed's single source of truth; update:{} keeps existing rows) + admin User atomically, never deleting seed-equivalent shared state; rt015's vestigial admin lookup removed (service-token file, no user fixture needed); rg shell-out replaced with a pure-node recursive walk.
- Verification on a byte-fresh replica database (fayanms_gatecheck2, migrate deploy only, CI env values): FULL suite 1627 pass / 19 skip / 2 fail + 2 err — R61 sshd pair only. Seeded-DB full suite identical. tsc 0, lint 0. The suite is now proven hermetic against a migrate-only database — stronger than the pre-fix evidence.
- Next: push 2027fb2, watch CI gate/e2e/browser/scan on the new head, then final report.

## Round-trip addendum (2026-09-30, cont.)
- Run 36770354882 on 0b0aa21: gate SUCCESS (test-isolation fix confirmed on CI), e2e SUCCESS; scan FAILED (7 advisories on 3 packages — drift, lockfiles identical to base); browser FAILED (B3b dashboard axe run hung 300s on the constrained runner — the suite's own documented flake mode at browser-journeys.test.ts:153; harness watchdog killed the e2e app, cascading B4/B5 to ERR_CONNECTION_REFUSED. 9/12 journeys incl. all app-render journeys passed. tests/browser/ untouched by this branch).
- Dep fix a63a246: next 16.3.6 (GHSA-vcvr-r3jv-pc5j Critical), brace-expansion resolutions refreshed to 1.1.21/^5 5.0.12, @types/node devDep-pinned 22.20.2 (bun-types 1.4.2 '*' range pulled v26, compile-breaking). osv-scanner v2.5.1 locally: No issues found. All gates re-verified locally (tsc/lint/build/both-DB suites). Docs 737c64e.
- Next: push; require gate+e2e+browser+scan green on the new head; if browser re-fails the same way, investigate RT-040-era dashboard render loop with a local chromium reproduction.

## Final round-trip closure (2026-09-30)
- Browser B3b root-caused with a main-worktree reproduction: the 6 serious svg-img-alt violations and the 300s CI hang are PRE-EXISTING on main (recharts Sector.js role="img" + donut mount animation starving the scan); main's earlier green was a data-load race fluke. Fixed in dfa349a (aria-hidden on the decorative chart div + isAnimationActive=false); full browser suite 12/12 locally, B3b 2.3s. Registered as F-067 (P2, Fixed) — register now 67 findings / 44 fixed / 2 deferred / 20 open.
- Branch head: dfa349a + docs commit. Final CI expectation: gate/e2e/browser/scan all green.
