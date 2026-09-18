# FayaNMS — Phase HC Completion Report (HC-1..HC-5) — 2026-09-18

Branch `z_ai_v2` @ release SHA **`5d71466`** (in sync with origin, clean tree).
This report closes the Production-Readiness Implementation Roadmap's **Phase HC
(authorable queue)**: every item authorable inside the sandbox has LANDED with
machine-pinned evidence. What remains on the go-live path is exclusively
operator-side.

## 1. Program summary — five items, five commits, zero deferrals

| Item | Round | Commit | What landed | Pins added | Suite | Evidence doc |
|---|---|---|---|---|---|---|
| HC-1 per-endpoint rate budgets | R53 | `329f0f8` | ai/* 10/min, devices/csv-import 5/min via named-budget registry; proxy wires pathname through the SAFE-002 pre-handler gate; global 300/120 unchanged | 11 | 894 → 905 | `FayaNMS-R53-HC1-Rate-Budgets-2026-09-18.md` |
| HC-2 authenticated bootstrap split | R54 | `49d33f3` | `/api/v1/meta` sheds the user directory (zero user records pre-auth, wire-pinned); NEW actor-gated `/api/v1/meta/users`; both pickers migrated | 10 | 905 → 915 | `FayaNMS-R54-HC2-Meta-Users-Split-2026-09-18.md` |
| HC-3 RequestContext removal | R55 | `64dca8f` | `_ctx` param retired from all four envelope builders; ~100 call sites across 40 route files mechanically removed (net −127); shim kept exported-but-inert, machine-pinned unreferenced; envelope invariance wire-proven (header === meta.requestId with zero context) | 12 | 915 → 927 | `FayaNMS-R55-HC3-RequestContext-Removal-2026-09-18.md` |
| HC-4 i18n completion of chrome copy | R56 | `955aad4` | devices/device-detail fully keyed via NEW `devices`(78)/`deviceDetail`(56) namespaces; en/ar lockstep 1285→1419=1419 with genuine Arabic ICU plurals; FIRST parity pin; PENDING_VIEWS shrinking debt ledger (32 partially-keyed views at R56 ceilings) | 8 | 927 → 935 | `FayaNMS-R56-HC4-I18n-Chrome-2026-09-18.md` |
| HC-5 supply-chain automation config | R57 | `5d71466` | `.github/dependabot.yml` for BOTH bun manifests (root + worker, the dual-lockfile osv pair): weekly, grouped security updates, allow list with exact-pin preservation, no ignore block | 8 | 935 → 943 | `FayaNMS-R57-HC5-Dependabot-Config-2026-09-18.md` |

**Program totals: +49 audit pins (894 → 943), suite green throughout, every item
with an evidence document and both worklogs.**

## 2. Release-SHA re-verification sweep (this round, R58)

Full gate battery re-run in CI env shape (`.env` staged aside + full CI secrets
set exported, restored after) on `5d71466`:

| Gate | Result |
|---|---|
| `bun run lint` | clean (0 findings) |
| `bunx tsc --noEmit` | exit 0 (FULL tree) |
| `bun test tests/` | **943 pass / 18 skip / 0 fail** (7,998 expects, 56 files) |

LIVE wire contracts re-proven against the running app:

| Contract | Result |
|---|---|
| HC-2: unauth `GET /api/v1/meta` | 200, `users` key ABSENT (zero user records pre-auth) |
| HC-2: unauth `GET /api/v1/meta/users` | 401 (actor-gated) |
| F-N1 (R52): unauth `POST /api/v1/devices` | 401 `UNAUTHENTICATED` (auth before rate/lookup) |
| HC-2: authed `GET /api/v1/meta/users` | 200, `users.length === 5` |
| HC-3: authed `GET /api/v1/devices?pageSize=20` | 200, 20 rows, `X-Request-Id` header === `meta.requestId` |
| HC-1: authed burst 12× `POST /api/v1/ai/query` | exactly 10× 400 `INVALID_BODY` (slots consumed) then **2× 429 `RATE_LIMITED`** (11th–12th) — pinned semantics hold end-to-end |

Browser journeys (0 console / 0 page errors throughout):

- EN: sign-in gate → demo-account (Amal Al-Sabri) login → app shell → NETWORK → Devices (keyed chrome intact).
- AR/RTL: language switch → `dir="rtl" lang="ar"`; devices view via command palette (الأجهزة); chrome verified in DOM — `استيراد CSV` ✓ `جميع الحالات` ✓ `الأجهزة` ✓.
- Logout: user menu → تسجيل الخروج → back at the sign-in gate.
- Screenshots: `agent-ctx/verify-r57-hc5-devices-post-config.png`, `agent-ctx/verify-r57-hc5-sweep-devices-ar.png`.

## 3. Go-live checklist — assessment on the release SHA

| # | Go-live definition item | Status |
|---|---|---|
| 1 | HC-1..HC-5 LANDED (HC-6 rides OWNER-CI-001); re-audit verdict stays PASS, zero open P1/P2/P3-authorable | **✅ MET** |
| 2 | OWNER-CI-001 closed: green 4-job workflow run on the release SHA (HC-6 evidence) | ❌ operator-side (blocked since run #34; `ci.yml` ready, SHA-pinned) |
| 3 | OWNER-GOV-001 closed: `main` protection active with the 4 required checks | ❌ operator-side (exact config codified in TASK-GOV-001-A + deploy note 4) |
| 4 | LAB: R50-T090..T092 certified per vendor family; matrix published; LIVE-restore decision documented | ❌ operator-side (Step 0 = PUBLIC DEMO DEVICE PLANE + `bun run demo:fleet` ready) |
| 5 | Final pre-go-live increment: fresh independent full re-audit on the release SHA + checklist re-run | ⏳ pending items 2–4; this report is the in-sandbox precursor, NOT a substitute |

## 4. Honest scope of this report

- **`build:gate` (production build) was NOT exercised this round**: the sandbox has
  ~2.0 Gi available vs the ≥8 Gi `build:gate` requirement — the long-standing OOM
  caveat stands, honestly recorded, and is exactly what HC-6/OWNER-CI-001 exists to
  close (its acceptance: "`build:gate` evidence no longer OOM-caveated"). The full
  test/lint/type battery does run here and is green.
- Dependabot execution validity is GitHub-side (HC-5 evidence doc §6): the YAML
  shape is machine-pinned and locally parsed; the first scheduled run proves the
  ecosystem keys once runners exist.
- HC-4's residual literals (LIVE chip, `—` placeholders, date-fns English relative
  times) and the 32-view PENDING_VIEWS ledger remain deliberately tracked debts
  that may only shrink (machine-pinned).
- This report is a program-completion record authored by the same program that
  landed the work; the roadmap's item 5 (fresh INDEPENDENT re-audit on the final
  release SHA) is intentionally left open as a pre-go-live gate, not claimed here.

## 5. Verdict

**Phase HC: COMPLETE.** All five authorable roadmap items are landed, pushed
(`329f0f8..5d71466`), machine-pinned, and re-verified on the release SHA. The
remaining path to go-live is entirely operator-side: OWNER-CI-001 → HC-6,
OWNER-GOV-001, and LAB certification — each with exact, ready-to-execute hand-off
instructions already in the repository.
