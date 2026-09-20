# FayaNMS — R83: i18n Tranche 4 — perf-devices + baselines keyed (2026-09-20)

**Branch:** `main` (single-branch repo) · **Base:** `f402422` (R82) · **Suite files:** 77 → 78

## 1. What landed

Two views fully keyed — the R56 `PENDING_VIEWS` debt ledger's fourth shrink:
**22 → 20 entries (730 → 690 candidates)**.

- `perf-devices-view.tsx` (PERFORMANCE → "Device Performance") through the NEW
  `perfDevices` namespace — **36 leaves** per locale.
- `baselines-view.tsx` (CONFIGURATIONS → "Baselines") through the NEW
  `baselines` namespace — **37 leaves** per locale.

Both namespaces: en = ar deep parity (machine-pinned both directions), non-empty
values everywhere, byte-preserving tail insertion after `perfInterfaces`
(dictionary 1,607 → **1,680 = 1,680** leaves).

## 2. perf-devices — the full inventory (hand-cleaned, including the non-swept plane)

The shallow sweep matched **20 candidates**; the hand inventory keyed every
user-visible literal, including the plane the regexes never see:

| Plane | Literal(s) | Key(s) |
|---|---|---|
| PageHeader | `Device Performance` | `title` |
| PageHeader template | `` `Per-device ${label.toLowerCase()} across the fleet — ${perfRangeLabel(range)}` `` | `description` (`{metric}`, `{range}`) — the metric resolves via `` t(`metric.${metricKey}`) `` and keeps the original `.toLowerCase()` in-prose shape (no-op in Arabic — no grammatical case) |
| Metric chips (module-level const) | `CPU`, `Memory`, `Latency`, `Packet loss`, `Utilization` | `metric.cpu/memory/latency/packetLoss/utilization` — `METRIC_CHIPS` now carries `labelKey`, resolved via `` t(`metric.${chip.labelKey}`) `` (R82 `SORT_CHIPS` dynamic-key shape) |
| Metric group | `aria-label="Metric"` | `metricGroupAria` |
| Toolbar | `Search devices` (sr-only), `Search hostname…`, `Site` (aria), `Any site`, `Reset` | `toolbar.*` (5) |
| SectionCard conditional template | `` `Devices${listMeta ? ` — ${listMeta.total}` : ""}` `` | `table.cardTitle` / `table.cardTitleCounted` (`{total}`) |
| ErrorState | `Device performance could not be loaded` | `error.title` |
| EmptyState | `No performance rows to show`, `No devices match the current filters, or no samples cover this window.` | `empty.title`, `empty.description` |
| Table aria template | `` `Device performance — ${metric.toLowerCase()} per device for ${perfRangeLabel(range)}` `` | `table.ariaLabel` (`{metric}`, `{range}`) |
| Column headers | `Device`, `Site`, `Status`, `Trend`, `Latest`, `Avg`, `Max`, `P95`, `Δ Window` | `table.col.*` (9) |
| Pagination template + buttons | `` `Page {page} of {totalPages} · {total} devices` ``, `Previous`, `Next` | `pagination.*` (3) |
| Row sr-only | ` — open device detail` | `row.openDevice` (R82 separator-in-code pattern) |
| Sparkline title template | `` `${row.trend.length} buckets · oldest to newest` `` | `row.trendTitle` (`{count}`) |
| Delta sr-only ternary | `` deltaRising ? " worsening" : deltaFalling ? " improving" : " flat" `` | `sr.worsening` / `sr.improving` / `sr.flat` (separator inside the message — R82 `sr.critical`/`sr.high` precedent) |

**36 leaves** per locale. Terminology consistency: metric terms match
`capacity.chrome.metric` verbatim (`المعالج`, `الذاكرة`, `زمن التأخير`,
`فقد الحزم`, `الاستخدام`); toolbar/pagination mirror `perfInterfaces`
(`البحث في الأجهزة`, `ابحث باسم المضيف…`, `أي موقع`, `إعادة تعيين`,
`صفحة {page} من {totalPages} · {total} جهاز`).

## 3. baselines — the full inventory

The shallow sweep matched **20 candidates**; the hand inventory keyed every
user-visible literal, including the plane the regexes never see:

