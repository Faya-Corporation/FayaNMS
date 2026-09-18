# FayaNMS — R57 / HC-5: Supply-Chain Automation Config (Dependabot) — 2026-09-18

Branch `z_ai_v2` · Phase HC (Production-Readiness Implementation Roadmap) · item **HC-5 — Supply-chain automation config (R57, small)**.

## 1. Why (the debt being retired)

The repo had **no dependabot/renovate**: dependency pin discipline was manual + the CI
osv gate only (independent re-audit 2026-09-18, INFO note: "no dependabot/renovate —
codified as roadmap item HC-5"). Consequence: "what is the weekly intended-diff for
dependencies?" had no machine-readable answer; security waves arrived as ad-hoc
manual bumps. The repo runs **two bun projects** (root app + `mini-services/worker`)
— the same pair behind the dual-lockfile osv scan in `ci.yml` — and both were
outside any automated update loop.

## 2. What changed

**NEW `.github/dependabot.yml`** (version 2), two `updates:` entries:

| | Manifest 1/2 — root app | Manifest 2/2 — worker mini-service |
|---|---|---|
| directory | `/` | `/mini-services/worker` |
| ecosystem | `bun` | `bun` |
| on-disk pair | `package.json` + `bun.lock` | `mini-services/worker/package.json` + `bun.lock` |
| schedule | weekly, Monday 06:00 UTC | weekly, Monday 06:00 UTC |
| open-PR limit | 10 | 5 |
| allow | `dependency-type: "all"` | `dependency-type: "all"` |
| groups | `security-updates` (applies-to: security-updates, production) | same |
| commit message | `deps(<scope>):` | `deps(<scope>):` |

**The versioning policy, codified in the config header:** bumps **preserve each
dependency's declared range style** — a caret dep (the 61-entry default) gets a
caret bump; an **exact pin** (`next 16.3.4`, `react 19.2.3`, and every other
unprefixed version) is bumped **in place as a new exact pin and is never widened**.
The `allow` list (`dependency-type: all`) declares what is auto-updatable so the
exact-pin discipline stays intact; there is deliberately **no `ignore` block**
(nothing is muted — a mute valve would defeat the gate).

**README supply-chain note** appended after the SUPPLY-001-A paragraph: what the
config covers, the pin-preservation policy, and the ACTIVATION CAVEAT — the config
is merged and reviewable now, but Dependabot PRs only appear once GitHub runner
capacity exists (OWNER-CI-001); until then the weekly intended-diff is reviewable
directly from the config + osv gate.

## 3. Test pins — `tests/audit/r57-dependabot-config.test.ts` (8 pins, dependency-free)

| # | Pin |
|---|---|
| 1 | config exists at the canonical path `.github/dependabot.yml` and is `version: 2` (not 1) |
| 2 | exactly TWO update entries, both `package-ecosystem: "bun"`; no other ecosystem sneaks in |
| 3 | BOTH manifest paths declared (`/` and `/mini-services/worker`) **AND** both declared manifests actually exist on disk with their committed lockfiles — config ↔ reality cannot drift silently |
| 4 | weekly cadence on BOTH entries |
| 5 | security-updates GROUP on BOTH entries (`applies-to: security-updates`, exactly 2 occurrences) |
| 6 | allow policy (`dependency-type: "all"`) on BOTH entries + the header documents exact-pin preservation ("PRESERVES each dependency's declared range style", "never widened") |
| 7 | no `ignore:` key anywhere (nothing muted) |
| 8 | README supply-chain note exists with the OWNER-CI-001 activation caveat and the pin reference |

## 4. Gates (CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | clean (0 findings) |
| `bunx tsc --noEmit` | exit 0 (FULL tree) |
| `bun test tests/` | **935 → 943 pass / 18 skip / 0 fail** (7,998 expects, 56 files) |

`.env` staged aside to `/tmp` and the full CI secrets set exported (DATABASE_URL =
`postgresql://fayanms:fayanms-ci-only@localhost:5433/fayanms`, NEXTAUTH_URL,
NEXTAUTH_SECRET, FAYANMS_SERVICE_SECRET, FAYANMS_CONFIG_ENC_KEY — 64-hex test
values) so SAFE-002 JWT pins run in the CI env shape; `.env` restored after.

## 5. LIVE verification

| Check | Result |
|---|---|
| App root `/` | 200 |
| `/api/v1/meta` (unauth bootstrap) | 200 |
| Browser: sign-in gate → demo-account login → app shell | renders, 0 console errors, 0 page errors |
| Browser: NETWORK → Devices view | renders fully keyed (HC-4 chrome intact: Import CSV / Filter by status / All statuses / search placeholder) |
| Wire (in-session authed) `GET /api/v1/devices?pageSize=5` | 200, 5 rows, `meta.requestId` present |
| Screenshot | `agent-ctx/verify-r57-hc5-devices-post-config.png` |
| YAML one-off validation | PyYAML parse: version 2, 2 bun entries, correct directories/groups/allow (outside the pin suite; suite itself is dependency-free) |

## 6. Honest scope

- **Config is dormant until runners exist (OWNER-CI-001):** Dependabot's scheduled
  update jobs run GitHub-side. This sandbox cannot exercise the ecosystem-key
  acceptance, the first scheduled run, or the first PRs. GitHub will surface any
  config rejection on the first run — the YAML shape was parsed locally (PyYAML)
  and every structural expectation is machine-pinned, but **execution validity is
  proven only when OWNER-CI-001 closes**.
- The `bun` ecosystem key is Dependabot-supported (GA since 2024); if the operator
  prefers renovate instead, the roadmap allows a swap — the pins would be re-pointed
  in the same hygiene-test shape.
- Config-only round: no UI surface changed. Browser verification therefore proves
  overall app health + journeys unchanged (sign-in → shell → devices), not a new
  feature surface.
- `bun.lock` files are NOT bumped by this round (no dependency change — the config
  only describes future updates).
