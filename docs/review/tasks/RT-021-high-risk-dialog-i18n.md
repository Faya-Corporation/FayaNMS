# RT-021 — High-risk action dialog: localize the typed-confirmation gate

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-020 | A4-05 | P2 | S | Low — fixed copy only; the confirm PHRASE itself stays technical (deliberately untranslated) |

## Problem & evidence

`src/components/domain/high-risk-action-dialog.tsx` — the typed-confirmation gate used for the most dangerous operations (guarded restore etc.) is English-only:
- line 129: `Done — action completed`; line 140: `{error ?? "The action failed"}`
- lines 143-148: `Back` / `Close`; line 212: `Cancel`; lines 220-223: `Working…`
- lines 175-181: `Type <phrase> exactly to confirm — case-sensitive`
- lines 193-201: `Text does not match yet.` (aria-live mismatch hint)

Undermines the safety intent for Arabic operators: the mismatch hint and error alert — the two messages an operator must understand to complete (or abort) safely — are English.

## Impact

Safety-critical confirmation UX is mixed-language in ar; aria-live hint is English for AT users.

## Root cause

Shared dialog predates the i18n sweep; caller-provided title/description/impact rows are already localized, the dialog's own chrome is not.

## Required change

1. **Dictionary** — add `common.highRisk.*` to BOTH dictionaries (parity): `done`, `failedFallback`, `back`, `close`, `cancel`, `working`, `confirmInstruction` (ICU: `Type {phrase} exactly to confirm — case-sensitive`), `mismatchHint`.
2. **`high-risk-action-dialog.tsx`** — `useTranslations("common.highRisk")`; replace the literals above. Deliberate scope rules (from the audit's suggested fix):
   - The confirm phrase / `confirmHint` (`confirmPhrase`, placeholder, input value) stays UNtranslated technical text, already wrapped in `ltr-technical` (lines 177-180, 185, 189) — translate only the surrounding instruction sentence.
   - Caller-provided `title`, `description`, `impact` rows and `resultSummary` pass through unchanged.
3. aria-live semantics: keep `aria-live="polite"` on the mismatch hint; ensure the translated hint stays short (one line).

## Tests to add

File: `tests/audit/rt021-high-risk-dialog-i18n.test.ts` (render + source police).

1. `dialog chrome uses next-intl` — assert `useTranslations("common.highRisk")` and zero evidence literals remain (`Done — action completed`, `exactly to confirm`, `Text does not match yet`, `Working…`).
2. `confirm phrase is not translated` — negative/scope guard: `confirmPhrase`/`confirmHint` render verbatim (render test: pass a phrase with mixed-case technical text → input placeholder equals the phrase byte-for-byte).
3. `mismatch hint is aria-live and localized` — render with typed mismatch → hint node has `aria-live="polite"` and the translated string.
4. `dictionaries carry common.highRisk in both locales` — parity walk green; totals updated consistently if pinned.
5. `phase flow unchanged` — confirm→executing→success/error transitions still driven by the same props (render smoke: success shows translated `done`; error shows `error ?? failedFallback`).

## Acceptance criteria

- [ ] All fixed copy localized (en/ar); caller-provided content untouched.
- [ ] Confirm phrase remains untranslated technical text with `ltr-technical` wrapping.
- [ ] aria-live hint localized.
- [ ] Dictionary parity exact.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt021-high-risk-dialog-i18n.test.ts   # new suite green
bun test tests/audit/                                       # tranches green
bun test tests/                                             # no regressions
node_modules/typescript/bin/tsc --noEmit                    # exit 0
bun run lint                                                # 0 errors
```

## Rollout & rollback notes

Copy-only, single component + dictionaries; revert-safe. Scope note (flagged during planning): F-020 was not in the explicit scope lists; written as a fixable P2/S finding — main agent may re-scope to BACKLOG by dropping this file and the plan row.

## Status

FIXED — commit 9117774 on GLM/full-audit-and-fix (Task 5-k). `common.highRisk.*` (8 keys ×2 locales: done, failedFallback, back, close, cancel, working, confirmInstruction, mismatchHint) added; every F-020 literal keyed; the confirm instruction keys through `t.rich` with the phrase interpolated INSIDE the `font-tech ltr-technical` span (RT-020 demoPasswordHint pattern) while the input placeholder still binds `confirmHint ?? confirmPhrase` byte-for-byte (deliberately untranslated technical text per the RT scope rules); aria-live="polite" mismatch hint localized; caller-provided title/description/impact rows, resultSummary and confirm label pass through unchanged; phase flow untouched (strings-only). Real Arabic consistent with the existing glossary (تم/اكتمل الإجراء، حساسة لحالة الأحرف، جارٍ التنفيذ…). Totals 3206 → 3214 (all 21 pinning tests retotaled). Test: `tests/audit/rt021-high-risk-dialog-i18n.test.tsx` (8 cases; honesty note recorded — Radix portals render empty under react-dom/server, so the RT's render-shaped cases are pinned as exact source contracts).
