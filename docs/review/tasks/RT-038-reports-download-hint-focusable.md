# RT-038 — Reports: locked-download hint must be keyboard-reachable

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-054 | A4-09 | P3 | S | Low — a11y pattern swap on one view; zero visual change for mouse users |

## Problem & evidence

`src/components/views/reports-view.tsx:368-388` — when a report run is locked (compliance gate), the download buttons render as:
```tsx
<Button aria-label={t("downloadLockedHint")} disabled size="icon" title={t("downloadLockedHint")} variant="ghost">
```
`disabled` buttons are NOT focusable — keyboard users can never reach the hint explaining WHY downloads are unavailable (mouse users get the `title` tooltip).

## Impact

Keyboard-only/AT users hit a dead end with no explanation (WCAG 4.1.2 / 2.1.1-adjacent failure).

## Root cause

Native `disabled` used where the locked state needs to COMMUNICATE, not just block.

## Required change

`src/components/views/reports-view.tsx` (both locked-state buttons, lines ~370-387):
1. Replace `disabled` with `aria-disabled={true}` + guard the handler so activation is impossible:
   - These buttons wrap an `<a href>` (the unlocked branch, lines 355-366, renders `<Button asChild><a href=…>`) — for the locked branch render the icon WITHOUT the anchor: keep `<Button aria-disabled size="icon" variant="ghost" aria-label={t("downloadLockedHint")} title={t("downloadLockedHint")} onClick={(e) => e.preventDefault()}>` and NO inner `<a>` (a button with aria-disabled and no action).
   - Optionally add a visible `sr-only` text node with the hint as belt-and-braces for AT that ignores aria-disabled.
2. Recommended stronger alternative (pick ONE, keep the diff small): attach the hint to the row/container with `aria-describedby="locked-hint-<runId>"` and render one visually-hidden hint node per table (id-stable) — this also fixes the two-button duplication.
3. Do NOT change the unlocked branch or the compliance logic; do NOT remove `title` (sighted mouse users keep the tooltip).

## Tests to add

File: `tests/audit/rt038-locked-download-hint.test.ts` (render test, style of `tests/brand/accessibility.test.tsx`).

1. `locked buttons are focusable` — render a locked run row → the download buttons have `aria-disabled="true"` and are NOT `disabled` (tabbable in the DOM sense: no `disabled` attribute).
2. `hint is announced` — the button's accessible name (aria-label) is the translated `downloadLockedHint`; with the describedby variant, the hint node exists and is referenced.
3. `activation is a no-op` — click the aria-disabled button → no download/navigation occurs (handler guard asserted; negative case).
4. `unlocked branch unchanged` — regression: unlocked row still renders `<a href>` with translated label.
5. `i18n keys untouched` — `downloadLockedHint` still exists in both locales (no copy change in this RT).

## Acceptance criteria

- [ ] Keyboard users can focus the locked download controls and hear/read the hint.
- [ ] No activation path can trigger a download while locked.
- [ ] Unlocked behavior and visuals unchanged.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt038-locked-download-hint.test.ts   # new suite green
bun test tests/browser/browser-journeys.test.ts            # browser peers green (if they cover reports)
bun test tests/                                            # no regressions
node_modules/typescript/bin/tsc --noEmit                   # exit 0
bun run lint                                               # 0 errors
```

## Rollout & rollback notes

One view; revert-safe. If the app has a shared "locked action button" pattern elsewhere with the same defect, file it as a new finding — this RT is scoped to reports-view per F-054.
