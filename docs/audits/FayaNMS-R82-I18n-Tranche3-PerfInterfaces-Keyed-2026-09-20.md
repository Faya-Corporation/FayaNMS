# FayaNMS — R82: i18n Tranche 3 — perf-interfaces keyed (2026-09-20)

**Branch:** `main` (single-branch repo since the R81-session cleanup) · **Base:** `11ce607` (R81 docs) · **Suite files:** 76 → 77

## 1. What landed

`perf-interfaces-view.tsx` (the PERFORMANCE → "Interface Utilization" view, view id
`perf.interfaces`) is fully keyed through the NEW `perfInterfaces` namespace — the
R56 `PENDING_VIEWS` debt ledger's third shrink: **23 → 22 entries (748 → 730
candidates)**.

### CORRECTION carried honestly: the ledger sum was 748, not 749

R81's prose (commit message, roadmap row, NEXT-TASKS) quoted "791 → 749 candidates".
Re-derived live at R81 HEAD: the ledger ceilings sum to **748** and the live shallow-
regex candidate count per ledgered file equals its ceiling on every entry — so 748 is
the exact truth and 749 was a prose off-by-one (R80's "791" is corrected the same way
in the sweep header: 824 − 33 = 791 was quoted, the current-baseline arithmetic gives
790). The authoritative numbers live in the sweep's own ledger + the r82 live-sum pin
(`E: the LIVE candidate sum over ledgered files is EXACTLY 730`), computed from the
tree at test time — never quoted.

## 2. The full inventory (hand-cleaned, including the non-swept plane)

The shallow sweep (PROP_RE + JSX_RE) matched **18 candidates**; the hand inventory
keyed every user-visible literal, including the plane the regexes never see:

