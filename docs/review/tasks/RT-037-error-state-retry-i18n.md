# RT-037 — ErrorState defaults: localized Retry label + correlation prefix

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-053 | A4-08 | P3 | S | Low — shared component defaults; callers pass localized titles already |

## Problem & evidence

`src/components/domain/error-state.tsx`:
- line 25: `title = "Something went wrong"` (default param)
- line 51: `Correlation ID: ` prefix literal
- line 57: `Retry` button label

The shared error component's own chrome is English even though callers pass localized titles — non-English error surfaces show mixed copy. Note: RT-004 makes `error.tsx` a NEW consumer of this component, so fixing the defaults now keeps that route-level fallback consistent.

## Impact

Mixed-language error states in ar locale (retry affordance + correlation hint untranslated).

## Root cause

Component predates the i18n sweep; defaults never wrapped.

## Required change

1. **Dictionary** — add `common.retry` (`Retry` / AR) and `common.errors.correlationId` (`Correlation ID: {id}` / AR) to BOTH dictionaries (parity).
2. **`error-state.tsx`** — `const t = useTranslations("common")`; replace `Retry` (line 57) with `{t("retry")}` and the correlation line (lines 50-52) with `t("errors.correlationId", { id: correlationId })` keeping the `<span className="ltr-technical">` wrapper around the id (technical token stays LTR — keep the existing span exactly).
3. The `title` default: replace with `t("errors.genericTitle")` (new key, en "Something went wrong") — BUT keep the prop override precedence (`title ?? tDefault`): callers that already pass localized titles are unaffected.
4. Dependency (plan ordering): land AFTER RT-005 so the namespace conventions + dictionary-count updates settle in one direction (both touch messages/*.json; RT-005 is the bigger sweep).

## Tests to add

File: `tests/audit/rt037-error-state-i18n.test.ts` (render test, style of `tests/brand/accessibility.test.tsx`).

1. `defaults are localized` — render `<ErrorState />` with an en catalog → `Retry` visible; with an ar catalog → the ar retry label visible; default title likewise.
2. `correlation id stays technical` — render with `correlationId="abc-123"` → id inside `ltr-technical` span, prefix translated (assert the id string is present verbatim).
3. `caller titles still win` — negative/precedence: `<ErrorState title="X" />` renders exactly `X` (no default leakage).
4. `dictionaries parity` — `common.retry`, `common.errors.correlationId`, `common.errors.genericTitle` exist in en AND ar.

## Acceptance criteria

- [ ] ErrorState chrome (retry, correlation prefix, default title) localized; overrides respected.
- [ ] `ltr-technical` wrapper preserved around the correlation id.
- [ ] Dictionary parity exact; tranches green.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt037-error-state-i18n.test.ts   # new suite green
bun test tests/audit/                                  # tranches green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
```

## Rollout & rollback notes

One component + 3 keys ×2 locales; revert-safe. Composes with RT-004 (error.tsx) — review together if both are in flight.

## Status

FIXED — commit 7e78c8f on GLM/full-audit-and-fix (Task 5-k). `common.errors.{genericTitle,correlationId}` (2 new keys ×2 locales) added; `common.retry` already existed and is REUSED (no duplicate key — a deliberate, documented deviation from the RT's "add common.retry"). ErrorState consumes `useTranslations("common")`: default title → `errors.genericTitle`, retry label → `retryLabel ?? t("retry")`, correlation line → `t.rich("errors.correlationId")` with the id interpolated INSIDE the existing `ltr-technical` span (rich-tag pattern; the RT's literal `t(...)` call would have dropped the span the RT itself requires kept). Caller `title`/`retryLabel` overrides keep precedence (`??`), so all 50+ call sites passing localized titles are unaffected. en copy byte-identical to the previous literals; ar matches the appError glossary (حدث خطأ ما، معرّف الارتباط). Totals 3309 → 3311 (all 24 pinning tests retotaled). app-error-boundaries.test.tsx: the ViewErrorBoundary fallback render now runs inside the en locale provider (ErrorState needs next-intl context since this RT) — same assertions, no weakening. Test: `tests/audit/rt037-error-state-i18n.test.tsx` (9 cases, full SSR render coverage — ErrorState is portal-free).
