# FayaNMS — Design Governance

**Status:** v1.0 · Phase 8-b deliverable · owner: frontend-styling-expert
**Scope:** the design system rules every FayaNMS surface must follow, the WCAG 2.2 AA
accessibility standard with current status, and the full QA matrix executed at Gate G8.

Sources of truth:

- Tokens — `src/app/globals.css` (single `@theme inline` mapping + `:root` / `.dark` / density blocks)
- Status semantics — `src/lib/domain/status.ts` (single source of truth for status/severity maps)
- Domain primitives — `src/components/domain/*`
- shadcn primitives — `src/components/ui/*` (New York style; do not restyle per-view)

---

## 1. Design tokens

### 1.1 Color

| Family | Light | Dark | Tokens |
|---|---|---|---|
| Neutrals | bg `#FAFAFA`, surface `#FFFFFF`, border `neutral-200`, text `neutral-950/600/500` | bg `#0A0A0A`, surface `#171717` (never absolute black), border `neutral-800`, text `neutral-50/400` | `--background --foreground --surface --surface-subtle --border --muted-foreground` |
| Brand | primary `#2563EB` (hover `#1D4ED8`), accent `#0891B2` (dark `#22D3EE`) | same hues, accent brightened for dark-surface legibility | `--primary --primary-hover --brand-accent` |
| Status families | success `#15803D` · warning `#B45309` · danger `#DC2626` · danger-orange `#EA580C` · info `#2563EB` · neutral `#525252` | brightened (`#4ADE80`, `#FBBF24`, `#F87171`, `#FB923C`, `#60A5FA`, `#A3A3A3`) | `--success --warning --danger --danger-orange --info --neutral` each with `-foreground` and `-subtle` (color-mix translucent fill) |
| Severity scale | aliases of the status families: Critical→danger, High→danger-orange, Medium→warning, Low→info, Info→neutral (identical mapping app-wide) | | `--severity-*` |
| Charts | brand-first series: `#2563EB #0891B2 #16A34A #D97706 #7C3AED` | brightened variants | `--chart-1..5` |

Rules:

- Accent (`--brand-accent`) is used sparingly — links, chart emphasis, focus — never large backgrounds.
- shadcn's `--accent` hover surface stays neutral on purpose.
- Status is **never color-only**: badges always pair icon + text; dots pair with a visible label.
- Use the `bg-*-subtle text-*` pairing for badge/pill fills so badges survive layering in both themes.

### 1.2 Spacing & density

Density is a `data-density` attribute on `<html>` (`comfortable` default, `compact`, `dense`).
It adjusts geometry only — font sizes never change.

| Var | comfortable | compact | dense |
|---|---|---|---|
| `--density-row-h` | 44px | 36px | 28px |
| `--density-control-h` | 36px | 32px | 28px |
| `--density-toolbar-h` | 48px | 40px | 36px |
| `--density-pad` (card padding) | 16px | 12px | 8px |
| `--density-cell-x` (table cell x-pad) | 12px | 10px | 8px |

Named utilities: `p-card`, `px-cell-x`; raw vars via `h-(--density-row-h)` in table rows.
Layout uses logical utilities in direction-aware markup (`ms-* me-* ps-* pe-* start-* end-*`), never `ml-/mr-/pl-/pr-`.

### 1.3 Radius

small controls 6px (`--radius-sm`) · inputs/buttons 8px (`rounded-md`) · cards/KPI 10px (`rounded-xl`) · dialogs/sheets/panels 12px (`rounded-lg`).

### 1.4 Elevation & typography

- Elevation is subtle: `--elevation-1` cards, `e2` menus/popovers, `e3` dialogs/command palette; dark theme uses stronger alphas.
- Typography: **Inter** (UI, `--font-sans`) + **JetBrains Mono** (technical, `--font-mono`).
  Technical data (IPs, MACs, CLI, config, IDs, timestamps in dense rows) uses the `font-tech` utility:
  mono family, 0.8125rem, tabular-nums so numeric columns align.
- Typeface sizes: page title `text-xl/2xl semibold`, section titles `text-sm semibold`, body `text-sm`,
  metadata `text-xs`, chip/caption `text-[11px]`. No other sizes without a governance change.

### 1.5 Iconography

- **lucide-react** only, stroke style, sizes from the 3.5/4/4.5/5 scale (`size-3.5` inline, `size-4` buttons).
- All decorative icons are `aria-hidden="true"` (lucide defaults to hidden; the domain components pass it explicitly).
- Status icon resolution goes through `src/components/domain/status-icon.tsx` (name → component registry).

---

## 2. Dark mode strategy

- Class-based (`next-themes`, `attribute="class"`, `defaultTheme="system"`, `disableTransitionOnChange`).
- `.dark` block re-maps the same token names — components never branch on theme in code.
- Dark surfaces are **layered neutrals, never absolute black** (bg `#0A0A0A`, surface `#171717`).
- Brand accent brightens to `#22D3EE`; status colors brighten and flip `-foreground` to dark-on-light for badge contrast.
- Translucent `-subtle` badge fills (color-mix) keep badges layered over any surface in both themes.
- The NOC wallboard is intentionally dark-styled in both themes (`bg-neutral-950 dark:bg-black`); it must keep
  ≥4.5:1 body contrast — its palette is fixed, not token-driven, and is part of this governance scope.

