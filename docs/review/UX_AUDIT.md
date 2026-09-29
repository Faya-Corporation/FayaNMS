# UX Audit — FayaNMS (branch `GLM/full-audit-and-fix`)

Task ID: 5-f (compiles the browser UX walkthrough performed during this audit phase, task 5-d code audit A4, and the sign-in gate evidence). Base: `main @ 38fbdfb`.

## Scope & method

- **Target:** the single user-visible route `/` (ADR-02) → `AppShell` → sign-in gate for unauthenticated visitors, plus the failed sign-in error state.
- **Method:** headless-browser walkthrough at three responsive breakpoints (375 px mobile, 768 px tablet, 1440 px desktop) in EN (LTR). Each pass captured a full-page screenshot and an accessibility-tree snapshot; a console-error sweep ran alongside. The failed sign-in path was exercised by submitting non-matching credentials and inspecting the rendered error state (element roles + copy).
- **Post-auth UX** (dashboard, operations, admin views at all breakpoints, AR/RTL flip) could not be walked in this sandbox — see limitations. It is covered instead by the A4 **code audit** of the same surfaces (`docs/review/notes/A4-frontend-i18n.md`) and by the repo's existing browser e2e suite (Playwright journeys run green in CI on `main`).

## Environment limitations

- **PostgreSQL is unavailable in the sandbox** (`pg_isready`, `postgres`, `initdb`, `docker` all absent) and the sandbox user has **no sudo**, so the app could not be started against a database. Post-auth walkthrough (signed-in journeys) is therefore **impossible here**; nothing past the sign-in gate was rendered live in this phase.
- Compensating coverage: (1) A4 read-only code audit of all heaviest views/components/hooks including a11y and RTL; (2) the existing browser e2e/browser-journey suites (`browser` required check) exercised post-auth flows in CI at base `38fbdfb` — green.
- No findings below are invented from screenshots alone; each maps to a code-audited F-ID or to a directly observed walkthrough fact.

## What was walked (verified observations)

1. **Sign-in gate renders at 375/768/1440** — the gate is responsive at all three breakpoints; email/password fields, show-password toggle, Sign in button, and the "Demo accounts" helper block all present in the accessibility tree (see `evidence/signin-error-snapshot.txt`; textbox/button/region roles correct; required fields marked `[required]`).
2. **Failed sign-in error state — VERIFIED.** Submitting invalid credentials renders the error copy **"Invalid email or password."** inside an element with `role="alert"` (screen-reader announced), with the form intact for retry. Archived as `evidence/screenshots/before/1440-signin-error.png` (breakpoint 1440; 375/768 pre-submit shots also archived).
3. **Console cleanliness:** the console-error sweep recorded **zero browser errors** during the walk (`evidence/browser-errors.txt` is empty).
4. **UX observations from the walk (not defects):**
   - The sign-in screen is **all-English** (labels, error copy, demo block) regardless of locale — tracked as F-019 (A4-04): the gate has zero `useTranslations` even though `LocaleProvider` mounts next-intl above it, so localization is possible without architectural change.
   - **Demo accounts + demo password displayed pre-auth** is accepted demo semantics: the product is documented as a demo platform with deterministic seeded demo data (PRODUCT_MAP/README simulation semantics), the demo block is deliberate onboarding UX, and demo seeding is a **production boot violation** (`FAYANMS_DEMO_MODE=true` fails the fail-closed startup security policy — A1 notes, "sensitive data" section). Recorded here for completeness; no finding raised.
   - Show-password affordance is present and its `aria-label` toggles ("Show password"/"Hide password") — though the label strings are hardcoded English (part of F-019).

## Findings

| UX observation (walkthrough or code audit) | Finding(s) | Severity | Status |
|---|---|---|---|
| Sign-in screen entirely hardcoded English (labels, error copy, demo block, show/hide-password aria) | F-019 (A4-04) | P2 | Open |
| No error boundary anywhere: a crashing view dies to Next's default crash screen (post-auth surfaces, code-audited) | F-004 (A4-01) | P1 | Open |
| Mutation toasts hardcoded English across all 46 API hooks (post-auth feedback UX) | F-005 (A4-02) | P1 | Open |
| Alerts stream/dialogs/rules panel — core Operations UX — untranslated incl. aria labels | F-006 (A4-03) | P1 | Open |
| High-risk typed-confirmation dialog copy English-only | F-020 (A4-05) | P2 | Open |
| Device form + CSV import labels and zod validation messages English-only | F-021 (A4-06) | P2 | Open |
| RTL mirroring leftovers in big list search inputs + admin views | F-022 (A4-07) | P2 | Open |
| Shared `ErrorState` defaults ("Something went wrong", "Retry", correlation prefix) English | F-053 (A4-08) | P3 | Open |
| RTL action-column alignment pinned physical-right | F-055 (A4-10) | P3 | Open |
| Arabic first paint announced `lang="en"`; OG metadata always en_US | F-057 (A4-12) | P3 | Open |
| Demo credentials block shown pre-auth | Accepted demo semantics (documented simulation platform; demo mode is a production boot violation per the startup security policy) — no finding | — | N/A |

## Accessibility findings summary

From the A4 code audit (post-auth surfaces) plus the sign-in walkthrough:

- **Keyboard:** one gap — F-054 (A4-09): the reports-view locked-download hint lives only on `disabled` (non-focusable) buttons, so keyboard users can never read why downloads are unavailable. Everything else checked was sound: skip-link present, guided tour manages focus (focus move, Tab trap, Escape), icon-only buttons carry localized `aria-label`s (app-header ×9, sidebar, reports, job center, alert stream).
- **Screen readers / live regions:** `aria-live="polite"` in 10 files, `aria-busy` loading state on the shell, alert `role="alert"` on the sign-in error (verified live). Gap: English-only aria labels on core Operations surfaces (F-006) and untranslated show/hide-password labels (F-019) for Arabic AT users.
- **RTL:** the codebase consistently uses logical properties (`ms-/me-/ps-/pe-`, `rtl:-scale-x-100`); the exceptions are catalogued as F-022/F-055 (mechanical sweep).
- **Semantics:** `first paint` for Arabic users is announced `lang="en"` until the post-mount flip (F-057, documented hydration tradeoff).

## Screenshots inventory (`docs/review/evidence/screenshots/before/`)

| File | Breakpoint | State |
|---|---|---|
| `375-signin.png` | 375 px (mobile) | Sign-in gate, initial render |
| `768-signin.png` | 768 px (tablet) | Sign-in gate, initial render |
| `1440-signin.png` | 1440 px (desktop) | Sign-in gate, initial render |
| `1440-signin-error.png` | 1440 px (desktop) | Failed sign-in — error state after submit |

Supporting text evidence: `evidence/signin-error-snapshot.txt` (accessibility-tree snapshot of the gate) and `evidence/browser-errors.txt` (empty — zero console errors during the walk). No "after" screenshots exist yet — the remediation phase has not started.
