# RT-039 — Admin tables: `text-right` → `text-end` (RTL-mirrored column alignment)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-055 | A4-10 | P3 | S | Zero-Low — mechanical class rename; cosmetic in RTL |

## Problem & evidence

Numeric/action table columns pinned to the PHYSICAL right; in RTL tables they should mirror to the visual end:
- `src/components/views/admin-integrations-view.tsx:191,246,299,338` — `<TableHead className="text-right">` / `<TableCell className="text-right">` (webhooks + channels action columns)
- `src/components/views/admin-api-clients-view.tsx:156,196` — actions column
- `src/components/views/admin-collectors-view.tsx:138,195,407,436` — jobs + sites columns

Cosmetic but consistent with the A4-07 (RT-019) logical-property sweep.

## Impact

Misaligned action/numeric columns in RTL admin tables.

## Root cause

Physical alignment utility used before the logical-property convention.

## Required change

Mechanical rename in exactly the three files above: `text-right` → `text-end` (Tailwind logical utility; LTR rendering identical). Re-verify line numbers at implementation time (they may have shifted; the grep in Verification is the contract). The spacing classes (`mr-*`, `pl-8`, …) are RT-019's scope — keep the sweeps separate for independent review/revert.

## Tests to add

File: `tests/audit/rt039-text-end-sweep.test.ts` (source police).

1. `no text-right remains in the three admin views` — regex `text-right` over the three files → zero hits.
2. `text-end present at the action/numeric columns` — assert `text-end` exists in each of the three files (≥2 occurrences each per the evidence list).
3. `scope guard` — this RT does NOT touch spacing classes: assert the test does not fail on `mr-/pl-` leftovers (those belong to RT-019) — keeps the two sweeps independently revertible.

## Acceptance criteria

- [ ] All three admin views use `text-end`; zero `text-right` remain in them.
- [ ] LTR rendering pixel-identical.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt039-text-end-sweep.test.ts   # new suite green
bun test tests/                                      # no regressions
node_modules/typescript/bin/tsc --noEmit             # exit 0
bun run lint                                         # 0 errors
# Grep contract:
rg -n 'text-right' src/components/views/admin-integrations-view.tsx src/components/views/admin-api-clients-view.tsx src/components/views/admin-collectors-view.tsx
# expected: no matches
```

## Rollout & rollback notes

Pure className rename; revert-safe. Review together with RT-019 if both are in flight, but land as separate commits/PRs.


## Status

Fixed (4d58462)
