# REMEDIATION PLAN — FayaNMS audit findings (branch `GLM/full-audit-and-fix`)

Inputs: `docs/review/FINDINGS.md` (F-001..F-066, 66 findings; F-003 merges A2-03+A3-03), `docs/review/notes/*.md` (A1..A5), `docs/review/STATE.md`. Task files live in `docs/review/tasks/RT-###-*.md` (40 files; every RT lists its linked F-/A-IDs). Deferred work: `docs/review/BACKLOG.md` (23 findings).

## Coverage math

| Bucket | Findings | RT files |
|---|---|---|
| Wave 0 (all 7 P1) | 7 | 6 (F-005+F-006 share RT-005) |
| Wave 1 (P2 contained + A1-04) | 15 (incl. F-049/F-050 folded into RT-015) | 16 |
| Wave 1.5 (P3 trivial + A5-07) | 17 | 17 |
| **Fixed total** | **43** | **40** |
| Deferred (BACKLOG.md) | 23 | — |
| **Total** | **66** | — |

Scope note: the binding scope lists left four fixable findings unassigned (F-019/A4-04, F-020/A4-05, F-021/A4-06 — all P2/S-M i18n sweeps — and F-060/A5-08, P3/S). They are scheduled here as RT-020..RT-022 and RT-030 so that 66 = 43 fixed + 23 deferred balances exactly; the main agent can re-scope them to BACKLOG by dropping the four files and their rows. Flagged in each RT file.

## WAVE 0 — P0 (none) + all 7 P1  → merge gate: full suite + build

| Order | RT | Finding(s) | Fix | Depends on |
|---|---|---|---|---|
| 0.1 | RT-001 | F-001 (A3-01) | Alert suppression reactivation (evaluate.ts) | — |
| 0.2 | RT-005 | F-005+F-006 (A4-02+A4-03) | i18n: hook toasts + alert components (shared fix) | — |
| 0.3 | RT-002 | F-002 (A3-02) | MetricRollup runtime producer (job + route + engine) | RT-015 recommended (index before rollup volume grows) |
| 0.4 | RT-003 | F-003 (A2-03+A3-03) | ProtocolEventQueue retention sweep | — |
| 0.5 | RT-004 | F-004 (A4-01) | error/global-error/not-found + view boundary | — (RT-037 improves its fallback copy) |
| 0.6 | RT-006 | F-007 (A5-01) | OCI compose per-service env split | operator action on host before next deploy |

Wave 0 gate: `bun test tests/` fully green (baseline 1340 pass/18 skip), `node_modules/typescript/bin/tsc --noEmit` clean, `bun run lint` clean, `bun run build:gate` exit 0. RT-006 additionally requires a staging `docker compose config` render check.

## WAVE 1 — P2 contained (fix)

| Order | RT | Finding(s) | Fix | Depends on |
|---|---|---|---|---|
| 1.1 | RT-015 | F-017 (A3-08) + F-049 (A3-13) + F-050 (A3-14) | Batched metric prune + ONE additive index migration | **First in wave** — perf RTs ride on its indexes |
| 1.2 | RT-007 | F-009 (A1-02) | Security headers in next.config.ts | — |
| 1.3 | RT-008 | F-010 (A1-03) | Origin/Sec-Fetch-Site check in proxy.ts | — |
| 1.4 | RT-009 | F-027 (A1-04, S part only) | timingSafeEqual in /api/metrics | — |
| 1.5 | RT-010 | F-011 (A2-01) | Bounded WebAPI response accumulation (4 MiB cap) | — |
| 1.6 | RT-011 | F-013 (A3-04) | Prune must not cascade OPEN DriftRecords / baselines | — (**before RT-016**, same code region) |
| 1.7 | RT-012 | F-014 (A3-05) | devices/bulk audit rows hash-stamped (no createMany) | — |
| 1.8 | RT-013 | F-015 (A3-06) | Tail-anchored chain verify | — |
| 1.9 | RT-014 | F-016 (A3-07) | Incident/change P2002 retry (cmdb pattern) | — |
| 1.10 | RT-016 | F-018 (A3-09) | Snapshot prune due-ness gating + set-based candidates | RT-011 |
| 1.11 | RT-017 | F-024 (A5-03) | container.yml scan-before-publish (**file-only: workflow disabled at repo level — no CI runtime effect until the owner re-enables**) | — |
| 1.12 | RT-018 | F-023 (A5-02) | Worker scrape path → /api/metrics | — (before RT-030 validation) |
| 1.13 | RT-019 | F-022 (A4-07) | RTL logical spacing sweep (9 files) | — |
| 1.14 | RT-020 | F-019 (A4-04) | Sign-in gate i18n (gap-closure add) | after RT-005 conventions |
| 1.15 | RT-021 | F-020 (A4-05) | High-risk dialog i18n (gap-closure add) | after RT-005 |
| 1.16 | RT-022 | F-021 (A4-06) | Device form + CSV import i18n (gap-closure add) | after RT-005 |

