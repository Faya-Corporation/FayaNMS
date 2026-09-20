# FayaNMS — R85: i18n Tranche 6a — perf-overview keyed + the SHARED PERF CHROME keyed (2026-09-20)

**Branch:** `main` (single-branch repo) · **Base:** `74b2320` (R84) · **Suite files:** 79 → 80

## 1. What landed

One view fully keyed — the R56 `PENDING_VIEWS` debt ledger's sixth shrink:
**18 → 17 entries (646 → 619 candidates)** — AND the cross-view survivor that
R82/R83/R84 all documented ("shared perf chrome stays English until the
perf-overview tranche") is **resolved**:

- `perf-overview-view.tsx` (PERFORMANCE → "Performance Overview") through the
  NEW `perfOverview` namespace — **76 leaves** per locale across SEVEN
  component scopes (`PerfOverviewView`, `PerfRangeChips`, `AvailabilityCard`,
  `LatencyCard`, `ChartEmpty`, `TopUtilizersCard`, `RetentionPanel`), each
  with its own `useTranslations("perfOverview")` hook.
- The shared chrome helpers are keyed with the R81 `metricLabel(metric, t)`
  structural-TranslateFn precedent:
  - `perfRangeLabel(range, t)` — the four `{range}` long forms
    (last hour / last 24 hours / last 7 days / last 30 days);
  - `granularityLabel(granularity, t)` — the four rollup names +
    `{unit} buckets` + the `rollups` fallback.
  - `type TranslateFn = (key, values?) => string` (structural, not the
    next-intl type — same shape as R81's capacity helper).
  - The three already-keyed sibling perf views (`perf-interfaces`,
    `perf-devices`, `perf-availability`) each keep a `tRange =
    useTranslations("perfOverview")` hook and pass it to
    `perfRangeLabel(range, tRange)` — so their `{range}` placeholders now
    render in the active locale. The previously documented "English range
    label inside the Arabic sentence" state is GONE (live-verified below).

## 2. The keyed inventory (including the non-swept plane)

The shallow sweep regexes never matched most of this file's literals; the
whole plane was hand-inventoried and keyed:

- **PageHeader**: `title`, `description`, the `Updated {HH:mm:ss}` stamp
  (the clock itself stays date-fns English — documented survivor).
- **PerfRangeChips**: the `Time range` group aria-label (this is the shared
  chrome that renders on FOUR perf views).
- **Error state**: `Performance data could not be loaded`.
- **KPI row** (6 cards): label + description pairs; the availability KPI
  description carries the `{granularity}` template via
  `granularityLabel(meta.granularity, t)` (dynamic-key fallback
  `granularity.fallback`); the availability status ternary
  (`on target` / `watch` / `below target`) keyed as
  `kpi.status.{onTarget|watch|below}`.
- **Availability + Latency cards**: title, `{range}` description, the
  ChartSummary aria-label + summary templates
  (`{avg}`+`{range}` / `{count}`+`{range}`+`{lowest}`+`{highest}` /
  `{peak}`+`{range}` / `{count}`+`{range}`+`{highest}`), and the chart
  tooltip series labels (`Availability`, `Latency p95`). Chart stats are
  computed once and the defensive `—` fallbacks stay code-side
  locale-neutral tokens (branches render only when points exist).
- **ChartEmpty**: the `{range}` title + the raw-vs-rollups description
  ternary (`empty.raw` / `empty.rollups`).
- **Top Utilizers**: title, description, empty pair.
- **RetentionPanel** (the Phase-6 gate surface): title, description;
  `TIER_ROWS` (label+hint records) replaced by `TIER_KEYS` resolved via
  `` t(`retention.tier.${key}.label|.hint`) `` — the R82 SORT_CHIPS / R81
  GROUPS / R84 STATUS_GROUPS dynamic-key precedent; `{tier} retention in
  days` + `days` unit; the `{tier} retention {state}` switch aria with the
  enabled/disabled ternary; the Active/Paused badge ternary; Reset / Save /
  Saving… / Prune now / Pruning… action labels; the retention error title;
  the prune dialog (title, description, `Last prune ran` + the
  `{samples}/{m5}/{h1}/{d1}/{seconds}` last-run stats strip, `Pruning has
  not run yet.`, Cancel); Save/Prune disabled + pending states preserved.

## 3. Dictionaries

- NEW `perfOverview` namespace tail-inserted after `perfAvailability` in
  BOTH `messages/en.json` and `messages/ar.json` — byte-preserving
  insertion, no re-serialization.
- Dictionary 1,746 → **1,822 = 1,822 leaves**, deep parity both directions
  (script-verified + machine-pinned).
- **The `{range}` values themselves are genuine Arabic** (آخر ساعة / آخر
  24 ساعة / آخر 7 أيام / آخر 30 يومًا) — this tranche's headline: every
  perf view's `{range}` renders Arabic in `ar`, replacing the R82–R84
  documented survivor.
- Terminology: النطاق الزمني (chips aria), تجميعات (rollups stem),
  عيّنات خام (raw samples), الاحتفاظ بالمقاييس (metrics retention),
  التقليم (prune), مُمكَّن/متوقف (enabled/paused), مللي ثانية (ms),
  بالمئة (percent — noc/noc-adjacent shapes), زمن التأخير (latency —
  perf-availability stem).

## 4. Survivors (documented in-source + machine-pinned)

- `PERF_RANGES` chip labels stay the locale-neutral technical range tokens
  `1H/24H/7D/30D` (the `v{version}` precedent — they are also the range
  *keys*); the localized long forms live under `perfOverview.range.*`.
- `fmtPct`/`fmtMs` `%`/`ms` units + `—` empty placeholders (fmtSpeed/
  fmtMetric precedent); chart tick formatters (`${value}%`,
  `${value} ms`); `dataKey`/`name` props; the gradient `id`.
- date-fns tick/label formats (`MMM d`, `HH:mm`, `EEE, MMM d — HH:mm`)
  and `formatDistanceToNow` relative time (no ar locale wired anywhere —
  device-config-tab / R83 / R84 precedent). The prune dialog's
  "Last prune ran **2 days ago**" keeps the English relative time inside
  the Arabic sentence, live-verified identical policy to R83/R84.
- Data-plane hostnames/siteCodes; the defensive code-side `—` fallbacks;
  the `Updated` clock `HH:mm:ss` format.

## 5. Governance

- r56 sweep ledger: `perf-overview-view.tsx` entry REMOVED — **17 entries
  remaining**, live candidate sum over the ledgered files **619**
  (646 − 27), computed from the tree by the new pin (not quoted). Ceilings
  == live on every entry.
- Sweep header R85 paragraph + ledger doc comment updated.
- r81/r82/r83/r84 numeric pins updated to HEAD truth per the
  R82→R81 convention (17 entries / 619 sum; r82's shared-chrome survivor
  test now pins the keyed shape `perfRangeLabel(range, tRange)`).
- NEW `tests/audit/r85-i18n-tranche-6a.test.ts` — 22 pins:
  exact-76 leaves ×2 locales, dictionary totals 1,822 = 1,822, deep parity
  both directions, non-empty values, namespace consumption (7 scopes in
  the view + 1 `tRange` hook in each of the 3 sibling views), ZERO sweep,
  ~55 absent-literal source pins, ~85 keyed-call-site pins, ledger-entry
  removal + exact-17 numeric ledger + LIVE sum == 619 computed from the
  tree, 15 interpolation placeholders in both locales, AR `{range}` values
  asserted genuine Arabic, survivor pins (range tokens, units, date-fns,
  chart internals, em-dash fallbacks).

## 6. Verification

- **Gates:** lint 0 · tsc 0 · i18n suites in isolation
  **100/100** (r56+r80+r81+r82+r83+r84+r85) · full suite
  **1156/18/0 in the CI gate env shape** (Postgres :5433; 10,929 expects,
  80 files; reconciliation 1135@R84 + 21 r85) · bare
  **1127/18/29** (29 = the unchanged R64 hermeticity contract; fail blocks
  re-enumerated: R50.8 ×8, service JWT ×7, R51-A1 ×4, R50 ×4, SAFE-002 ×3,
  R62 P1-1, P1-007 ×2 — identical block set to R84).
- **LIVE (agent-browser, admin@faya.local, EN + AR rtl/ar):**
  - EN: title/description/`Updated` stamp/6 KPI cards
    (`Availability across managed devices · hourly rollups` — the
    `{granularity}` template live), range chips exercised 24H → 7D:
    `Share of managed devices reachable — last 7 days`,
    `Availability trend, averaged 95.40 percent over last 7 days.`,
    `Area chart of 76 samples over last 7 days; lowest 93.10 percent,
    highest 96.60 percent.`, latency card + tooltip labels; retention
    panel (4 dynamic tier rows, `Raw samples retention in days`,
    `… retention enabled` switch arias, Active/Paused, Save/Prune now);
    prune dialog opened — full text incl.
    `Last prune ran 2 days ago — deleted 0 samples, 0 5-min, 0 1-hour and
    0 1-day rollups in 0.0 s` — then **CANCELLED, no mutation**.
  - AR (`ar / rtl` asserted): `نظرة عامة على الأداء`,
    `أداء الأسطول في لمحة — الإتاحة وزمن التأخير والاستخدام`, `محدَّث`,
    KPI `الإتاحة عبر الأجهزة المُدارة · تجميعات كل ساعة`, chart aria
    `اتجاه الإتاحة، بمتوسط 95.40 بالمئة خلال آخر 7 أيام.`, summary
    `مخطط خطي لـ 76 عيّنة … خلال آخر 7 أيام؛ أعلى 49 مللي ثانية.`,
    `الاحتفاظ بالمقاييس` panel with dynamic tier arias
    (`الاحتفاظ بـعيّنات خام بالأيام` / `… مُمكَّن`), `حفظ`/`تقليم الآن`,
    prune dialog AR + **CANCELLED** (date-fns `2 days ago` survivor inside
    the AR sentence, documented), 24H empty states
    (`لا توجد بيانات خلال آخر 24 ساعة` + rollups + utilizers pairs).
  - **Shared-chrome payoff on the wire**: perf-interfaces AR description
    `…لكل واجهة — آخر 30 يومًا، الأسوأ أولاً` + table aria `…لـ آخر 30
    يومًا`; perf-devices AR `المعالج لكل جهاز عبر الأسطول — آخر 24 ساعة` +
    30D table aria `أداء الأجهزة — المعالج لكل جهاز خلال آخر 30 يومًا`;
    perf-availability AR `مدة التشغيل وبلوغ SLA — آخر 24 ساعة`. The
    R82–R84 "English range label inside the Arabic sentence" survivor is
    gone from every perf view.
  - Zero console errors / MISSING_MESSAGE / page errors in BOTH locales;
    mobile 390 no h-overflow (perf-overview AR + perf-interfaces AR).
  - 4 screenshots (agent-ctx, untracked): EN 7D overview, AR 7D overview,
    AR availability, AR interfaces 30D.

## 7. Ledger after R85

17 entries / **619 candidates** (from 32 entries / 824 at R56):
admin-api-clients (27), admin-collectors (19), admin-credentials (26),
admin-integrations (47), admin-users (51), alerts (36),
backup-compliance (30), backups (61), change-approvals (33),
change-detail (52), changes (27), discovery (43), drift (30), events (27),
incident-detail (43), maintenance (38), snapshots (29).

Next tranches by ascending size: admin-collectors (19), then the three
remaining 27s (admin-api-clients, changes, events), snapshots (29),
drift (30), backup-compliance (30), change-approvals (33), alerts (36),
maintenance (38), discovery (43), incident-detail (43),
admin-integrations (47), admin-users (51), change-detail (52),
backups (61). End-state rule unchanged: empty ledger → the sweep flips to
forbid candidates in every view.

db/, .env, PAT never staged.
