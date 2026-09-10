# ADR — Brand & Icon Architecture (Three-Tier System, Governed Masters, Mask Renderer)

**Status:** Accepted (Phase B0/B1 implementation, Phase B2 documentation)
**Date:** 2026-09-10 (audit) → Phase B0/B1/B2 (implementation/docs)
**Deciders:** FayaNMS project (Phase B plan `upload/faya-package/FayaNMS-Icons-Brand-Full-Audit-Enhancement-Plan-2026-09-10.md`)
**Scope:** product brand identity, icon system, app metadata, asset governance

---

## Context

The 2026-09-10 repository brand/iconography audit (`docs/audits/`, plan scorecard) graded
FayaNMS **52/100 — "coherent design system, fragmented product identity"**, with three
specific failures:

1. **Three conflicting identities at the audited commit:**
   - the browser favicon pointed to an **external ChatGLM/Z-AI logo** (audit BRAND-001 — an unrelated third-party identity fetched on every load);
   - the sidebar and sign-in screen used the Lucide **`Waypoints`** glyph as a temporary product mark;
   - `public/logo.svg` was a separate dark **animated Z-style template mark** unrelated to the blue/cyan network-operations identity.
2. **A 216-icon FayaNMS Enterprise custom icon kit existed under `upload/` but was unintegrated** — "Custom domain icon integration: 20/100", "Device-type iconography: 45/100", "Vendor/adapter iconography: 30/100". Device/vendor surfaces were text-only or generic.
3. **No governance loop** — no canonical manifest, no validation pipeline, no raster derivatives (favicon ICO, PWA app icons, social preview); GitHub/repository brand presence scored 30/100.

Two things were already strong and had to be preserved: the Lucide discipline for generic UI
(88/100) and the centralized, semantic status system (`src/lib/domain/status.ts` +
`status-icon.tsx`, 92/100).

## Decision

1. **Three-tier icon architecture.**
   - **Tier 1 — Brand assets:** canonical mark, mono/white marks, wordmark, lockups (horizontal / horizontal-white / stacked), NOC mark (sub-brand), network-shield (secondary symbol), favicon/app icon, social cards. Masters live in `public/brand/`; runtime rendering via `src/components/brand/*` components; the wordmark is **real text**, never an image.
   - **Tier 2 — FayaNMS domain/device/vendor icons:** the custom kit's masters govern NMS-specific concepts (domain views, device types, vendor adapter glyphs, protocols, change/ops/perf/report surfaces, actions, statuses-as-glyphs). Masters live in `public/icons/fayanms/`; consumption is only through the governed registries (`src/lib/icons/{navigation-icons,vendor-icons,device-icons}.ts`).
   - **Tier 3 — Lucide generic UI + status:** Lucide is **retained** for generic controls (chevrons, close, search, theme, user) and the existing status registry. Replacing all Lucide icons was rejected (see Alternatives).
2. **Brand single source of truth in code:** `src/lib/brand/identity.ts` (`FAYANMS_BRAND`) — name, descriptor, edition, colors (`#2563EB` / `#1D4ED8` / `#0891B2`), asset paths, repository URL. No surface constructs brand strings by hand.
3. **Mask-based custom icon renderer:** `src/components/icons/fayanms-icon.tsx` renders masters via CSS `mask` + `currentColor` (server-safe, isomorphic) instead of inlining SVG or bundling an icon font. Masters stay colorless; semantic color is applied by consuming tokens; dark mode is free.
4. **File-based Next.js metadata:** the external Z-AI favicon was removed; `src/app/icon.svg` (file-based), `manifest.ts` (theme `#2563EB`, white background, 192/512 + maskable icons), viewport `themeColor: #2563EB`, and `ImageResponse`-generated apple-icon / opengraph-image / twitter-image supply all browser/OS/social identity locally.
5. **Governance by scripts, not prose:** `brand:validate` (brand masters: presence, geometry, tone), `brand:validate-icons` (228-master geometry contract + registry/catalog sync), `brand:raster` (sharp-generated app icons, maskable variants, favicon ICO fallback, `github-social-preview.png` 1280×640). Raster derivatives follow a **regenerate-not-hand-edit** policy.
6. **Vendor glyphs are project adapter glyphs** — explicitly *not* official vendor trademarks, with the naming/mapping/upgrade policy recorded in `docs/brand/VENDOR-GLYPHS.md`.