## 3. Direction (LTR/RTL) strategy

- Technical islands (IPs, config, IDs) render LTR inside RTL pages via the `ltr-technical` utility
  (`direction: ltr; unicode-bidi: isolate`) + `font-tech`.
- Spacing in direction-aware markup uses logical utilities only (`ms/me/ps/pe/start/end`).
- Arabic legibility rule (Phase 8-b): `[dir="rtl"]` neutralizes `letter-spacing` (tracking utilities) for all
  text except `.ltr-technical`/`.font-tech`/code — Arabic script is cursive and must never be letter-spaced.
- Dictionaries live in `messages/**` (next-intl, EN/AR); tech blocks stay LTR (Phase 8-a).

---

## 4. Component conventions

| Component | Contract |
|---|---|
| `PageHeader` | The **only** source of an `h1` per view. Breadcrumbs → title (`h1`, truncate) → description → action row (≤1 primary action, rendered last/right; ≤2–3 secondary). Stacks below `md`. |
| `KpiCard` | Label + big value + optional icon + trend chip (up/down/flat with `positive` semantics so "down" can be good) + live `StatusDot` + description. Loading skeleton built-in. |
| `SectionCard` | Standard content card: `rounded-xl border bg-card shadow-e1`, header (title `h2` + description + actions), density-aware `p-card` content. Section titles are always `h2` under the view `h1`. |
| `StatusBadge` / family badges (`DeviceStatusBadge`, `SeverityBadge`, `ChangeStatusBadge`, `ChangeRiskBadge`, `BackupStatusBadge`, `DriftStatusBadge`, `JobStatusBadge`, `SlaChip`) | Config-driven from `status.ts`: subtle token bg + token icon + **text label** (never color-only). `withIcon={false}` allowed only in tight table cells where the label remains. |
| `StatusDot` | Decorative (`aria-hidden`) unless a `label` is passed; pulse only for live/running states; always paired with nearby visible text. |
| `EmptyState` | Icon + title + one-sentence guidance + optional CTA; no blame language; used for every zero-data branch. |
| `ErrorState` | `role="alert"`; title, human-readable reason, correlation ID, Retry escape hatch. Never blames the user. |
| `TimeRangeSelect` | Shared 15m→custom range select, `aria-label="Time range"`; perf views use the `PerfRangeChips` segmented group (`role="group"` + `aria-pressed`). |
| `FilterChip` | Removable "Field: Value ×" chip; remove button carries `aria-label="Remove filter Field: Value"` and a ≥24px hit area. |
| `HighRiskActionDialog` | Typed-confirmation gate for destructive actions: impact `dl`, phrase match enables confirm, busy/success/error phases, Radix focus trap. |
| Tables | shadcn `Table` primitives; every table carries an `aria-label` naming what it shows; rows are 44/36/28px by density; icon-only row actions always have contextual `aria-label`s. |
| Charts | Recharts, token colors, `ChartSummary` wrapper (`role="img"` + honest `aria-label` + optional sr-only summary). |
| Charts & data honesty | Chart labels never fabricate values; static honest descriptions where dynamics are unavailable. |

View assembly: `PageHeader` → KPI row → content grid (`SectionCard`s) → toolbar filters above tables.
Interactive rows/cards: real `<button>`s (NOC tiles, utilizer rows); selectable table rows are focusable
with Enter/Space parity (see capacity view pattern).

---

## 5. Accessibility standards — WCAG 2.2 AA checklist