| Plane | Literal(s) | Key(s) |
|---|---|---|
| PageHeader | `Baselines`, the golden-configurations description | `title`, `description` |
| SectionCard | `Approved baselines`, the latest-approval-wins description | `card.title`, `card.description` |
| ErrorState | `Baselines could not be loaded`, the `"Unknown error"` reason fallback | `error.title`, `error.unknown` |
| EmptyState | `No baselines approved yet`, the open-a-device instructions (curly-quote “Approve as baseline”) | `empty.title`, `empty.description` |
| Table aria | `Approved baselines — device, approved version, approval time and open drift count` | `table.ariaLabel` |
| Column headers | `Device`, `Site`, `Baseline`, `Approved`, `Note`, `Drift`, `Actions` | `table.col.*` (7) |
| Row aria templates | `` `Open ${row.hostname} device detail` ``, `` `Diff baseline vs running config for ${row.hostname}` ``, `` `Revoke baseline for ${row.hostname}` `` | `row.openDeviceAria`, `row.diffAria`, `row.revokeAria` (`{hostname}`) |
| Approved-by template | `` ` · by ${row.approvedBy}` `` | `row.approvedBy` (`{by}`) |
| Drift chip | `` `${count} open drift record(s) — open the Drift view` `` (title) + `{count} open` (label) | `row.driftTitle` (`{count}`), `row.driftOpen` (`{count}`) |
| Clean chip | `Clean` | `row.clean` |
| Diff buttons | `` `vs running (v${version})` `` / `vs running` | `row.vsRunningVersion` (`{version}`), `row.vsRunning` |
| Revoke button | `Revoke` | `row.revoke` |
| Missing strip | `` `Devices without a baseline — ${count}` ``, the no-reference description, `· open device`, `` `+${count} more` `` | `missing.title` (`{count}`), `missing.description`, `missing.openDevice`, `missing.more` (`{count}`) |
| Diff dialog | `` `Baseline vs running — ${hostname} v${from} → v${to}` ``, the drift-check description | `diff.title` (`{hostname}`, `{from}`, `{to}`), `diff.description` |
| Revoke dialog | `` `Revoke baseline of ${hostname}?` ``, the split description AROUND the styled `` v{version} `` token, `Cancel`, `Revoke baseline` | `revoke.title` (`{hostname}`), `revoke.descriptionStart` + `revoke.descriptionEnd` (the `font-tech ltr-technical` span around `v{revokeTarget?.version}` survives BETWEEN the two parts), `revoke.cancel`, `revoke.confirm` |

**37 leaves** per locale. Terminology: `الانحراف` (drift — existing precedent),
`التكوين` (Config tab — `deviceDetail.tabs.config` precedent), `أرشيفي`
(Historical — `status.snapshot.HISTORICAL` verbatim), `خط أساس` (baseline —
`status.snapshot.BASELINE` stem).

### Documented survivors (unchanged policy)

- **date-fns relative time:** `formatDistanceToNow(..., { addSuffix: true })`
  renders English ("3 days ago") in both locales — no date-fns ar locale is
  wired anywhere in the app (the keyed `device-config-tab` carries the same
  call shape; documented precedent, not a regression of this tranche).
- Data-plane titles: `title={row.hostname}`, `title={row.sha256}`,
  `title={row.note ?? undefined}` (DB content, hostnames precedent).
- `fmtMetric`'s `—` placeholder and the technical `v{version}` tokens
  (`v{row.version}`, `v{revokeTarget?.version}`): locale-neutral.
- **Shared perf chrome (cross-view, carried from R82):** `PerfRangeChips` +
  `perfRangeLabel` stay English until the perf-overview tranche; in AR the
  `{range}` interpolation reads `last 30 days` inside the Arabic sentence —
  verified live. `perf-overview-view.tsx` remains ledgered (27).

## 4. Ledger governance

- r56 `PENDING_VIEWS`: `baselines-view.tsx` (20) and `perf-devices-view.tsx`
  (20) removed → **20 entries**; live shallow-regex sum over the ledgered
  files = **690**, ceilings == live on every entry (re-derived from the tree,
  not quoted).
- r82 pins updated to HEAD truth per the R82→R81 convention: entry count
  22 → **20** (`(22 − 2, R83)`), live sum 730 → **690** (`(730 − 40, R83)`).
- r81's entry-count pin updated to HEAD truth: 22 → **20**.
- r80's pins (its six files un-ledgered) unaffected.

## 5. Tests

NEW `tests/audit/r83-i18n-tranche-4.test.ts` — **19 pins**: exact leaf counts
(36 + 37 ×2 locales), deep parity both directions (both namespaces), non-empty
values, interpolation placeholders (`{metric}`, `{range}`, `{total}`,
`{page}`, `{totalPages}`, `{count}`, `{hostname}`, `{by}`, `{version}`,
`{from}`, `{to}`), namespace consumption (2 scopes perf-devices, 1 scope
baselines), ZERO sweep on both files, 25 absent-literal pins (perf-devices) +
31 absent-literal pins (baselines), 34 + 37 keyed-call-site pins, both ledger
removals, exact-20 ledger, LIVE candidate sum == 690 (computed from the tree),
and the survivor pins (date-fns/no-ar-locale, data-plane titles, `—`,
styled `v{version}` spans, shared-chrome import line).

Suite reconciliation: R82-time bare baseline 1066 + 19 (r83) = **1085** ✓;
expects 9,456 → 9,921 (+465); files 77 → 78.

