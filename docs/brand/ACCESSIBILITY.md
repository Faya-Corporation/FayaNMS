# FayaNMS — Brand & Icon Accessibility Contract

**Status:** Phase B2 deliverable · the accessibility rules brand and icon surfaces must satisfy
**Baseline:** WCAG 2.2 AA is the project target (see `docs/design-governance.md` §5–§6 for per-criterion status and the honest QA matrix)
**Related:** [ICONOGRAPHY.md](./ICONOGRAPHY.md) · [BRAND-GUIDELINES.md](./BRAND-GUIDELINES.md) · `src/components/icons/fayanms-icon.tsx` (renderer semantics)

---

## 1. Decorative vs meaningful icons

The renderer bakes the decision into the component: passing a `title` renders `role="img"` +
accessible name; omitting it renders `aria-hidden="true"`. Every other icon component
(`DomainIcon`, `NetworkDeviceIcon`, `DeviceVendorIcon`, `FayanmsMark`/lockups) defaults to
decorative.

**Rule:** if the information is available as visible text right next to the icon, the icon is
decoration and must be hidden from assistive tech (no duplicate announcements).

```tsx
// ✅ Decorative — the text carries the meaning
<button type="button">
  <FayanmsIcon name="action-refresh" size="sm" aria-hidden />
  <span>Refresh</span>
</button>

// ✅ Decorative domain/vendor glyphs in a table row (default behavior)
<NetworkDeviceIcon deviceType={device.role} />          {/* aria-hidden by default */}
<DeviceVendorIcon vendorKey={device.vendor?.key} />     {/* aria-hidden by default */}
<span>{device.hostname}</span>

// ❌ Wrong — same info announced twice
<button type="button">
  <FayanmsIcon name="action-refresh" size="sm" title="Refresh" />
  <span>Refresh</span>
</button>
```

## 2. Icon-only controls

A control whose **only** content is an icon must expose an accessible name — via the icon's
`title` (which upgrades it to `role="img"` with a name) **and** the control's own label:

```tsx
// ✅ Icon-only action: named at the control level, tooltip text kept consistent
<Button
  variant="ghost"
  size="icon"
  aria-label="Download configuration snapshot"
  title="Download configuration snapshot"
>
  <FayanmsIcon name="download-config" size="sm" title="" aria-hidden />
</Button>

// ❌ Wrong — unnamed icon-only button
<Button variant="ghost" size="icon">
  <FayanmsIcon name="download-config" size="sm" />
</Button>
```

For brand surfaces, the standalone mark gets `role="img"` + "FayaNMS" only when it appears
**without** the wordmark; lockups render a single image alt (`"FayaNMS — Network Operations
Management"`) and are otherwise decorative.

## 3. Status: never color alone

- Status and severity are always **icon + text label** through the config-driven badge family
  (`StatusBadge`, `DeviceStatusBadge`, `SeverityBadge`, `ChangeStatusBadge`, …), resolved from
  the single SoT `src/lib/domain/status.ts`. `withIcon={false}` is allowed only in tight table
  cells where the label remains.
- Status dots are always paired with a visible label.
- **Brand marks are never recolored to signal state** ([BRAND-GUIDELINES.md §3.3](./BRAND-GUIDELINES.md)) — state lives in the status components.
- Semantic colors are applied as token pairs (`bg-*-subtle text-*`) so badges survive layering
  in both themes; `info` sharing the primary hue is a token decision, not a reason to tint logos.

```tsx
// ✅ Status = glyph + label + semantic token (color redundant, never sole carrier)
<StatusBadge status="degraded" />   // icon + "Degraded" text + warning token pair
```

## 4. Protocol & capability glyphs

Protocol icons follow the **`[icon] NETCONF`** pattern ([ICONOGRAPHY.md §5](./ICONOGRAPHY.md)):
glyph decorative, protocol name as visible text. Abbreviations are never conveyed by geometry
alone, which also keeps screen-reader output exact ("NETCONF", not "three-node diagram").

## 5. Reduced motion

- **Brand surfaces never animate.** The master marks/lockups are static files; the animated
  template mark that used to sit at `public/logo.svg` is exactly what the B0 audit removed.
  No pulse/spin/breathe effects may be added to marks, lockups, favicons or app icons.
- Product motion (view transitions, motion-provider surfaces) must keep respecting
  `prefers-reduced-motion` as governed by `docs/design-governance.md`; the NOC wallboard and
  sign-in brand placements inherit that behavior, not their own.

## 6. RTL mirroring policy

- Directional/flow icons (chevrons, arrows, step indicators) **may mirror** under `[dir="rtl"]`.
- Brand marks/lockups, device-type glyphs and vendor adapter glyphs **never mirror**
  ([ICONOGRAPHY.md §6](./ICONOGRAPHY.md)) — identity and object artwork is direction-neutral.
- Mirroring is applied by consuming CSS (`rtl:` variants), never by shipping mirrored masters,
  so the governed file set stays exactly one master per concept.

## 7. Contrast expectations

- FayaNMS icons are painted with `currentColor` (CSS mask) or inherit text color via inline
  components — they **inherit the text tokens that already pass WCAG 2.2 AA** for body/secondary
  text in both themes. Introducing a fixed color on an icon breaks this guarantee and is a
  governance violation.
- Brand asset masters (`public/brand/`) use the brand palette (`#2563EB` / `#1D4ED8` /
  `#0891B2`) on approved surfaces; dark/photographic placements use the pure-white variant.
  Social/OG cards keep body contrast ≥4.5:1 like every other surface.
- Icon-only hit areas: controls stay ≥24px targets per the design-governance accessibility
  baseline; the icon inside may be 14–20px.

## 8. Review checklist (per surface)

1. Every icon either `aria-hidden` beside its text, or named when standalone/icon-only.
2. No status conveyed by color alone; badges carry labels.
3. No brand asset animated or status-reclored.
4. RTL check at 375px: mirrored only where allowed, no overflow.
5. Contrast: icon inherits AA-passing text token; no ad-hoc colors.
