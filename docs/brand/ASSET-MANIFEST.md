# FayaNMS — Brand Asset Manifest

**Status:** Phase B2 deliverable · complete governance inventory for every FayaNMS brand/asset file
**Source of truth:** `src/lib/brand/identity.ts` (`FAYANMS_BRAND.assets` is the canonical path map — this document mirrors it, the code wins on conflict)
**Licensing status for every asset below:** **FayaNMS original project asset** — designed for this project, no third-party rights, no vendor trademarks (see [VENDOR-GLYPHS.md](./VENDOR-GLYPHS.md)).

---

## 1. Tier 1 — Brand masters (`public/brand/`)

Governed masters; treat as immutable artifacts — regenerate or replace via the pipeline, never hand-edit in place.

| Canonical name | Category | Source | Usage | Min size | Allowed tones | Accessibility role |
|---|---|---|---|---|---|---|
| `fayanms-mark.svg` | Product mark | FayaNMS original (B0) | Primary product mark on app surfaces; inline via `FayanmsMark` (currentColor) | 20 px (16 px only as favicon derivative) | currentColor (in-app); brand primary in static contexts | Decorative when beside the wordmark; `role="img"` + "FayaNMS" when standalone |
| `fayanms-mark-mono.svg` | Product mark (mono) | FayaNMS original (B0) | Print, export, low-color contexts | 20 px | Pure black `#000` only | Decorative / `role="img"` as above |
| `fayanms-mark-white.svg` | Product mark (white) | FayaNMS original (B0) | Dark or photographic backgrounds (NOC wallboard, social cards) | 20 px | Pure white `#FFF` only | Decorative / `role="img"` as above |
| `fayanms-wordmark.svg` | Wordmark | FayaNMS original (B0) | Standalone wordmark master only — **in-app wordmark is real text** (`FayaNMSWordmark`) | 64 px rendered height not required; text is the runtime form | Brand neutral text color | Real text is the accessible form; this file is regenerable, not the runtime SoT |
| `fayanms-wordmark-white.svg` | Wordmark (white) | FayaNMS original (B0) | Dark-background placements | As above | Pure white | As above |
| `fayanms-lockup-horizontal.svg` | Lockup | FayaNMS original (B0) | External horizontal placements: README header, docs, social | 32 px header / 64 px+ docs | Brand primary + neutral text | Decorative image carrying alt "FayaNMS — Network Operations Management" |
| `fayanms-lockup-horizontal-white.svg` | Lockup (white) | FayaNMS original (B0) | Horizontal lockup on dark backgrounds | 32 px | White + brand accent tones | As above |
| `fayanms-lockup-stacked.svg` | Lockup (stacked) | FayaNMS original (B0) | Square/vertical placements: app icons, avatars, OG cards | 40 px | Brand primary + neutral text | As above |
| `fayanms-noc-mark.svg` | Sub-brand mark | FayaNMS original (B0) | NOC wallboard / operations-center context **only** — a sub-brand, not a second logo | 32 px | Brand primary / white | Decorative; the "NOC" text label carries meaning |
| `fayanms-network-shield.svg` | Secondary symbol | FayaNMS original (B0) | Security / protected-configuration context (encryption, audit) — never a logo substitute | 24 px | Brand primary / currentColor | Decorative; paired with explanatory text |

Rules that apply to all Tier 1 files: no stretch/skew/rotate/shadow/animation; no status recoloring; clear space ≈ one node diameter; variant tones are exclusive (mono = black only, white = white only, color = brand tokens only). Full list: [BRAND-GUIDELINES.md §3](./BRAND-GUIDELINES.md).

## 2. Tier 2 — Icon masters (`public/icons/fayanms/`)

Exactly **228 SVG masters** (216 kit v1 + 12 kit v2) — the governed catalog is [ICON-CATALOG.md](./ICON-CATALOG.md); geometry/color contract and renderer in [ICONOGRAPHY.md](./ICONOGRAPHY.md).

| Property | Governance value |
|---|---|
| Geometry | 24×24 viewBox, `fill="none"`, `stroke="currentColor"`, stroke-width 2, round caps/joins |
| Color | Colorless masters; semantic token applied by the consumer |
| Naming | Kebab-case, matches the generated `FayanmsIconName` union |
| Registries | `src/lib/icons/navigation-icons.ts`, `vendor-icons.ts`, `device-icons.ts` (consumers never reference raw paths) |
| Renderer | `src/components/icons/fayanms-icon.tsx` (CSS mask + currentColor; sizes xs 14 / sm 16 / md 20 / lg 24 / xl 32) |
| Licensing | FayaNMS original project assets; vendor-* glyphs are project adapter glyphs, **not** vendor trademarks |

## 3. App metadata files (browser/OS identity)