| Plane | Literal(s) | Key(s) |
|---|---|---|
| PageHeader | `Interface Utilization` | `title` |
| PageHeader template | `` `Per-interface in/out utilization and loss — ${perfRangeLabel(range)}, worst first` `` | `description` (`{range}`) |
| Sort chips (module-level const) | `Utilization`, `Packet loss` | `sort.utilization`, `sort.packetLoss` — `SORT_CHIPS` now carries `labelKey`, resolved via `` t(`sort.${chip.labelKey}`) `` (dynamic-key shape = admin-system's `group.${prefix}` precedent) |
| Sort group | `aria-label="Sort by"` | `sort.groupAria` |
| Toolbar | `Search interfaces` (sr-only), `Search host or ifName…`, `Site` (aria), `Any site`, `Reset` | `toolbar.searchSr`, `toolbar.searchPlaceholder`, `toolbar.siteAria`, `toolbar.anySite`, `toolbar.reset` |
| SectionCard template | `` `Interfaces${listMeta ? ` — ${listMeta.total}` : ""}` `` | `table.cardTitle` / `table.cardTitleCounted` (`{total}`) |
| ErrorState | `Interface performance could not be loaded` | `error.title` |
| EmptyState | `No interface rows to show`, `No interfaces match the current filters, or no samples cover this window.` | `table.emptyTitle`, `table.emptyDescription` |
| Table aria template | `` `Interface performance — utilization in/out, peak and loss for ${perfRangeLabel(range)}` `` | `table.ariaLabel` (`{range}`) |
| Column headers | `Interface`, `Oper`, `Speed`, `In`, `Out`, `Peak`, `Loss` | `table.col.*` (7) |
| Pagination template | `` `Page {page} of {totalPages} · {total} interfaces` `` | `pagination.summary` (`{page}`, `{totalPages}`, `{total}`) |
| Pagination buttons | `Previous`, `Next` | `pagination.prev`, `pagination.next` |
| Row sr-only | ` — open device detail` | `row.openDevice` (separator stays in code, netif precedent) |
| UtilBar sr-only ternary | `` `${fmtPct(pct)} utilization${pct > 80 ? " — critical" : pct > 60 ? " — high" : ""}` `` | `sr.utilization` (`{pct}`) + `sr.critical` / `sr.high` appended by the same ternary |

**30 leaves** per locale. Terminology consistency: `إعادة تعيين` (cmdb/devices
precedent), `الاستخدام` (netif precedent), `فقد الحزم`, `صفحة {page} من {totalPages}`
(netif pagination shape), `{total} واجهة` (netif `{count} واجهة` shape).

### Documented survivors (unchanged policy)

- **Shared perf chrome (cross-view):** `PerfRangeChips` + `perfRangeLabel` are
  exported from `perf-overview-view.tsx` and stay English until the perf-overview
  tranche keys them. In AR the `{range}` interpolation therefore reads `last 30 days`
  inside the Arabic sentence — verified live and documented in-source. The r82 suite
  pins the import line so the dependency cannot silently regress. `perf-overview-view.tsx`
  itself remains ledgered (27).
- `fmtSpeed` units (`Gb/s` / `Mb/s`), `—` placeholders, the sr-only ` — ` separator:
  locale-neutral technical tokens.
- `title={row.hostname}` / `title={row.ifName}`: data-plane (DB content, hostnames
  precedent).
- Oper-status labels resolve via `useStatusLabel` in the active locale (existing).

## 3. Dictionary

`messages/en.json` + `messages/ar.json`: byte-preserving tail insertion of
`perfInterfaces` (30 = 30 leaves, deep parity both directions). Dictionary totals:
1,577 → **1,607 = 1,607 leaves**.

## 4. Gates (CI env shape: `DATABASE_URL=postgresql://…@localhost:5433/fayanms`)

- `bun run lint` → **0**.
- `bunx tsc --noEmit` → **0**.
- `bun test tests/` (bare sandbox) → **1066 pass / 18 skip / 29 fail** (9,456
  expects, 77 files, 4.3 s) — the 29 fails are the R64 hermeticity contract
  (R50/R50.8/R51/R62/SAFE-002/P1-007 vendor-detect + service-JWT + worker planes
  needing the full CI runner), verified as the SAME set (zero i18n/sweep failures;
  fail names enumerated this round). Reconciliation: R80-time bare baseline 1044 +
  9 (r81) + 13 (r82) = **1066** ✓; expects 8,868 → 9,456 (+588); files 76 → 77.
- i18n suites in isolation (r56 sweep + r80 + r81 + r82): **39/39 pass** (3,808
  expects) — incl. the new live-sum pin (730), the exact-30 leaf pin, deep parity,
  29 absent-literal source pins and 29 keyed-call-site pins.

## 5. LIVE verification (agent-browser, admin@faya.local, dev server 200)

Walked per locale (locale switched via the header dropdown; `document.documentElement`
asserted `ar / rtl` then `en / ltr`; the 24H window has no samples so the 30D range
was selected to exercise the populated table — 117 interfaces, Page 1 of 5):

- **EN** — heading `Interface Utilization`; description `Per-interface in/out
  utilization and loss — last 30 days, worst first` (the `{range}` interpolation
  live); group `Sort by` with chips `Utilization` / `Packet loss`; oper facet `Up
  117`; search input accessible name `Search interfaces` (the sr-only label) and
  placeholder `Search host or ifName…`; combobox `Site` showing `Any site`; card
  heading `Interfaces — 117` (`cardTitleCounted` live); table aria-label
  `Interface performance — utilization in/out, peak and loss for last 30 days`; all
  seven column headers (`Interface | Oper | Speed | In | Out | Peak | Loss`); row
  cells carrying the sr-only ` — open device detail`; **UtilBar sr-only ternary
  live**: `69.0% 69.0% utilization — high` (67.4% → ` — high`), `50.0% 50.0%
  utilization` (no suffix), peaks `86.2%`; pagination summary byte-exact
  `Page 1 of 5 · 117 interfaces` with `Previous` (disabled on page 1) / `Next`.
- **AR (rtl)** — `dir=rtl lang=ar` asserted; heading `استخدام الواجهات`;
  description `الاستخدام داخل/خارج وفقد الحزم لكل واجهة — last 30 days، الأسوأ
  أولاً` (the documented shared-helper survivor inside the Arabic sentence); sort
  group `الترتيب حسب`, chips `الاستخدام` / `فقد الحزم`; search placeholder `ابحث
  باسم المضيف أو الواجهة…` + sr-only `البحث في الواجهات`; select `أي موقع`; card
  `الواجهات — 117`; all seven Arabic headers (`الواجهة | التشغيل | السرعة | داخل |
  خارج | الذروة | الفقد`); pagination `صفحة 1 من 5 · 117 واجهة` with `السابق` /
  `التالي`; sr-only severity `مرتفع` present in the DOM.
- **Reset exercised live (AR):** typed `HQ` into the search → the `إعادة تعيين`
  button appeared (it renders only when filters are active), click restored `أي
  موقع` / empty query — the keyed reset path proven on the wire.
- Zero console errors, zero page errors, zero MISSING_MESSAGE across both locales.
- Mobile 390×844 (AR): **no horizontal overflow**.

## 6. Governance moved

- `tests/audit/r56-i18n-chrome-sweep.test.ts`: ledger 23 → 22 entries
  (`perf-interfaces-view.tsx` removed); header carries the R82 paragraph + the
  748/730 correction note; ledger doc comment updated.
- `tests/audit/r81-i18n-tranche-2.test.ts`: the exact-23 numeric-ledger pin updated
  to HEAD truth (**22**, title `(23 − 1, R82)`; header note records the R81-time
  value) — the pin tracks the living ledger, as the sweep header itself does.
- NEW `tests/audit/r82-i18n-tranche-3.test.ts` — **13 pins**: exact-30 leaves ×2,
  deep parity, non-empty values, interpolation placeholders (`{range}`, `{total}`,
  `{page}`, `{totalPages}`, `{pct}`), namespace consumption ×3 scopes, zero sweep,
  29 absent-literal source pins, 29 keyed-call-site pins, ledger-entry removal,
  exact-22 numeric ledger, **live candidate sum == 730 (computed, not quoted)**,
  shared-chrome import survivor, locale-neutral token survivors.

## 7. Artifacts

- Screenshots: `agent-ctx/verify-r82-perfif-en.png`,
  `agent-ctx/verify-r82-perfif-ar.png`, `agent-ctx/verify-r82-perfif-ar-mobile390.png`.
- Roadmap: R82 row appended. `NEXT-TASKS`: R82 tranche note + ledger numbers
  corrected (748/730).
- db/, .env, PAT never staged.
