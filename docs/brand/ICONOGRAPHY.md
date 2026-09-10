# FayaNMS — Iconography

**Status:** Phase B2 deliverable · rules for the governed FayaNMS icon system
**Applies to:** `public/icons/fayanms/` (228 SVG masters), `src/components/icons/fayanms-icon.tsx` (renderer), `src/lib/icons/*` (registries)
**Related:** [BRAND-GUIDELINES.md](./BRAND-GUIDELINES.md) · [ICON-CATALOG.md](./ICON-CATALOG.md) · [VENDOR-GLYPHS.md](./VENDOR-GLYPHS.md) · [ACCESSIBILITY.md](./ACCESSIBILITY.md)

---

## 1. Geometry contract

Every FayaNMS master icon obeys the same contract (enforced by `bun run brand:validate-icons`):

```text
viewBox        0 0 24 24
fill           none
stroke         currentColor
stroke-width   2
caps/joins     round (stroke-linecap="round" stroke-linejoin="round")
naming         kebab-case, no ".svg" in the registry key
```

- One visual weight across all 228 masters — icons are interchangeable in a row without one looking bolder.
- No embedded fills, gradients, filters, or `<style>` blocks. Simple stroked paths only.
- New masters must ship with a registry/catalog entry; a master without a consumer or a consumer without a master is a validation failure, not a style preference.

## 2. Color contract

- **Masters are colorless.** SVG masters carry `stroke="currentColor"` (or no paint at all); they never hard-code brand or status colors.
- **Semantic color is applied by the consuming token.** The catalog's "Semantic" column (see [ICON-CATALOG.md](./ICON-CATALOG.md)) recommends a token family (`primary`, `success`, `warning`, `danger`, `info`, `neutral`); the actual color comes from the CSS token of whatever consumes the icon (`text-*`, `bg-*-subtle text-*` pairings).
- Brand identity colors (`#2563EB` / `#1D4ED8` / `#0891B2`) belong to Tier 1 assets and status-agnostic brand surfaces only. A domain icon never carries brand color by itself.
- Dark mode is free: because masters are `currentColor` and tokens re-map under `.dark`, icons adapt without a second asset set.

## 3. Renderer: CSS mask + currentColor

The runtime renderer (`src/components/icons/fayanms-icon.tsx`) does **not** inline SVG markup. It renders an element whose background is `currentColor` and whose `mask-image` is `/icons/fayanms/<name>.svg`.

Rationale:

1. **Theme-adaptive** — the glyph is literally painted with the inherited text color; light/dark/status variants need zero per-theme assets.
2. **Zero bundle cost** — icons stay static files under `public/`, fetched once and cached; no icon-font, no JS-bundled SVG tree, no per-icon React overhead.
3. **Server-safe** — the component is isomorphic (no hooks, no `"use client"`), so RSC surfaces render it identically.
4. **One geometry source** — the same master file serves the runtime, the docs catalog and the raster pipeline.

Trade-off accepted: CSS `mask` cannot do multi-color icons. That is intentional — the system has no multi-color icons; the only brand-colored artwork is Tier 1 (`public/brand/`), rendered via `<img>`/lockup components.

### 3.1 Sizing scale

The renderer exposes a fixed scale (plus a numeric escape hatch for one-off layouts):

| Key | px | Typical use |
|---|---|---|
| `xs` | 14 | Dense table cells, inline-with-text |
| `sm` | 16 | Table rows, chips, buttons with labels |
| `md` | 20 | **Navigation (fixed)** — sidebar glyphs are always 20px |
| `lg` | 24 | Page headers, prominent surfaces |
| `xl` | 32 | Headers, empty states, dialogs |

Navigation icons render at a fixed 20px regardless of density — density modes change geometry (`--density-*`), never icon size. Status icons keep their own 16px/20px table/status rhythm via the untouched `status-icon.tsx` path.

## 4. The separation rule: what it is / who makes it / how it behaves

Three orthogonal questions about a device row, answered by three different glyphs — **never collapsed into one colored logo**:

| Question | Glyph | Source | Example |
|---|---|---|---|
| **What it is** (device type) | Device-type icon | `deviceIconFor()` → `device-router`, `device-firewall`, `device-switch`, `device-server`, `device-cloud`, else `device-generic` | A router shows `device-router` |
| **Who makes it** (vendor) | Vendor adapter glyph | `vendorIconFor()` → `vendor-cisco`, `vendor-fortigate`, `vendor-sophos`, `vendor-hpe`, `vendor-juniper`, `vendor-palo-alto`, fallback `vendor-generic` | Cisco adapter → `vendor-cisco` (project glyph, not the Cisco logo) |
| **How it behaves** (status) | Status badge/icon | `status.ts` + `status-icon.tsx` (Lucide-backed, untouched) | "Degraded" badge: icon **+ text label**, semantic token color |

Rules:

- A composite role (e.g. `TOP_OF_RACK`, `WAN_GATEWAY`) deliberately falls back to `device-generic` — no invented semantics.
- Unknown/missing vendor keys resolve to `vendor-generic`, never a broken image or layout shift.
- Status is never expressed by recoloring the device or vendor glyph.

## 5. Protocol icons

Protocol glyphs (`ssh`, `netconf`, `restconf`, `snmp`, `gnmi`, `syslog`, `https`, `api`, `webhook`, …) are **capability labels, not decorations**:

- Use the **`[icon] NETCONF`** pattern: glyph first, protocol name as visible text beside it.
- **Never icon-only** — protocol abbreviations are not guessable from geometry alone, and screen readers get the text for free.
- Don't fake mappings: if a surface doesn't actually speak a protocol, it doesn't get the glyph (the capability chips in the drivers view stay text-only for exactly this reason).

## 6. RTL rule

The product is direction-aware (EN + AR). Icon mirroring is a deliberate exception list, not a default:

- **May mirror** (directional/flow icons): chevrons, arrows, "next/previous", indent/outdent, text-start/text-end affordances — anything whose meaning is direction.
- **Never mirror**: brand marks and lockups (Tier 1), device-type glyphs, vendor adapter glyphs — a mirrored router is a different router, and a mirrored mark is no longer the mark. Logo/identity/device/vendor artwork is direction-neutral by construction.

Implementation note: mirroring, where allowed, is done by the consuming component/CSS (`[dir="rtl"]` rules or `rtl:-scale-x-100`-style utilities), never by shipping a second mirrored master.

## 7. Accessibility rules

Full contract in [ACCESSIBILITY.md](./ACCESSIBILITY.md); the icon-specific invariants:

1. **Icons beside text are decorative** — always `aria-hidden="true"` (the renderer does this by default when no `title` is passed).
2. **Icon-only controls are labeled** — a `title` on the icon gives `role="img"` + accessible name, and the wrapping button still needs its own label/`aria-label`.
3. **No status by color alone** — status icons always pair with a text label via the status badge components; the glyph itself carries a status name when meaningful.
4. **Semantics live in text, not in the icon choice** — e.g. the danger `action-delete` glyph does not *say* "delete"; the label does.

## 8. Adding or changing an icon (process)

1. New master → 24×24 contract (§1) → dropped into `public/icons/fayanms/`.
2. Registry entry added to the relevant governed map (`navigation-icons` / `vendor-icons` / `device-icons`) — `FayanmsIconName` is generated from the directory and a stale union fails `bun run brand:validate-icons`.
3. Catalog row added to [ICON-CATALOG.md](./ICON-CATALOG.md) with one-line semantics + recommended semantic token.
4. `bun run brand:validate-icons` green before merge. The scripts are the enforcement authority; if this document and a script disagree, fix the doc or the script — never hand-wave the check.
