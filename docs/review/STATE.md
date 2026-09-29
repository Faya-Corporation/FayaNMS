# Audit State — GLM/full-audit-and-fix

## Current phase
P5 i18n gap-closure FIXED: RT-005 55db23a (hook toasts/alerts) + RT-020 04534bc (sign-in gate) + RT-021 9117774 (high-risk dialog) + RT-022 19b91de (device form + CSV import) + RT-037 7e78c8f (ErrorState defaults); dictionary 3311 leaves/side, full suite 1453 pass/18 skip/2 env-fail, tsc 0, lint 0. Prior: Wave 0 P1s (RT-001 8c5200d, RT-002 fdb3dcf, RT-003 e97007e, RT-004 a2f2278); docs compiler + RT plan done (4881a96, 3517ce7). Baseline GREEN (lint 0, tsc 0, tests 1340 pass/18 skip/2 env-fail, build:gate exit 0), 5 module audits complete (67 raw findings), UX walk of unauthenticated surfaces done with 4 before-screenshots

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
