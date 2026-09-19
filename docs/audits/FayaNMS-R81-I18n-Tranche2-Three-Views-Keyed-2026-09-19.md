# FayaNMS — R81: i18n Tranche 2 — Three Views Keyed (admin-drivers · perf-capacity · admin-system)

**Date:** 2026-09-19 · **Branch:** `z_ai_v2` (= `origin/main` = `11e353d` before this round) · **Suite:** 1073 → **1082/18/0** (9,266 expects, 76 files; bare-run 29-fail = R64 hermeticity baseline, clean-tree-verified) · lint 0 · tsc 0 · LIVE green (EN + AR)

---

## 1. Provenance and why this round exists

The R80 handoff queued the remaining `PENDING_VIEWS` debt ledger in ascending-size
tranches. R81 = **tranche 2: the three smallest remaining views** —
`admin-drivers-view.tsx` (10 swept candidates), `perf-capacity-view.tsx` (16) and
`admin-system-view.tsx` (16) — removing **42 candidates and three ledger entries**
(791 → 749; ledger 26 → 23).

Truth-first pre-flight this round re-measured every tranche file with the sweep's exact
regexes BEFORE editing: all three counts matched their R56 ceilings exactly (no drift
since R56), and the same measurements were re-taken after keying (all three now **0**).
The merge state from the earlier session was also re-verified: `origin/main` =
`origin/z_ai_v2` = `11e353d` (R80), `0 0` both directions — nothing pending.

## 2. What changed

### 2.1 Dictionaries (`messages/en.json`, `messages/ar.json`)

Two NEW namespaces appended at the tail (R80 discipline — byte-preserving anchored
insertion, no re-serialization, zero existing content lines removed) plus one chrome
block added INSIDE the existing `capacity` namespace:

| Key path | Leaves (en = ar) | Consumed by |
|---|---|---|
| `drivers` | 13 | `admin-drivers-view.tsx` |
| `systemSettings` | 44 | `admin-system-view.tsx` |
| `capacity.chrome` (existing `capacity` ns) | 35 | `perf-capacity-view.tsx` |

Total dictionary: **1,577 = 1,577 leaves per locale** (deep parity both directions —
verified by script AND machine-pinned by the r56 sweep, which passes unchanged). The
pre-round baseline measured 1,485 leaves (the R80 commit prose said 1,484; the git-tree
truth at `11e353d` is 1,485 — recorded here as measured).

### 2.2 The three views — hand-cleaned against FULL inventories

Each view was cleaned beyond the shallow sweep's reach (the R80 method):

