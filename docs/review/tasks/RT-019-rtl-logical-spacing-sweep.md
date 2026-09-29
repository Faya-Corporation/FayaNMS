# RT-019 — RTL sweep: physical left/right + pl/pr/ml/mr → logical start/end classes

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-022 | A4-07 | P2 | S | Low — mechanical class swaps; visual-only, verified by the listed files |

## Problem & evidence

Nine files still use physical directional utilities that don't mirror in RTL (the rest of the app consistently uses `ms-/me-/ps-/pe-` and `rtl:-scale-x-100`, so these read as leftovers):

| File:line | Current | Meaning |
|---|---|---|
| `src/components/views/devices-view.tsx:848,852` | `absolute left-2.5` + `h-9 pl-8` | search-input icon + padding |
| `src/components/views/interfaces-view.tsx:347,351` | `absolute left-2.5` + `h-9 pl-8` | same pattern |
| `src/components/device/device-interfaces-tab.tsx:76,80` | `absolute left-2.5` + `h-8 pl-8` | same pattern |
| `src/components/views/admin-integrations-view.tsx:154,157` | `mr-2` (Bell, Webhook icons) | leading icon |
| `src/components/views/admin-system-view.tsx:150,152,188,190,196,215,219,302` | `mr-1`/`mr-2` ×8 | leading icons |
| `src/components/views/admin-api-clients-view.tsx:115,203` | `mr-2` / `mr-1` | leading icons |
| `src/components/views/admin-collectors-view.tsx:90` | `mr-2` | leading icon |
| `src/components/views/noc-view.tsx:229` | `pr-1` | scroll-area padding |
| `src/components/views/flows-view.tsx:436` | `ml-1.5` | trailing label |

In the three big list search inputs the icon stays physically left while Arabic text starts right (gap on the wrong side); leading button icons hug the wrong edge in RTL.

## Impact

Broken/misaligned layouts for Arabic-locale operators on the highest-traffic list views and admin surfaces; inconsistent with the app's own RTL discipline.

## Root cause

Pre-RTL-discipline leftovers the i18n/RTL tranches missed.

## Required change

Mechanical sweep, exactly the A4-07 mapping — no other class churn in the same lines:
- `left-2.5` → `start-2.5` (three search inputs; the icon also gets `rtl:-scale-x-100` ONLY if it is a directional glyph — these are `Search` icons, non-directional, so no flip).
- `pl-8` → `ps-8` (inputs keep symmetric look in LTR; in RTL padding follows the icon).
- `mr-*` → `me-*` (`mr-2`→`me-2`, `mr-1`→`me-1`).
- `ml-*` → `ms-*` (`ml-1.5`→`ms-1.5`).
- `pr-1` → `pe-1`.
Files (exhaustive): `src/components/views/devices-view.tsx`, `src/components/views/interfaces-view.tsx`, `src/components/device/device-interfaces-tab.tsx`, `src/components/views/admin-integrations-view.tsx`, `src/components/views/admin-system-view.tsx`, `src/components/views/admin-api-clients-view.tsx`, `src/components/views/admin-collectors-view.tsx`, `src/components/views/noc-view.tsx`, `src/components/views/flows-view.tsx`.
Re-verify the exact line numbers at implementation time (the file may have shifted; the grep in Verification is the contract). The `text-right` instances are NOT this RT (they are F-055/RT-039 — keep the two sweeps separate so each stays reviewable/revertible).

## Tests to add

File: `tests/audit/rt019-rtl-logical-spacing.test.ts` (source police, style of the i18n tranche tests).

1. `no physical left/right spacing utilities remain in the nine files` — regex `(?:^|["'\s])(left-\d|right-\d|pl-\d|pr-\d|ml-\d|mr-\d)` over exactly the nine listed files → zero hits (allow `ps-/pe-/ms-/me-/start-/end-` only).
2. `logical replacements present` — assert `start-2.5` + `ps-8` in the three search inputs; `me-2`/`me-1` in the admin views; `pe-1` in noc-view; `ms-1.5` in flows-view.
3. `scope guard: text-right untouched by this RT` — negative/cross-RT guard: the files may still contain `text-right` (RT-039's scope) — assert this test does NOT fail on `text-right`, keeping the two sweeps independent.

## Acceptance criteria

- [ ] All nine files use logical utilities; zero physical directional spacing classes remain in them.
- [ ] LTR rendering pixel-identical (start-* maps to left, me-* to right in LTR — pure rename).
- [ ] RTL manual check: search-input icon hugs the text-start edge; leading icons correct on admin buttons.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt019-rtl-logical-spacing.test.ts   # new suite green
bun test tests/                                           # no regressions
node_modules/typescript/bin/tsc --noEmit                  # exit 0
bun run lint                                              # 0 errors
# Grep contract:
rg -n '\b(left-2\.5|pl-8|mr-[0-9.]+|ml-[0-9.]+|pr-1)\b' src/components/views/devices-view.tsx src/components/views/interfaces-view.tsx src/components/device/device-interfaces-tab.tsx src/components/views/admin-integrations-view.tsx src/components/views/admin-system-view.tsx src/components/views/admin-api-clients-view.tsx src/components/views/admin-collectors-view.tsx src/components/views/noc-view.tsx src/components/views/flows-view.tsx
# expected: no matches
```

## Rollout & rollback notes

Pure className renames (logical utilities are Tailwind built-ins, already used repo-wide — no config change). Rollback = revert the PR. Pair with an ar-locale browser screenshot for the devices list in the PR description (cheap confidence).
