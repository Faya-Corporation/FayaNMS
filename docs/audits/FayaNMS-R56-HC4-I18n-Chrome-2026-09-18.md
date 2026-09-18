# FayaNMS — R56 / HC-4: i18n completion of chrome copy (devices plane)

**Date:** 2026-09-18 · **Branch:** `z_ai_v2` · **Base:** `64dca8f` (R55/HC-3) · **Roadmap item:** Phase HC-4

## 1. What the debt was

The app-wide i18n program (next-intl, `messages/en.json` + `messages/ar.json`,
exact key parity) covered the shell, nav, dashboard and 15+ other views —
but `devices-view.tsx` and `device-detail-view.tsx` carried NO translations at
all (`useTranslations` count: 0): every button, toast, placeholder, filter
select, table header, empty state and aria label was an English literal.
This was a documented, deliberate triage decision scheduled as its own
completion pass (roadmap HC-4). Dictionary parity ("1285 = 1285") had only
ever been stated in prose — no pin enforced it.

## 2. What changed

- **`messages/en.json` / `messages/ar.json`** — NEW namespaces, added in
  lockstep (+134 leaves each side; dictionary total 1285 → **1419 = 1419**):
  - `devices` (78 leaves): page header, saved views, filter toolbar
    (aria + placeholders + "All …" options), filter chips, bulk bar,
    column labels (the 10-key `columns` set now ALSO resolves the
    persisted `DEVICE_COLUMN_LABELS` store keys at render time), table
    (card/error/empty/aria/sort-announcer), row menu (incl. the
    exit/enter-maintenance ternary), pagination, export toasts with ICU
    plurals.
  - `deviceDetail` (56 leaves): back navigation, the 10 tab labels
    (rendered via `t(`tabs.${value}`)`), no-device/error states,
    connection-test banner states, KPI cards, the full device record
    label set (incl. the data-plane live/simulator variants and the
    with-profile interpolation), notes/tags, recent-activity states.
  - Arabic drafted as genuine net-ops terminology in the house style —
    ICU plurals with the full Arabic categories (one/two/few/many/other),
    matching the existing dictionary (e.g. `جهاز واحد / جهازان / # أجهزة /
    # جهازًا / # جهاز`). Operator-side linguistic sign-off remains folded
    into the lab visit per the roadmap.
- **`devices-view.tsx`** — fully keyed (`useTranslations("devices")` +
  `common`): DeviceRow (memoized) and SortableHead carry their own hooks;
  the export toasts use `{count, plural, …}`; the saved-view aria labels
  interpolate the view name; `DEVICE_COLUMN_LABELS[key]` store strings are
  no longer rendered — the dropdown resolves `t(`columns.${key}`)`.
- **`device-detail-view.tsx`** — fully keyed (`useTranslations("deviceDetail")`
  + `common`); `TAB_ITEMS` collapsed to a value array with labels resolved
  at render; the connection-banner ternary chain (unreachable / OK / OK
  with latency / failed) is keyed.
- **Deliberate survivors**: the `LIVE` data-plane chip (governed technical
  token, identical in both locales) and the `—` placeholders; relative
  time formatting stays `date-fns` English app-wide (consistent technical
  convention, no per-locale registration anywhere) — both documented in
  the pin file.
- **`README.md`** §Conventions: parity count updated with the
  machine-pinned note + the debt-ledger pointer.

## 3. Pins — `tests/audit/r56-i18n-chrome-sweep.test.ts` (8 NEW)

| # | Pin |
|---|-----|
| 1 | **parity**: en/ar leaf-key sets identical in BOTH directions, equal counts |
| 2 | every leaf value in both dictionaries is a non-empty string |
| 3 | `devices` / `deviceDetail` namespaces exist and are balanced (>40 leaves each) |
| 4 | both named views consume their namespaces (`useTranslations` source pin) |
| 5 | devices-view candidate inventory == exactly `["LIVE"]` (documented survivor) |
| 6 | device-detail-view candidate inventory == `[]` |
| 7 | sweep: every OTHER view with candidates must be ledgered (no untracked debt) |
| 8 | sweep: every ledgered file's candidate count ≤ its R56 ceiling (may only shrink) |

Detection = two documented shallow regexes (literal uppercase props +
JSX text nodes). Honest limits stated in the pin header: ternaries,
templates and lowercase openings are not matched — the two named views
were cleaned against the FULL hand-built inventory (including
`Sort by ${label}`-style templates), the sweep is the regression net.

## 4. Gates (CI env shape: `.env` stashed + full CI secret set exported)

- `bun run lint` → **0 findings**
- `bunx tsc --noEmit` (FULL) → **0 errors**
- `bun test` → **935 pass / 18 skip / 0 fail** (7,968 expects, 55 files,
  3.87 s) — 927 → 935 (+8)

## 5. LIVE verification (browser, en + ar/RTL)

| Check | Result |
|---|---|
| EN devices view after keying | pixel-equivalent chrome: "Devices" / "Import CSV" / "Add Device" / "Search devices" / "Filter by status → All statuses" / "Export CSV" / "Inventory" |
| Locale switch (header → العربية) | `documentElement` → `dir="rtl"`, `lang="ar"` |
| AR devices chrome | `الأجهزة` (nav + heading + breadcrumb), `استيراد CSV`, `إضافة جهاز`, `البحث في الأجهزة`, `تصفية حسب الحالة → جميع الحالات`, `تصفية حسب درجة الحرجية`, `تصفية حسب الالتزام بالنسخ الاحتياطي`, table sort announcer `فرز حسب اسم المضيف`, column `عنوان الإدارة (IP)` |
| AR device detail (BR1-Access-SW-01) | row opened via its Arabic title `فتح BR1-Access-SW-01`; tabs `نظرة عامة…التدقيق` (10/10 Arabic), `اختبار الاتصال`, `نسخ احتياطي الآن`, `سجل الجهاز`, `النشاط الأخير` |
| Authed API mid-journey | `GET /api/v1/devices` → 200, 20 rows |
| Console / page errors | **0 / 0** across both locales |
| Mobile 390×844 (AR) | no horizontal overflow |

Screenshots: `agent-ctx/verify-r56-hc4-devices-en.png`,
`agent-ctx/verify-r56-hc4-devices-ar-rtl.png`,
`agent-ctx/verify-r56-hc4-detail-ar-rtl.png`,
`agent-ctx/verify-r56-hc4-mobile-390-ar.png`.

## 6. Honest scope

- HC-4 closes the roadmap's named triage (devices plane). The sweep also
  surfaced that i18n coverage across ALL views is partial (18 keyed, 32
  with residual literals — including views that already have namespaces,
  e.g. events/incident-detail). That state is now MACHINE-TRACKED: the
  `PENDING_VIEWS` ledger in the pin file fixes each file at its R56
  candidate ceiling and can only shrink; README no longer overstates
  full-string coverage.
- Arabic strings are operator-grade drafts; native-Arabic sign-off stays
  folded into the lab visit (roadmap note unchanged).
- `date-fns` relative times remain English in both locales (app-wide
  technical convention, pre-existing, not devices-specific).