- **admin-drivers** — the 10 swept props keyed through `drivers.*`, PLUS the non-swept
  literals: `reason="Try again."` (the sweep's PROP_RE never matched `reason=`),
  the lowercase `flavor {configFlavor}` prefix (→ `flavorPrefix`) and the `{n} caps`
  badge (→ `caps`, flat `"{count} caps"` preserving current EN chrome byte-exactly;
  Arabic carries the full one/two/few/many/other ICU plural).
- **perf-capacity** — the 16 swept literals keyed through `capacity.chrome.*`, PLUS the
  non-swept plane: the module-level `metricLabel()` helper now takes a translate
  function (`metricLabel(metric, t)` — structural `TranslateFn` type, no next-intl
  typing gymnastics) so the metric labels (CPU/Memory/Latency/Packet loss/Utilization
  in/out) localize at all eight call sites including inside the chart tooltip (labels
  object gained a `metric` member) and the `chartLabel`/`inspectFor` aria-labels;
  the table's template-literal aria-label (`Capacity risks — days to cross the …`)
  → `risks.tableLabel`; the `Sorted by days-to-threshold ascending — …` description →
  `risks.sortedBy`; the KPI ternary status labels (`action needed`/`watch`/`clear`) →
  `status.*`; the DaysToThresholdChip's lowercase `stable` and `{n} d` → `chip.stable`
  / `chip.days`; the ReferenceLine `Horizon {n}%` → `chrome.horizonLine`; the
  `History (1D rollups)` legend → `chrome.historyLegend`; the sr-only
  ` — open device detail` → `risks.openDeviceDetail`; the two
  `${hostname} · ${metricLabel(...)}` ternaries → `risks.selectedSeries`; the
  PageHeader title `Capacity` → `chrome.pageTitle`.
- **admin-system** — the 16 swept literals keyed through `systemSettings.*`, PLUS the
  colon-syntax `GROUPS` const (never matched by either regex — `title: "General"` has
  no `=`): the array now stores prefixes only and the SectionCard resolves
  `t(\`group.${prefix}.title\`)` / `.description` at render (the R56 devices
  `columns.${key}` precedent); the `Save {n}` header button → `save`/`saveWithCount`;
  the KPI `valid`/`broken` value ternary → `chain.validValue`/`chain.brokenValue`;
  the `Run backfill` button (expression-child text, invisible to JSX_RE) →
  `chain.runBackfill`; the chain badges → `chain.validBadge` (with `{count}`) /
  `chain.brokenBadge` (with `{index}`); the inconsistency paragraph split into
  `chain.inconsistencyPrefix` + `chain.inconsistencyTail` (the `<code>` mono wrapper
  preserved); the auto-chain note → `chain.autoChainNote`; the tier pointer card →
  `tiers.*` (with the RTL-correct `الأداء ← نظرة عامة على الأداء` link label); the
  lowercase `updated {date}` row stamps → `updated`; the unsaved-changes guard → the
  `unsavedChanges` ICU plural (en one/other; ar one/two/few/many/other) + `saveNow`.

## 3. Documented technical survivors (unchanged policy, R56 §)

- **ConfidenceBadge** renders the API's `HIGH`/`MEDIUM`/`LOW` token as-is — data-plane
  enum, same precedent as the LIVE chip / MTTA acronyms (comment added in-source).
- **admin-system** rows render `setting.label` (and `aria-label={setting.label}`) from
  the Setting table — DB content, like hostnames.
- **admin-drivers** registry manifests render as-is: `vendorLabel`, `adapter`,
  `cap.label`, `configFlavor`, `notes` — VENDOR_LABELS precedent (documented in-source).
- `capacity`: date-fns English month/day formatting (R80 policy), `n/a` band value,
  recharts internal series names (`value`/`forecast`, never rendered — the custom
  tooltip uses the localized labels), "—" placeholders.

## 4. Gates (CI env shape)

`DATABASE_URL=postgresql://fayanms:fayanms-ci-only@localhost:5433/fayanms` (CI shape):

- `bun run lint` → **0**.
- `bunx tsc --noEmit` → **0**.
- `bun test tests/` → **1082 pass / 18 skip / 29 fail** — the 29 fails are the
  R64 hermeticity contract (R50/R51/R62/SAFE-002 vendor-detect + service-JWT + worker
  planes needing the full CI runner). **Clean-tree stash baseline re-run this round:
  identical 29 fails** (1044 pass / 18 skip / 8,868 expects at HEAD `11e353d`) —
  zero regressions; the delta is exactly the new pins (+9 tests, +398 expects, +1 file).
  The r56 sweep + r80 + r81 i18n suites in isolation: **26/26 pass**.

## 5. LIVE verification (agent-browser, admin@faya.local, dev server 200)

Walked per locale (locale switched via the header dropdown; `document.documentElement`
asserted `ar / rtl` then `en / ltr`):

- **Device Drivers** — EN: `Device Drivers | Adapters | Distinct capabilities |
  Config flavors | Catalog | flavor cisco-ios | 3 caps` all rendered; registry
  survivors intact (Cisco / Session connect / Config fetch …). AR: `مشغّلات الأجهزة |
  المهايئات | قدرات مميزة | الكتالوج | نمط cisco-ios | 3 قدرات` — the ICU plural `few`
  category live for 3 caps.
- **System Settings** — EN: title, chain card, `Verify chain`, `Run backfill`, tier
  pointer + `managed elsewhere`, all six group headings (`General | Backups | Drift |
  Alerts | Metrics | Performance`) — the dynamic `group.${prefix}` keys resolve.
  AR: `إعدادات النظام | سلسلة تجزئة التدقيق | تحقّق من السلسلة | احتفاظ طبقات المقاييس`
  + all six Arabic group headings. **ICU plural exercised live**: toggled a boolean
  setting → header `حفظ (1)` + sticky bar `تغيير واحد غير محفوظ` + `احفظ الآن`
  (screenshot), then toggled back WITHOUT saving (state clean).
- **Capacity** — EN: title, three KPI cards, `Capacity Risks`, all column headers
  (`Device / Metric | Current | Slope | Horizon | Confidence`); forecast chart
  `Horizon 80% | History (1D rollups)` after clicking `Inspect forecast`. AR: `السعة`,
  `في خطر خلال ≤ 30 يومًا`/`≤ 90`, `سليم`, keyed table aria-label live
  (`مخاطر السعة — الأيام لعبور أفق 80 بالمئة، 15 من السلاسل المتابَعة`), `المعالج`
  metric labels inside rows and `inspectFor` aria-labels, day chips `18 يومًا`,
  forecast chrome `الأفق 80% | السجل (تجميعات يومية)`.
- **Zero** console errors / `MISSING_MESSAGE` / page errors in BOTH locales across all
  three views (checked after every view). A mis-click during the walk also re-verified
  the device-detail plane in Arabic (tabs, `متصل`, actions) — clean.
- **Mobile 390×844 (AR)**: capacity + system settings — `scrollWidth == clientWidth`
  (no h-overflow). 9 screenshots in `agent-ctx/verify-r81-*.png`.

## 6. Handoff — the debt ledger after tranche 2

Ledger: **23 entries / 749 candidates** (was 26 / 791). Next tranches by ascending
size: perf-interfaces (18), perf-devices (20), baselines (20), incidents (22),
perf-availability (22), perf-overview (27), admin-api-clients (27), changes (27),
events (27), … admin-users (51), change-detail (52), backups (61). The perf-* views
share heavy chrome (Site / Search host / Reset / Previous / Next / table headers) —
tranche 3 can factor a shared `perfChrome` pattern if the ledgers' shapes agree.
End-state rule unchanged: empty ledger → forbid candidates in every view.

db/, `.env`, and the PAT were never staged. All work on branch `z_ai_v2`; `main`
fast-forwarded to the same commit after push.
