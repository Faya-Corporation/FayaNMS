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
- No embedded fills, gradients, filters, or `<style>` blocks. Simple stroked paths only — and no hardcoded colors anywhere: every `fill`/`stroke` on a master must be `none` or `currentColor`.
- New masters must ship with a registry/catalog entry; a consumer referencing a master that is not on disk is a validation failure. The reverse is **not**: a disk master without a runtime consumer is allowed and reported as a **warning** (orphan policy, B1-010 — see §8).

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

**14px is the documented minimum for custom glyphs** (re-audit B2-022): a calibrated 24×24 outline glyph rendered below 14px loses stroke fidelity, so the named scale stops at `xs` 14. The numeric `size={…}` escape hatch still exists for one-off optical fits, but any render below 14px is a review flag, not a sanctioned pattern (the former 12px driver-view use was normalized to `xs`).

## 4. The separation rule: what it is / who makes it / how it behaves

Three orthogonal questions about a device row, answered by three different glyphs — **never collapsed into one colored logo**:

| Question | Glyph | Source | Example |
|---|---|---|---|
| **What it is** (device type) | Device-type icon | `deviceIconFor()` — exact role codes resolve through `DEVICE_ROLE_META` first (`src/lib/icons/device-role-meta.ts`), then the case-insensitive substring families (`firewall`/`router`/`switch`/`server+appliance`/`cloud+virtual`), else `device-generic` | A router shows `device-router`; `TOP_OF_RACK` shows `device-switch` |
| **Who makes it** (vendor) | Vendor adapter glyph | `vendorIconFor()` → `vendor-cisco`, `vendor-fortigate`, `vendor-sophos`, `vendor-hpe`, `vendor-juniper`, `vendor-palo-alto`, fallback `vendor-generic` | Cisco adapter → `vendor-cisco` (project glyph, not the Cisco logo) |
| **How it behaves** (status) | Status badge/icon | `status.ts` + `status-icon.tsx` (Lucide-backed, untouched) | "Degraded" badge: icon **+ text label**, semantic token color |

Rules:

- Known composite roles keep their product semantics via `DEVICE_ROLE_META` (B1-012): `TOP_OF_RACK` → `device-switch`, `WAN_GATEWAY` → `device-router`, `WIRELESS_CONTROLLER`/`LOAD_BALANCER` → `device-server`, alongside the router/switch/firewall codes. Unknown/free-form types fall back through the substring families to `device-generic` — no invented semantics.
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
2. **Meaningful standalone icons name themselves via `aria-label`** (re-audit B2-021): a `title` prop on `FayanmsIcon` renders `role="img"` with the `title` as the **primary accessible-name API (`aria-label`)** plus a native `title` attribute (hover affordance only — never the naming mechanism). Icon-only controls still name themselves at the **control** level (`aria-label` on the button), not via the glyph.
3. **Standalone device glyphs get real labels** (re-audit B2-020): `NetworkDeviceIcon` in standalone mode names itself with `deviceIconLabelFor(type)` — e.g. `TOP_OF_RACK` → "Top of rack", `CORE_ROUTER` → "Core router" — from the canonical `DEVICE_ROLE_META` metadata; free-form types resolve to the family name ("Firewall", "Router", …), and unknown types to "Device".
4. **No status by color alone** — status icons always pair with a text label via the status badge components; the glyph itself carries a status name when meaningful.
5. **Semantics live in text, not in the icon choice** — e.g. the danger `action-delete` glyph does not *say* "delete"; the label does.

## 8. Adding or changing an icon (process)

1. New master → 24×24 contract (§1) → dropped into `public/icons/fayanms/`.
2. Registry entry added to the relevant governed map (`navigation-icons` / `vendor-icons` / `device-icons`) — `FayanmsIconName` is generated from the directory and a stale union fails `bun run brand:validate-icons`. The navigation registry is also **exhaustive at the type level** (`satisfies Record<SidebarViewKey, NavIcon>`, B2-025): a missing *or extra* sidebar key is a compile error, not a runtime gap.
3. Catalog row added to [ICON-CATALOG.md](./ICON-CATALOG.md) with one-line semantics + recommended semantic token — **catalog parity is enforced** (B1-009): a disk master without a row, a phantom row, a duplicate row, or a row-count mismatch is a hard failure.
4. `bun run brand:validate-icons` green before merge.

What the validators actually enforce today (the scripts are the authority — if this document and a script disagree, fix the doc or the script, never hand-wave the check):

- **Geometry**: the exact Tier-2 root contract on all 228 masters, byte-verbatim attribute values, prohibited features (gradients/filters/styles/scripts/animation/external refs) and hardcoded colors — checked by both `brand:validate` and `brand:validate-icons`.
- **Set parity**: disk masters ≡ `FayanmsIconName` union ≡ catalog rows (exact sets, no duplicates).
- **Vendors**: validation is **derived from the adapter registry** (`driverCatalog` in `src/lib/vendors/drivers.ts`, B1-011) — a new adapter fails the gate until its governed glyph + label + mapping exist; unknown keys must fall back to `vendor-generic`.
- **Device roles**: every `DEVICE_ROLE_META` entry must resolve to its declared glyph with a real label (B1-012); the previously-generic composite roles must stay specific; unknown types must still fall back to `device-generic`.
- **Orphans** (B1-010): masters that are cataloged/registered but not yet referenced by any runtime surface are reported as **warnings**, not failures — the kit is a reusable catalog and there is no must-use list yet. Referenced-but-missing masters remain hard failures.
