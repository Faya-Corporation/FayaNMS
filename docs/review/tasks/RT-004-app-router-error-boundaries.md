# RT-004 — App Router error boundaries: global-error, error, not-found (+ view-level degradation)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-004 | A4-01 | P1 | M | Low — purely additive UI files; no data or auth surface touched |

## Problem & evidence

- `find src/app -name "error.tsx" -o -name "global-error.tsx" -o -name "not-found.tsx" -o -name "loading.tsx"` returns nothing (verified in audit A4-01). The only page is `src/app/page.tsx` rendering `<AppShell/>`; `src/app/layout.tsx:81-115` is the sole wrapper.
- The client `ViewRouter` (switch over ~45 views inside AppShell) has no error boundary wrapper.

An uncaught render exception in any view (or the shell) falls through to Next's default production crash screen: generic, English-only, no retry, loses the whole shell/view state — for an Arabic-locale operator the crash is also mixed-direction.

## Impact

Any client render bug turns into a full-screen dead end; no in-app recovery path; inconsistent with the app's own `ErrorState` pattern (`src/components/domain/error-state.tsx`).

## Root cause

No route-level `error.tsx`/`global-error.tsx`/`not-found.tsx` were ever added to the single-route app; the view switch relies on every view being exception-free.

## Required change

All files under `src/app/` + one small client boundary component:

1. **`src/app/global-error.tsx`** (client component, per Next.js contract must render its own `<html>/<body>`): minimal branded fallback with a "Reload" button (`window.location.reload()`), `dir` read from `document.documentElement.dir` post-mount so an Arabic session keeps RTL. It CANNOT use `useTranslations` reliably (providers are not guaranteed in this tree) — use plain bilingual-neutral copy ("Something went wrong /حدث خطأ ما") with a code comment explaining why (global-error renders outside LocaleProvider).
2. **`src/app/error.tsx`** (client component): receives `{ error, reset }`; renders the existing `<ErrorState>` (`src/components/domain/error-state.tsx`) with `onRetry={reset}` and `correlationId` derived from a stable `useEffect`-logged id (generate `crypto.randomUUID()` once, `console.error("[app-error]", id, error)` so support can trace; do NOT render `error.message` — digest/production messages may leak internals). Localized via `useTranslations` (LocaleProvider IS mounted inside layout above `{children}`) — new keys under `common.appError.*` in BOTH `messages/en.json` and `messages/ar.json` (title, description, retry).
3. **`src/app/not-found.tsx`**: static localized "Page not found" card with a link back to `/` (`Link` or `router.push("/")`); keys under `common.notFound.*`.
4. **View-level boundary** — new `src/components/domain/view-error-boundary.tsx`: a small React class component (or `react-error-boundary`-style implementation) wrapping the `ViewRouter` switch in `src/components/shell/app-shell.tsx` (the component that renders the active view — locate the switch over `activeView`). Keyed by `activeView` so navigation resets it (`key={activeView}` on the boundary, per A4-01's fix suggestion). Fallback renders `<ErrorState onRetry={() => setFailed(false)} />`; the shell keeps its sidebar/header intact so the user can navigate away.
5. **`loading.tsx` is explicitly OUT of scope** (A4-01: the SPA shell renders its own `aria-busy` loading screen) — note this in the PR description to prevent scope creep.

## Tests to add

File: `tests/audit/app-error-boundaries.test.ts` (source-shape + render tests, style of `tests/brand/shell-brand.test.tsx`).

1. `error files exist and are client components` — assert `src/app/error.tsx` / `global-error.tsx` / `not-found.tsx` exist and start with `"use client"` (global-error renders html/body).
2. `error.tsx never renders raw error.message` — negative/security case: assert the file does not interpolate `error.message` into output (regex on source, mirrors how i18n tranche tests police source).
3. `view boundary wraps the view switch and is keyed by activeView` — source assertion on `app-shell.tsx` (boundary present, `key={activeView}` or equivalent reset).
4. `error.tsx renders ErrorState with retry` — render test: mount with a thrown-error prop → ErrorState visible, clicking Retry calls `reset`.
5. `dictionaries carry the new keys in both locales` — extend the parity walk used by `tests/audit/r102-i18n-tranche-6r.test.ts` pattern: `common.appError.*` and `common.notFound.*` exist in en AND ar with identical leaf counts (+4 leaves each side; update the totals assertion if that test pins exact counts).

## Acceptance criteria

- [ ] `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx` exist and are localized (en/ar) where providers are available.
- [ ] A crashing view degrades to `ErrorState` inside the shell; other views remain reachable; boundary resets on view change.
- [ ] No raw `error.message` reaches the DOM from the new boundaries.
- [ ] Both message dictionaries keep exact key parity (repo has 2,850/2,850 today).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/app-error-boundaries.test.ts   # all new cases green
bun test tests/                                      # no regressions (incl. i18n tranche suites)
node_modules/typescript/bin/tsc --noEmit             # exit 0
bun run lint                                         # 0 errors
```

## Rollout & rollback notes

Additive-only; no route/contract changes. The view boundary is the user-visible behavior change — if it masks a genuine regression by swallowing crashes too aggressively, revert just `app-shell.tsx` (route-level files can stay). No data migration; safe to cherry-pick independently.