| File | Kind | Usage | Notes |
|---|---|---|---|
| `src/app/icon.svg` | File-based favicon (Next metadata) | Browser tab / bookmark icon | FayaNMS mark geometry with brand primary `#2563EB`; replaced the removed external Z-AI favicon (audit BRAND-001) |
| `src/app/apple-icon.*` | `ImageResponse` component (added in B2) | iOS home-screen icon | **Generated, not hand-drawn** — re-rendered from brand tokens; regenerate-not-edit policy |
| `src/app/opengraph-image.*` | `ImageResponse` component (added in B2) | OG social card | Brand primary emphasis, neutral enterprise surface, no fake vendor logos |
| `src/app/twitter-image.*` | `ImageResponse` component (added in B2) | X/Twitter card (`summary_large_image`) | Same construction as OG card |
| `src/app/manifest.ts` | Web app manifest route (`/manifest.webmanifest`) | PWA identity: name/short_name from `FAYANMS_BRAND`, `theme_color: #2563EB`, `background_color: #FFFFFF`, 192/512 + maskable icons | Semantic status colors are never used as manifest/theme colors |
| `src/app/layout.tsx` metadata | Metadata SoT consumer | Title template `%s · FayaNMS`, description, OG/Twitter, `viewport.themeColor: #2563EB` | All strings/colors from `FAYANMS_BRAND`; no hand-built brand strings |

## 4. Raster derivatives (generated by `bun run brand:raster`)

Produced from the Tier 1 masters via sharp (`scripts/generate-brand-raster-assets.ts`). **Regenerate — never hand-edit:**

| Generated file | Size | Source | Usage |
|---|---|---|---|
| `public/brand/app-icon-192.png` | 192×192 | Stacked lockup / mark | PWA manifest icon |
| `public/brand/app-icon-512.png` | 512×512 | Stacked lockup / mark | PWA manifest icon, store-style slots |
| `public/brand/app-icon-maskable-192.png` | 192×192 (safe-zone padded) | Mark | Manifest `purpose: "maskable"` |
| `public/brand/app-icon-maskable-512.png` | 512×512 (safe-zone padded) | Mark | Manifest `purpose: "maskable"` |
| `public/brand/favicon.ico` | Multi-size ICO (16/32/…) | Simplified mark | Browser favicon fallback for agents/browsers that ignore SVG icons |
| `public/brand/github-social-preview.png` | **1280×640** | Lockup composition | GitHub repository social preview (upload is a GitHub-settings action — see [SOCIAL-REPOSITORY.md](./SOCIAL-REPOSITORY.md)) |

## 5. Validation contract

Two scripts gate brand integrity (wired into `package.json` in Phase B2). They are the enforcement
authority; if a check here and the script disagree, the script wins and this document gets fixed.

### `bun run brand:validate` (`scripts/validate-brand-assets.ts`)

Fails when:

- a file listed in `FAYANMS_BRAND.assets` is missing from `public/brand/`, or an **ungoverned extra** file appears there;
- a master is not a parseable SVG or lacks the expected geometry (viewBox, paint attributes) for its variant;
- **tone drift** — the color masters carry anything but the brand palette (`#2563EB` / `#1D4ED8` / `#0891B2`), mono is not pure black, white is not pure white, or any master contains semantic status colors (success/warning/danger families);
- the wordmark no longer matches the canonical brand name/descriptor strings;
- declared raster derivatives (§4) are missing or stale dimensions (e.g. social preview ≠ 1280×640) after `brand:raster` has been run.

### `bun run brand:validate-icons` (`scripts/validate-icon-registry.ts`)

Fails when:

- a master under `public/icons/fayanms/` breaks the geometry contract (wrong viewBox, non-`none` fill, non-`currentColor` stroke, stroke-width ≠ 2, missing round caps/joins);
- the master set and the generated `FayanmsIconName` union / governed registries diverge in either direction (registry key without file, file without registry/catalog coverage);
- names are not kebab-case, or a governed icon path is referenced outside the renderer/registries;
- the catalog ([ICON-CATALOG.md](./ICON-CATALOG.md)) total no longer matches the master count (currently **228**).

### `bun run brand:raster` (`scripts/generate-brand-raster-assets.ts`)

Not a validator — the generator for §4. Re-run after any Tier 1 master change; commit its output; do not edit PNG/ICO outputs by hand.

---

## 6. Change process

1. Tier 1 change → update master + `identity.ts` (if paths/colors change) → run `brand:validate` → run `brand:raster` → update this manifest row.
2. Tier 2 change → follow [ICONOGRAPHY.md §8](./ICONOGRAPHY.md) → run `brand:validate-icons` → update catalog + count.
3. Any new vendor glyph → additionally follow [VENDOR-GLYPHS.md](./VENDOR-GLYPHS.md) (project-glyph rule and future-upgrade record).