- `bun run lint` → **0**.
- `bunx tsc --noEmit` → **0**.
- `bun test tests/` (bare sandbox) → **1085 pass / 18 skip / 29 fail**
  (9,921 expects, 78 files) — the 29 fails are the unchanged R64 hermeticity
  contract (R50/R50.8/R51-A1/R62/SAFE-002/P1-007 vendor-detect + service-JWT +
  worker planes needing the full CI runner; fail-set re-enumerated, zero
  i18n/sweep failures).
- `bun test tests/` in the CI gate env shape (Postgres :5433) →
  **1114 pass / 18 skip / 0 fail** (9,972 expects) — full green, the 29
  hermeticity fails flip to pass exactly as in CI.
- i18n suites in isolation (r56 + r80 + r81 + r82 + r83): **58/58 pass**
  (4,273 expects).

## 6. LIVE verification (agent-browser, admin@faya.local, 30D window)

- **EN perf-devices:** `Device Performance`, description
  `Per-device cpu across the fleet — last 24 hours` (lowercase shape
  byte-exact), metric chips `CPU/Memory/Latency/Packet loss/Utilization`,
  sr-only `Search devices`, `Any site`, `Devices — 28`,
  table aria `Device performance — cpu per device for last 30 days`,
  all nine headers incl. `Δ Window`, sparkline `24 buckets · oldest to
  newest`, `Page 1 of 2 · 28 devices`, row sr-only ` — open device detail`,
  delta sr-only `worsening`/`improving` on the wire; live filter `HQ` →
  `Devices — 11` → keyed `Reset` → cleared, `Devices — 28`.
- **AR perf-devices (rtl/ar asserted):** `أداء الأجهزة`,
  `المعالج لكل جهاز عبر الأسطول — last 30 days`, `المقياس` group aria, chips
  `المعالج/الذاكرة/زمن التأخير/فقد الحزم/الاستخدام`, `البحث في الأجهزة`,
  `أي موقع`, `الأجهزة — 28`, Arabic table aria, all nine Arabic headers
  (`تغيّر النافذة`), `24 حزمة · من الأقدم إلى الأحدث`,
  `صفحة 1 من 2 · 28 جهاز`, `السابق`/`التالي`, row sr-only
  `— فتح تفاصيل الجهاز`, delta sr-only `تدهور`/`تحسّن`/`ثابت`
  (incl. the 0.0% `ثابت` no-suffix case).
- **EN baselines:** `Baselines`, both descriptions byte-exact (incl.
  `device's Config tab`), `Approved baselines` card, table aria + seven
  headers, `vs running (v482)`, `Revoke`, `· open device`, `+21 more`,
  drift chip title `1 open drift record(s) — open the Drift view`.
- **AR baselines (rtl/ar asserted):** `الخطوط الأساسية`, full Arabic table
  aria + seven headers, `أجهزة بدون خط أساس — 26`, `1 مفتوحة`,
  `مقابل التكوين الجاري (v482)`, `إبطال`, row aria
  `قارن الخط الأساسي بالتكوين الجاري لـ HQ-Core-RTR-01` /
  `إبطال الخط الأساسي لـ HQ-Core-RTR-01`.
- **Diff dialog (EN + AR):** `Baseline vs running — HQ-Core-RTR-01 v4 → v482`
  / `الخط الأساسي مقابل التكوين الجاري — HQ-Core-RTR-01 v4 → v482` +
  description both locales; opened live and closed without side effects.
- **Revoke dialog (EN + AR):** `Revoke baseline of HQ-Core-RTR-01?` +
  `The approval row is deleted and v4 returns to Historical (…)` with the
  styled `v4` token BETWEEN `descriptionStart`/`descriptionEnd` (EN byte-exact
  vs the pre-tranche render); AR `إبطال الخط الأساسي لـ HQ-Core-RTR-01؟` +
  `يُحذف سجل الاعتماد وتعود v4 إلى الحالة «أرشيفي» (…)` — the split holds the
  Arabic word order; buttons `Cancel`/`Revoke baseline` /
  `إلغاء`/`إبطال الخط الأساسي`; **CANCELLED live in both locales — no
  mutation** (row count unchanged after close).
- Zero console errors / page errors / MISSING_MESSAGE across the whole
  session (both locales, both views, all dialogs).
- Mobile 390×844: 0 horizontal overflow on both views.

Screenshots (agent-ctx, untracked): `r83-perf-devices-ar.png`,
`r83-baselines-ar.png`, `r83-baselines-en.png`,
`r83-perf-devices-mobile-390.png`, `r83-baselines-mobile-390.png`.

## 7. Remaining tranches (ascending size)

incidents (22), perf-availability (22), perf-overview (27 — keys the shared
perf chrome this program keeps pinning), admin-api-clients (27), changes (27),
events (27), alerts (36), maintenance (38), discovery (43),
incident-detail (43), admin-integrations (47), admin-users (51),
change-detail (52), snapshots (29), backups (61), change-approvals (33),
drift (30), backup-compliance (30), admin-collectors (19),
admin-credentials (26). End-state rule unchanged: empty ledger → the sweep
flips to forbid candidates in every view.