| Criterion | Requirement | Mechanism | Status |
|---|---|---|---|
| 1.1.1 Non-text content | Chart alternatives | `ChartSummary` wrapper: `role="img"` + honest `aria-label` + sr-only summary; applied to Perf Overview (availability, latency) + Capacity forecast | ✅ owned views · ⚠️ dashboard cards, device health tab, perf-device sparklines pending orchestrator/8-a pass |
| 1.3.1 Info & relationships | Tables, headings | `aria-label` on every data table; `scope="col"` on raw-table `th`; single `h1` per view (PageHeader / detail headers), `SectionCard` renders `h2` | ✅ (raw tables fixed; shadcn `TableHead` lacks auto `scope` — REPORTED, ui/* frozen) |
| 1.4.3 / 1.4.11 Contrast | 4.5:1 text, 3:1 UI | token palette verified light+dark; focus ring ≥3:1 both themes | ✅ |
| 2.1.1 / 2.1.2 Keyboard | Everything operable | all interactive rows/tiles are `<button>` or focusable with Enter/Space; Radix dialogs/menus/tabs trap and restore focus | ✅ |
| 2.4.1 Bypass blocks | Skip link | in-shell skip anchor + `id="main-content"`; reusable `SkipLink` component ready | ✅ (shell-owned) |
| 2.4.7 Focus visible | Consistent ring | global 2px `--ring` outline (accent, brightened in dark) + shadcn `ring-ring/50` opt-out path | ✅ |
| 2.5.8 Target size ≥24px | Hit areas | icon buttons ≥24px (`size-6`+ / `size="icon"` 36px); FilterChip × and saved-view × get invisible `after:-inset-1` hit-area expansion; dense text-link chips covered by the Equivalent/Inline exceptions (same action reachable via popover/row buttons ≥24px) | ✅ documented exceptions |
| 2.3.3 / 2.2 Reduced motion | Animation off | CSS `prefers-reduced-motion` block (0.01ms durations, 1 iteration, auto scroll) + `MotionProvider` (`MotionConfig reducedMotion="user"`) for framer-motion | ✅ (provider mount pending orchestrator) |
| 3.3.2 Labels | Icon-only controls | every icon-only Button carries a contextual `aria-label` ("Edit X", "Delete X", "Approve Technical for CR-…"); decorative SVGs `aria-hidden` (verified, not duplicated) | ✅ |
| 4.1.2 / 4.1.3 Name, role, value; status messages | Semantics | Radix primitives for menus/dialogs/tabs/selects; switches have `aria-label`s; async results surface via `role="alert"`/`aria-live` (HighRiskActionDialog hint, ErrorState) | ✅ |

Known accepted gaps (reported, out of 8-b ownership):

1. `ui/table.tsx` `TableHead` does not add `scope="col"` automatically — callers must pass it; raw tables in
   owned views do. shadcn primitives are frozen this phase → orchestrator decision.
2. shadcn `Checkbox` is `size-4` (16px) — below the 24px target in isolation; mitigated by 44px row heights and
   row-level selection affordances, but a primitive-level bump would be the clean fix.
3. Radix `DialogContent` missing `aria-describedby` dev warning — pre-existing, app-wide, do-not-chase list.
4. Chart-bearing files outside 8-b ownership still need `ChartSummary`: `src/components/dashboard/health-distribution-card.tsx`,
   `src/components/dashboard/utilization-card.tsx`, `src/components/device/device-health-tab.tsx`, plus dashboard-view inline chart
   (`dashboard-view.tsx` is 8-a's file).

---

## 6. QA matrix — Gate G8 (status: PARTIALLY EXECUTED — audit UX-001 remediation)

The original Gate-G8 claim ("executed") preceded durable per-cell evidence — flagged by the
2026-09-09 repository audit (UX-001). The matrix below is now HONEST: a cell is marked only
when browser-verified runs produced recorded evidence; everything else is explicitly not
executed. A cell passes when the view renders without layout breakage
(`scrollWidth === viewport` at 375px), matches the token theme, is fully keyboard-operable,
and respects reduced motion.

Legend: ✅ executed with recorded evidence · ⚠️ executed on a subset of views · — NOT executed yet.

| Width ↓ / Condition → | Light · EN-LTR | Dark · EN-LTR | Light · AR-RTL | Dark · AR-RTL | Keyboard-only | Reduced motion | Zoom 200% |
|---|---|---|---|---|---|---|---|
| **375** (mobile) | ⚠️ Phase 18: topology/interfaces/builder + overflow assert (scrollWidth=375 exact) | ⚠️ same Phase 18 pass | ⚠️ Phase 18 RTL pass incl. sr-only escape fix (782→375) | ⚠️ same Phase 18 pass | — | — | — |
| **768** (tablet) | — | — | — | — | — | — | — |
| **1440** (laptop) | ⚠️ Phase 18 full view set + P19 golden paths (sign-in → dashboard → changes → approvals decide → audit attribution) | ⚠️ Phase 18 pass | ⚠️ Phase 18 pass | ⚠️ Phase 18 pass | ⚠️ structural (radix focus traps in §5) — not scripted | — | — |
| **1920** (wallboard/NOC) | — | — | — | — | — | — | — |

Evidence pointers: `worklog.md` Phase 18 entries (browser matrix + console zero-error records)
and Phase 19-a entries (P19 actor-model golden path: approvals decision recorded under the
authenticated principal, correlationId APR-WDK8QB). Per-cell script (unchanged): load `/`
signed in as admin → cycle each top-level view group → record pass/fail per cell; 375px
additionally asserts no horizontal overflow; NOC asserts fullscreen + wallboard density;
keyboard-only asserts skip link → main content + ⌘K palette; zoom 200% asserts no clipped
controls.

**Status: IMPLEMENTED / PARTIALLY VERIFIED.** Remaining cells (768/1920 rows, keyboard-only,
reduced motion, zoom 200%) are tracked for the Phase 24 UX-certification pass recommended by
the audit; until then this document does not claim full-matrix execution.

## 7. Change management

- New tokens only via PR against `globals.css` with a light **and** dark value plus a consumer;
  never hardcode hex in components.
- New status → add to `status.ts` first (icon, label, badgeClass), then consume via the badge family.
- New views must reuse `PageHeader`/`SectionCard`/`EmptyState`/`ErrorState`; view-local one-offs require a
  governance note in this document.
- shadcn `ui/*` primitives are upgrade-frozen; gaps (e.g. `TableHead` scope, `Checkbox` size) are tracked in §5.