## Consequences

- **228 governed masters** (216 kit v1 + 12 kit v2: `firmware`, `zero-touch-provisioning`, `cmdb`, `flow-analytics`, `predictive-health`, `vendor-juniper`, `vendor-palo-alto`, `ask-network`, `ai-rca`, `collector-rebalance`, `failover-test`, `configuration-encrypted`), one geometry contract (24×24, `fill:none`, `stroke:currentColor`, width 2, round caps/joins).
- **Validation scripts gate the system** — a disk master without union/catalog coverage, a union entry or catalog row without a master, geometry drift, a stale generated derivative, or a non-palette color in the generated brand-colored masters fails the validators (runtime-unused masters are reported as warnings, not failures — B1-010). The scripts are the enforcement authority; docs follow them.
- **Raster derivatives are build output:** the PNG files under `public/brand/` and the favicon ICO at `src/app/favicon.ico` are regenerated by `brand:raster`; hand edits are overwritten and forbidden.
- **Zero icon bundle cost / theme-adaptive rendering** — icons are cached static files painted with inherited text color; the trade-off is no multi-color Tier 2 icons (accepted: only Tier 1 artwork is brand-colored, rendered via `<img>`/components).
- **The pre-B0 identities are dead ends:** the external Z-AI favicon, the `Waypoints`-as-mark usage, and `public/logo.svg` are removed from the identity and must not return (do-not list in `docs/brand/BRAND-GUIDELINES.md`).
- **Audit target:** the plan's stated goal is lifting the brand scorecard from 52/100 to 90+/100; the remaining manual steps are repository-settings actions (GitHub topics, social-preview upload, Website URL — see `docs/brand/SOCIAL-REPOSITORY.md`).

## Alternatives considered

### A. Replace all Lucide icons with the custom kit
Rejected. The audit scored generic-UI icon consistency 88/100 and status 92/100 precisely
because Lucide + the centralized status registry already work. A wholesale replacement would
have traded a proven, accessible, familiar control language for 1:1 redraws of generic glyphs
(edit, delete, search, chevrons), multiplied maintenance, and broken zero third-party-code
assumptions for no identity gain. The kit's value is **NMS-specific semantics**, which is what
Tier 2 now carries.

### B. Use official vendor logos
Rejected. Official logos bring trademark/brand-policy obligations (permitted use, colors,
clear space, review cycles) the project cannot satisfy today, would visually privilege
individual vendors in a multi-vendor product, and would contradict the honest "adapter
certification pending" status. Uniform project adapter glyphs keep the adapter registry
legible and legally clean. The future-upgrade path remains documented in
`docs/brand/VENDOR-GLYPHS.md` §3 if this is ever revisited.

### C. Bitmap icon fonts / bundling icons into JS
Rejected. Icon fonts binary-encode glyphs (ungreppable masters, poor diffing, licensing
ambiguity in rebuilds), lose `currentColor` mask fidelity, and bundling per-icon React/SVG
trees costs bundle bytes for no benefit over cached static files. CSS `mask` + `currentColor`
over static masters achieves theme adaptivity with zero bundle cost and keeps the master file
as the single source for runtime, catalog, and raster pipeline.

## References

- `docs/brand/` — BRAND-GUIDELINES, ICONOGRAPHY, ICON-CATALOG, ASSET-MANIFEST, VENDOR-GLYPHS, SOCIAL-REPOSITORY, ACCESSIBILITY
- `src/lib/brand/identity.ts` · `src/components/brand/*` · `src/components/icons/*` · `src/lib/icons/*`
- `public/brand/README.md` (asset table) · `docs/design-governance.md` (tokens, accessibility baseline)
- Audit: `upload/faya-package/FayaNMS-Icons-Brand-Full-Audit-Enhancement-Plan-2026-09-10.md` (scorecard 52/100; three-identity finding)

---

## Re-audit governance completion (2026-09-10)

The full re-audit (`upload/FayaNMS-Brand-Icon-ReAudit-Full-2026-09-10.md`) found the docs ahead of
the enforcement and several identity-composition regressions. Remediation (tasks R1/R2-a/R2-b/R2-c)
landed the following; this ADR records the now-real state.

