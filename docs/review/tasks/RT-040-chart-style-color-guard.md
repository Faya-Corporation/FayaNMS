# RT-040 — ChartStyle: whitelist-guard the injected CSS custom properties

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-056 | A4-11 | P3 | S | Low — defense-in-depth guard on the only `dangerouslySetInnerHTML` in `src/`; current input is developer-defined config |

## Problem & evidence

`src/components/ui/chart.tsx:72-103` — `ChartStyle` builds a `<style>` tag via:
```tsx
<style dangerouslySetInnerHTML={{ __html: Object.entries(THEMES).map(([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig.map(([key, itemConfig]) => {
  const color = itemConfig.theme?.[theme] || itemConfig.color
  return color ? `  --color-${key}: ${color};` : null
}).join("\n")}
}`).join("\n") }} />
```
- The ONLY `dangerouslySetInnerHTML` in `src/`. Input today is the developer-defined `ChartConfig` (static colors) — no current injection path.
- But any future config fed from API/device data becomes an HTML/CSS injection sink (`key` is interpolated UNESCAPED into a property name; `color` into a value).
- Related note from the audit: `use-token-colors.ts` hardcodes hex chart colors instead of reading CSS tokens (optional follow-up, not this RT).

## Impact

Latent injection sink; today informational, tomorrow a footgun the moment someone wires dynamic config.

## Root cause

shadcn-chart boilerplate interpolates config straight into an HTML string without validating shape.

## Required change

1. **`src/components/ui/chart.tsx`** — add a guard before interpolation:
   ```ts
   const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
   const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|var\(--[A-Za-z0-9_-]+\)|[a-zA-Z]+)$/;
   ```
   - Skip any `[key, itemConfig]` pair whose key fails `SAFE_KEY`, and any color failing `SAFE_COLOR` (skip = omit the line, never throw — charts must render).
   - Keep `id` interpolation but assert/sanitize it the same way (`id` comes from `useId`-style callers today; guard anyway — a comment notes the rule).
   - Add the audit-mandated comment: `// Chart config is a DEVELOPER artifact. It must NEVER carry user/device/API data — the whitelist above is defense-in-depth, not a data-sanitization promise.`
2. Optionally export `SAFE_COLOR` for reuse by `use-token-colors.ts` follow-up (do not refactor that file in this RT).
3. No visual change: every current config in the repo passes the whitelist (verify with a grep over `ChartConfig` literals — colors are hex/named).

## Tests to add

File: `tests/audit/rt040-chart-style-guard.test.ts` (unit test on the guard + source police).

1. `safe config renders unchanged` — unit-render `ChartStyle` with a typical config (`{ cpu: { color: "#10b981" } }`) → style tag contains `--color-cpu: #10b981;`.
2. `css-injection payloads are dropped` — negative cases: key `"a; } body { background" `, color `"red; background:url(x)"`, color `"expression(...)"` → none of it appears in the emitted HTML string.
3. `var() tokens pass` — `var(--chart-1)` colors are allowed (design-token flow unaffected).
4. `chart still renders with fully-unsafe config` — config where EVERY entry is unsafe → component renders (empty style or null), no throw.
5. `single interpolation sink stays guarded` — source assertion: the guard constants exist in chart.tsx and `dangerouslySetInnerHTML` count in `src/` is still exactly 1 (keeps the audit's inventory honest).

## Acceptance criteria

- [ ] Only whitelist-passing keys/colors are interpolated; malformed input can never inject CSS/HTML.
- [ ] Current repo charts render pixel-identical (all existing configs pass).
- [ ] The "developer artifact, never user data" comment is present.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt040-chart-style-guard.test.ts   # new suite green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
```

## Rollout & rollback notes

One component + tests; revert-safe. If a legitimate chart style trips the whitelist (e.g. `oklch(...)` colors), EXTEND `SAFE_COLOR` deliberately with a comment — never loosen the key guard.