Wave 1 gate: same as Wave 0, plus: RT-015 migration applied via `prisma migrate deploy` on the local DB in CI; RT-008's proxy suite + `tests/auth/` green; RT-017's updated workflow-contract tests (r78/docker-image-provenance) green.

## WAVE 1.5 — P3 trivial (fix; one finding per RT)

| Order | RT | Finding | Fix |
|---|---|---|---|
| 1.5.1 | RT-023 | F-035 (A1-12) | Remove `/api` hello stub |
| 1.5.2 | RT-024 | F-028 (A1-05) | Trim pre-auth /meta payload (verify-then-split; Deferred fallback if a pre-auth consumer appears) |
| 1.5.3 | RT-025 | F-040 (A2-08) | Worker metrics timing-safe compare + 403 for scope-insufficient |
| 1.5.4 | RT-026 | F-042 (A2-10) | appendBounded exact cap |
| 1.5.5 | RT-027 | F-043 (A2-11) | Worker error-detail hygiene + log rotation |
| 1.5.6 | RT-028 | F-059 (A5-07) | `/api/health` readiness endpoint + probe switch |
| 1.5.7 | RT-029 | F-058 (A5-06) | Caddy access log → stdout |
| 1.5.8 | RT-030 | F-060 (A5-08) | Starter Prometheus alert rules + mount (gap-closure add) |
| 1.5.9 | RT-031 | F-061 (A5-09) | TLS-profile /api/metrics 404 (all three Caddyfiles) |
| 1.5.10 | RT-032 | F-062 (A5-10) | backup.sh umask 077 |
| 1.5.11 | RT-033 | F-063 (A5-11) | restore-drill URL off argv |
| 1.5.12 | RT-034 | F-064 (A5-12) | ci.yml governance header refresh (comment-only) |
| 1.5.13 | RT-035 | F-065 (A5-13) | dependabot github-actions ecosystem |
| 1.5.14 | RT-036 | F-066 (A5-14) | Remove --web.enable-lifecycle |
| 1.5.15 | RT-037 | F-053 (A4-08) | ErrorState localized defaults — **after RT-005** |
| 1.5.16 | RT-038 | F-054 (A4-09) | Locked-download hint keyboard-reachable |
| 1.5.17 | RT-039 | F-055 (A4-10) | text-right → text-end sweep |
| 1.5.18 | RT-040 | F-056 (A4-11) | ChartStyle CSS whitelist guard |

Wave 1.5 gate: per-RT test files green; full `bun test tests/`, tsc, lint green after the wave. RT-028 staged: land route + probes together only after a day of the route running in staging.

## Cross-cutting dependency rules

1. **RT-015 (migration) first in Wave 1** — RT-002's rollup volume and RT-030's queue-growth rule are meaningless without the indexes; never ship a perf RT before its index.
2. **RT-005 before RT-020/021/022/037** — one direction for dictionary conventions + leaf-count updates.
3. **RT-011 before RT-016** — both rewrite `pruneRetention` in tick/route.ts; land in that order, review together.
4. **RT-018 before RT-030** — the worker-down rule needs a scraping target.
5. **RT-006 needs an operator step** (create `.env.app`/`.env.worker` on the host) — schedule the staging window explicitly; deploy.sh's new preflight enforces ordering.
6. **container.yml is disabled at repo level** (owner request): RT-017 is file-only and its tests are the sole verification until re-enable — do not attempt a live GHCR validation.
7. **RT-028 probe flip is the only semantic health change** — everything else in the plan keeps today's liveness semantics.
8. i18n RTs (RT-004/005/020/021/022/037) each add dictionary leaves: keep en/ar parity exact and update ONLY the newest tranche test's totals assertion if it pins counts (2,850 today).

## Global verification gate (every RT + each wave)

```bash
bun test tests/<rt-test-file>            # the RT's own suite
bun test tests/                          # full suite (baseline 1340 pass / 18 skip / 2 env-fail)
node_modules/typescript/bin/tsc --noEmit # exit 0, no output
bun run lint                             # 0 errors
bun run build:gate                       # per-wave (Wave 0 mandatory; after any next.config/layout change)
```

## Post-wave operational checks

- After Wave 0: one full staging boot with the RT-006 split env files; alert-engine run exercised (RT-001) via a forced alert fire/resolve.
- After Wave 1: `prisma migrate deploy` on staging (RT-015), chain verify verdict wording reviewed (RT-013), one browser pass over the devices list in ar (RT-019).
- After Wave 1.5: monitoring profile boot (RT-018/030/036), a backup+restore drill (RT-032/033), TLS entrypoint curl checks (RT-031).
