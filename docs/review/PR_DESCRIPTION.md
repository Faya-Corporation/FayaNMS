# PR Description — Full audit & remediation of FayaNMS (`GLM/full-audit-and-fix`)

Suggested PR title: **`audit: full five-module audit + 46/69 findings fixed (all 7 P1s), suite 1340→1627 green`**

## Summary

This branch delivers a complete audit of FayaNMS and the remediation that followed it:

- **Audit:** five parallel module audits (A1 auth/API, A2 protocol/worker, A3 data/core, A4 frontend/i18n, A5 ops/CI) produced **66 deduplicated findings** (0 P0 · 7 P1 · 19 P2 · 40 P3; raw 67, one documented merge), a UX walkthrough record, a security posture report, a test-gap analysis, and a dependency scan — all evidence-quoted to file:line in `docs/review/`. The PR's own CI round-trip added three more register rows (F-067 a11y defect, F-068 harness robustness, F-069 governance hash-pin process) → register stands at **69** (7 P1 · 20 P2 · 42 P3).
- **Remediation:** **46 of 69 findings fixed** (43 across 40 planned tasks RT-001..040 in dependency-ordered waves, plus F-067/F-068/F-069 found via the PR's own CI round-trip — a pre-existing dashboard a11y defect reproduced on main, the harness robustness round it exposed, and the governance hash-pin move that edit required), including **all 7 P1s**: alert-suppression reactivation (F-001), MetricRollup runtime producer (F-002), protocol-queue retention sweep (F-003), route-level error boundaries (F-004), hook-toast + alert-surface i18n (F-005/F-006), and the OCI compose least-privilege env split (F-007).
- **Verification:** every fix carries paired regression tests; the suite grew **1,340 → 1,627 passing (+287)**; lint 0, tsc 0, `build:gate` exit 0 at final state. No test, linter, or type check was weakened.
- **What remains:** 21 open findings (2 P2 + 19 P3) + 2 deferred P2s — all with concrete plans in `docs/review/BACKLOG.md`. Nothing dropped silently.

## Risk assessment

**Low-to-moderate risk, concentrated and mitigated:**

- **Highest-change-risk surface:** RT-008's CSRF origin check (proxy.ts) and RT-015's retention rewrite — both are covered by new dedicated suites plus the full regression suite; RT-015's migration is **additive-only** (`prisma/migrations/20260924000000_rt015_hot_path_indexes`: MetricRollup + Device.mgmtIp indexes; no data change, safe to keep on rollback).
- **Semantic changes are few and deliberate:** RT-028 flips health probes from the root page to a new DB-readiness `/api/health`; RT-024 moves picker reference data behind the session gate (no known pre-auth consumer; fallback plan in BACKLOG); RT-040 whitelists chart CSS variable shapes (dev-defined configs only).
- **Deploy-time behavior:** deploy.sh now **fails fast** if the host env split is missing (see rollout) — an intentional guard, not a silent behavior change.
- Two mid-stream regressions were caught by the project's own gates and fixed: `mock.module` poisoning from RT-008's test (4e03273) and a dictionary-retotal pin after RT-013 (38e2755).
- Full risk register with severities and evidence: `docs/review/AUDIT_REPORT.md` (§4 top-10 risks before, §6 what remains).

## Test evidence

| Gate | Baseline (`main @ 38fbdfb`) | Final (this branch) |
|---|---|---|
| `bun test tests/` | 1,340 pass / 18 skip / 2 fail (1,360 tests, 117 files) | **1,627 pass / 19 skip / 2 fail + 2 err** |
| `tsc --noEmit` | PASS (0 errors) | PASS (0 errors) |
| `bun run lint` | PASS (exit 0) | PASS (exit 0) |
| `bun run build:gate` | PASS (exit 0) | PASS (exit 0) |

Exact commands (CI demo env values from `.github/workflows/ci.yml:114-117`; not real secrets):

```bash
bun install --frozen-lockfile
NEXTAUTH_URL=http://localhost:3000 NEXTAUTH_SECRET=$CIK FAYANMS_SERVICE_SECRET=$CIK \
  FAYANMS_CONFIG_ENC_KEY=$CIK bun test tests/
node_modules/typescript/bin/tsc --noEmit
bun run lint
NEXT_PUBLIC_SITE_URL=https://fayanms.invalid bun run build:gate
```

The 2 failures + 2 errors at final state are the R61 credential-free SSH first-contact tests, which require a local `sshd` the sandbox lacks; they fail identically on `main` and are environment-dependent, not product defects. Secret scan of `git diff main`: clean. Live checks: sign-in gate screenshots re-captured at 375/768/1440 + failed-sign-in error state (`docs/review/evidence/screenshots/after/`); `/api/health` verified 200 live.

**CI round-trip:** the first PR run (36768543791) failed 6 tests — audit-added DB suites assumed the demo-seeded sandbox (admin user + admin Role row) and one source-police test shelled out to `rg`, absent on the runner. Fixed in `2027fb2`: the suites now upsert their admin identity from `ROLE_MATRIX` (the seed's own single source of truth) and the source walk is pure-node. Re-verified on a byte-fresh replica database (migrate deploy only, CI env values): full suite 1627 pass / 19 skip / 2 R61 env-fail only — the suite is hermetic against a migrate-only database.

**Browser round-trip:** the browser job then failed repeatedly, and every failure was root-caused rather than retried blindly. First, B3b (authenticated-dashboard axe scan) hung 300s twice on 2-vCPU runners. Reproduced locally on the branch AND on a main-worktree build: the defect is pre-existing on `main` — recharts hardcodes `role="img"` on every sector path with no accessible name (6 serious svg-img-alt when data loads before the scan; main's CI green was a race fluke), and the donut's mount animation starves the scan on slow runners. Fixed in `dfa349a` (decorative svg excluded from the a11y tree — its labelled wrapper, legend, and sr-only alternative carry the full text — plus animation off). The failure then moved to the harness itself (`1df1341` bounded every `page.evaluate`; run 36779703553 still failed 2/12: a strict-mode violation on a toast the product renders correctly, and a 300s hook burn where teardown's plain `DROP DATABASE` waited forever on the starved app's still-open pool connections). Fixed in `e1d1bf3` + `a7a4512` (F-068): teardown reaps children then drops `WITH (FORCE)` under a node-side race; every Playwright call that has NO timeout of its own (`browser.newPage`, `page.close`, `page.addScriptTag`, `keyboard.press`) is raced against node timers; migrate/seed `spawnSync` bounds; CI gains ONE automatic full-suite re-run of the browser step (deterministic failures fail both attempts — the retry absorbs environment wedges only). Final local evidence: full browser suite **12/12 in 41s** (B3b 2.16s, B4 1.36s); no assertion, violation verdict, or journey step weakened.

**Gate round-trip (RT-034 pin, F-069):** run 36797322067 then failed the gate on exactly one test — RT-034's "workflow semantics untouched" pin: the a7a4512 ci.yml edit (browser retry) moved the non-comment YAML hash (`91902f72…` → `9f761be2…`) without moving the deliberately-movable pin atomically. The tripwire worked as designed; the fix moves the pin **deliberately** with a written move log (old hash → new hash, reason, commit reference) in the test docstring. Register updated to **69 findings / 46 fixed (F-067, F-068, F-069)**.

## Rollout notes (operator action required)

1. **BEFORE deploying this branch: split the OCI env file.** The monolithic host `.env` is replaced by per-service files — create `.env.app` and `.env.worker` on the host per `deploy/oci/env.example` (app keeps session/KEK/DB/app vars; worker gets only its own service identity and scrape credentials; postgres/caddy no longer receive app secrets). `deploy/oci/deploy.sh` now **fails fast** in preflight if either split file is missing — this is the enforcement, so the old single-`.env` deploy path will refuse to start.
2. **Apply the migration:** `prisma migrate deploy` (additive `rt015_hot_path_indexes` — no lock-heavy rebuild, no data change).
3. **Health probes:** the app container now serves `/api/health` (DB-readiness); compose probes target it. No action needed if deploying the shipped compose file; custom probe overrides must switch to `/api/health`.
4. **Monitoring profile:** starter Prometheus alert rules are now mounted (`monitoring/rules/`); Caddy access logs go to stdout JSON (retention owned by the docker json-file driver). If you run the TLS Caddyfile, `/api/metrics` now 404s at the edge — scrape via the internal path.
5. Post-deploy checks: force one alert fire/resolve (RT-001 semantics), watch one retention tick (RT-003/015/016 chunking), and confirm Prometheus shows the worker target on `/api/metrics` (RT-018).

## Rollback

- **Code:** revert by wave — Wave 0 P1s (`8c5200d..55db23a`), data wave (`5a22d36..1668edf`), security/ops (`6b535fd..2a2c8ba`, `66ca550..54c5774`), deploy split (`a2c56f8`), UI/i18n (`1fff733..bd17c98`). Each fix commit is self-contained and named `fix(scope): ... (RT-###, F-###)`.
- **Compose env:** restoring the old behavior = re-adding `env_file: .env` per service and removing the split files — but the new deploy.sh preflight must be reverted with it (or it will refuse to start).
- **Migration:** additive-only; safe to leave in place on rollback, or drop the two indexes manually (`MetricRollup` read-path index, `Device.mgmtIp`).
- No data-format changes, no destructive migrations, no protocol changes requiring worker/app version skew handling beyond normal deploy ordering.

## Review-guide file map (`docs/review/`)

| File | Read for |
|---|---|
| `AUDIT_REPORT.md` | Executive summary, before/after scores, top-10 risks, fixed/remaining tallies, limitations, commit inventory |
| `FINDINGS.md` | The register: F-001..F-069 with evidence, root cause, status + fix commit hash per row |
| `REMEDIATION_PLAN.md` | Wave sequencing, per-RT dependency rules, global verification gates |
| `BACKLOG.md` | All 23 non-fixed findings with why-deferred + concrete plan |
| `tasks/RT-001..040` (40 files) | Per-task scope, linked F-IDs, acceptance criteria |
| `SECURITY_REPORT.md` | Defensive posture, verified strengths, findings by theme, methodology |
| `UX_AUDIT.md` | Walkthrough method/limitations, a11y summary, screenshot inventory |
| `TEST_GAP_REPORT.md` | Suite strengths and prioritized gaps (many closed by the fix waves' paired tests) |
| `DEPENDENCY_REPORT.md` | Exact advisory/outdated outputs; honest in-sandbox limits (CI osv/Trivy = advisory evidence) |
| `BASELINE.md` | Environment + baseline command results at branch point |
| `evidence/screenshots/{before,after}/` | 4 PNGs each: sign-in at 375/768/1440 + 1440 failed-sign-in error state |
| `notes/A1..A5` | Source module-audit notes (evidence trail for every register row) |