1. **One mark geometry, everywhere (B1-005/006).** `src/lib/brand/mark-geometry.ts` (`MARK_GEOMETRY`
   + `MARK_MICRO_GEOMETRY`) is the single geometric source feeding the runtime `FayaNMSMark`
   component, the satori metadata artwork (apple-icon / OG / Twitter via the shared
   `src/components/brand/social-card.tsx`), the raster generator, and the static mark-family SVG
   masters. `brand:validate` re-derives every generated SVG byte-for-byte and every PNG
   pixel-for-pixel through the shared composition module (`scripts/brand-raster-composition.ts`,
   the exact `brand:raster` code path) — stale derivatives fail the gate.
2. **Lockup is the only composition (B1-003).** `FayaNMSLockup` gained the `tiled` variant
   (sidebar / mobile drawer / sign-in; `tileSize="md"|"lg"`) and `descriptorOverride` — the only
   sanctioned localization path for the descriptor line. Sidebar (expanded/collapsed), sign-in,
   mobile drawer and loading screen all render canonical lockup/mark components; `Waypoints` no
   longer appears in any brand surface (topology-semantics uses are allowlisted in the consumer
   scanner). No screen hand-assembles mark + name.
3. **Social cards consolidated and gradient-free (B1-007/B2-024).** OG and Twitter are thin
   wrappers over one shared composition using identity colors and a **solid primary/accent split**
   — no gradients — enforced by a `brand:validate` guard.
4. **Micro favicon (B1-014).** The documented "simplified micro-mark" policy is implemented:
   `MARK_MICRO_GEOMETRY` (same ring, solid nodes, solid simplified hub, no connectors) drives
   `fayanms-mark-micro.svg`, `src/app/icon.svg` and the 16/32/48 ICO tiles in the canonical
   `src/app/favicon.ico` (manifest favicon path corrected, B2-026). `brand:validate` proves
   `icon.svg` contains no connectors.
5. **Device-role metadata (B1-012).** `src/lib/icons/device-role-meta.ts` (`DEVICE_ROLE_META`) is
   the canonical role source (label/icon/family); `deviceIconFor()` is meta-first with substring
   fallback, so the formerly-generic roles (TOP_OF_RACK, WAN_GATEWAY, WIRELESS_CONTROLLER,
   LOAD_BALANCER, …) keep governed glyphs and real labels.
6. **Accessibility contract (B2-020/021).** `FayanmsIcon` uses `aria-label` as the primary
   accessible-name API (native `title` is hover-only); decorative default `aria-hidden`;
   icon-only buttons name themselves at the control level; standalone `NetworkDeviceIcon` names
   itself via `deviceIconLabelFor()` (e.g. "Top of rack").
7. **Strengthened validators (B1-008/009/010/011/012, §9–§11).** `brand:validate`: exact Tier-1
   inventory, geometry-derivation staleness, SVG safety, exact Tier-2 root contract on all 228
   icons, `FAYANMS_BRAND`-derived color validation, sharp raster dimensions + stale pixel/byte
   comparison + ICO structural parse, metadata and no-gradient guards, micro-mark proof.
   `brand:validate-icons`: union ≡ disk ≡ catalog-row parity, sidebar-key resolution,
   vendor validation derived from the real adapter registry (`driverCatalog`), device-role
   metadata checks, and the honest orphan policy (runtime-unused masters warn, never fail —
   cataloged/registered/runtime-referenced model, B1-010). New `brand:validate-consumers` scans
   `src/**` for the re-audit regressions: Waypoints in brand contexts (topology allowlist),
   identity literals, raw brand hex outside the SoT, raw icon URLs, external identity URLs,
   duplicated mark geometry signatures.
8. **CI (B0-002) and ownership (B1-017).** The active workflow is
   `.github/workflows/ci.yml` (job `gate`: lint, src-zero-error typecheck, tests, prisma, i18n
   parity, production build, `brand:validate` / `-icons` / `-consumers`; job `scan`: gitleaks,
   semgrep, osv-scanner, syft, trivy). `docs/ci/ci-gate.yml` is a pointer document, not a
   workflow. **Honest activation caveat:** brand governance is *not yet CI-enforced* — pushing a
   workflow requires a `workflow`-scoped token, and branch protection/required checks are
   settings-side actions (tracked in `docs/brand/SOCIAL-REPOSITORY.md` §6). Brand paths are
   protected by a CODEOWNERS section (`.github/CODEOWNERS`).
