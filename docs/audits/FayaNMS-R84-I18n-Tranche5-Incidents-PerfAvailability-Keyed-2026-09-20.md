# FayaNMS — R84: i18n Tranche 5 — incidents + perf-availability keyed (2026-09-20)

**Branch:** `main` (single-branch repo) · **Base:** `c95434f` (R83) · **Suite files:** 78 → 79

## 1. What landed

Two views fully keyed — the R56 `PENDING_VIEWS` debt ledger's fifth shrink:
**20 → 18 entries (690 → 646 candidates)**.

- `incidents-view.tsx` (OPERATIONS → "Incidents") through the NEW `incidents`
  namespace — **38 leaves** per locale.
- `perf-availability-view.tsx` (PERFORMANCE → "Availability") through the NEW
  `perfAvailability` namespace — **28 leaves** per locale.

Both namespaces: en = ar deep parity (machine-pinned both directions), non-empty
values everywhere, byte-preserving tail insertion after `baselines`
(dictionary 1,680 → **1,746 = 1,746** leaves).

## 2. incidents — the full inventory (hand-cleaned, including the non-swept plane)

The shallow sweep matched **22 candidates**; the hand inventory keyed every
user-visible literal, including the plane the regexes never see:

| Plane | Literal(s) | Key(s) |
|---|---|---|
| PageHeader | `Incidents`, `Incident lifecycle with SLA timers, timelines and post-incident reviews` | `title`, `description` |
| Status group chips (module-level const) | `All`, `Active`, `Resolved`, `In review`, `Closed` | `group.all`-shaped dynamic keys — `STATUS_GROUPS` dropped its `label` field; labels resolve via `` t(`group.${entry.key}`) `` (R82 `SORT_CHIPS` / R81 admin-system `GROUPS` dynamic-key precedent) |
| SLA-breached chip | `SLA breached` + the ` · ${count}` numeric suffix | `group.slaBreached` (suffix is a locale-neutral number separator) |
| KPI 1 | `Open incidents`, KPI status chip `live`, description = `openBySeverity` | `kpi.open`, `kpi.live`; description is a documented survivor (see §4) |
| KPI 2 template | `` `${breachedCount} past their SLA target` ``, `SLA breached` | `kpi.breachedDesc` (`{count}`), `kpi.breached` |
| KPI 3/4 templates | `` `Mean time to acknowledge|resolve · ${samples} samples / ${days}d` ``, `MTTA`, `MTTR` | `kpi.mtta`/`kpi.mttaDesc`, `kpi.mttr`/`kpi.mttrDesc` (`{samples}`, `{days}`) — MTTA/MTTR acronyms stay technical in both locales (NOC precedent) |
| KPI 5 template | `` `${met}/${total} resolved within SLA / ${days}d` ``, `SLA compliance` | `kpi.sla`, `kpi.slaDesc` (`{met}`, `{total}`, `{days}`) |
| Toolbar | `Search incidents` (sr-only), `Search title or number…`, `Severity` (aria), `Any severity`, `Site` (aria), `Any site`, `Sort` (aria), `Reset` | `toolbar.*` (8) |
| Sort items | `Newest first`, `Severity (SEV1 first)`, `SLA due soonest` | `sort.createdAt`, `sort.severity`, `sort.slaDueAt` |
| SectionCard conditional template | `` `Incidents${listMeta ? ` — ${listMeta.total}` : ""}` `` | `table.cardTitle` / `table.cardTitleCounted` (`{total}`) |
| ErrorState / EmptyState | `Incidents could not be loaded`, `No incidents to show`, `No incidents match the current filter.` | `error.title`, `empty.title`, `empty.description` |
| Row counts strip (non-swept) | `` `${devices} dev · ${alerts} alert${alerts === 1 ? "" : "s"}` `` | `row.counts` — ICU plural on `{alerts}`: en `one/other` with `#`; ar `zero/one/two/few/many/other` (R81 unsaved-changes precedent + `zero` added because 0-alert rows occur) |
| Pagination template + buttons | `` `Page ${page} of ${totalPages} · ${total} incidents` ``, `Previous`, `Next` | `pagination.summary` (`{page}`, `{totalPages}`, `{total}`), `pagination.prev`, `pagination.next` |

**38 leaves** per locale. Terminology: `الحوادث` (nav.ops.incidents),
`تمت المعالجة` for the RESOLVED chip (status.incidentStatus.RESOLVED verbatim),
`مباشر` for the live chip, `تجاوز SLA` (noc.slaBreached stem), `الخطورة`
(dashboard.incidents.description), `الالتزام بـ SLA`
(noc.backupCompliance shape), toolbar/pagination mirror `perfInterfaces`
(`أي موقع`, `إعادة تعيين`, `صفحة {page} من {totalPages} · {total} حادث` — the
R83 `{total} جهاز` number-plus-singular convention).

## 3. perf-availability — the full inventory

The shallow sweep matched **22 candidates**; the hand inventory keyed every
user-visible literal across all FOUR component scopes (view + OverallCard +
SiteTable + DeviceTable — each scope takes its own `useTranslations("perfAvailability")`):

| Plane | Literal(s) | Key(s) |
|---|---|---|
| PageHeader | `Availability`, `` `Uptime and SLA attainment — ${perfRangeLabel(range)}` `` | `title`, `description` (`{range}` — range label stays English via the shared chrome survivor, R82 precedent) |
| ErrorState | `Availability data could not be loaded` | `error.title` |
| OverallCard | `Fleet Availability`, `` `Target ${fmtPct(target, 2)}` ``, progress aria `` `Fleet availability ${pct} against target ${target}` ``, ternary `Meeting the SLA target for this window.` / `` `Below target by ${delta} percentage points.` `` | `overall.cardTitle`, `overall.target` (`{pct}`), `overall.progressAria` (`{pct}`, `{target}`), `overall.meets`, `overall.below` (`{delta}`) |
| SiteTable | `By Site`, `Worst site first`, `No site data`, `No sites have availability samples in this window.`, table aria `Availability by site — uptime vs the SLA target, worst sites first`, headers `Site`/`Uptime`/`Degraded`/`Downtime`/`Devices` | `site.cardTitle`, `site.cardDescription`, `site.emptyTitle`, `site.emptyDescription`, `site.ariaLabel`, `site.col.*` (5) |
| DeviceTable | `By Device — worst 25`, `Worst 25 devices in the selected window`, `No device data`, `No device availability samples in this window.`, table aria `Availability by device — uptime vs the SLA target, worst devices first`, headers `Device`/`Site`/`Uptime`/`Downtime`, sr-only ` — open device detail` | `device.cardTitle`, `device.cardDescription`, `device.emptyTitle`, `device.emptyDescription`, `device.ariaLabel`, `device.col.*` (4), `row.openDevice` (R82/R83 separator-in-code pattern) |

**28 leaves** per locale. Terminology: `الإتاحة` (matches the view's own nav
entry `nav.items.perf.availability`), `مدة التشغيل` (deviceDetail.record.uptime
verbatim), `مدة التوقف` (its natural complement), `التدهور` for the degraded
METRIC column (a noun for a percentage metric; the status adjective
`متدهور` stays in `ha.*`/`status.device` where it belongs), `إتاحة الأسطول`
(noc.fleetHealth shape), `الهدف {pct}` (systemSettings "هدف SLA" stem).

## 4. Documented survivors (unchanged policy, pinned in-source and by tests)

- **date-fns `formatDistanceToNow`** relative time (incidents rows) stays
  English — no ar locale is wired anywhere in the app (device-config-tab +
  R83 baselines precedent).
- **`openBySeverity` KPI description** (incidents) — static config SEV tokens
  split from `" — "` (`getStatusConfig(INCIDENT_SEVERITY, key).label.split("
— ")[0]`), joined `SEV1 1 · SEV2 1 · …` — data-plane tokens rendered
  identically in both locales (ConfidenceBadge HIGH/MEDIUM/LOW precedent);
  live-verified identical in EN and AR.
- **Duration unit tokens** — `fmtMinutes`/`fmtDowntime` render `min`/`h`/`d`
  and the `—` placeholder (NOC's `MTTA {mtta}m · MTTR {mttr}m` keeps the same
  `m` token in Arabic).
- **Numeric chip separators** — the ` · ${count}` suffixes on the Active and
  SLA-breached chips are locale-neutral number separators.
- **Shared perf chrome** — `PerfRangeChips` + `perfRangeLabel` (exported from
  perf-overview-view.tsx) stay English until the perf-overview tranche keys
  them; the import line and the `{range}` behaviour are pinned (R82
  precedent). Live effect: the AR description intentionally shows
  `مدة التشغيل وبلوغ SLA — last 24 hours` until then.
- **Data-plane titles** — hostnames, incident numbers, SEV badges, site codes.

## 5. Ledger governance

- `tests/audit/r56-i18n-chrome-sweep.test.ts`: `PENDING_VIEWS` drops
  `incidents-view.tsx: 22` and `perf-availability-view.tsx: 22` → **18
  entries, live sum 646** (ceilings == live on every entry); header gains the
  R84 paragraph; ledger doc comment lists tranche 5.
- Numeric pins updated to HEAD truth per the R82→R81 convention:
  `r81` 20→18, `r82` 20→18 and 690→646, `r83` 20→18 and 690→646.
- NEW `tests/audit/r84-i18n-tranche-5.test.ts` — **21 pins**: exact leaf
  counts ×2 namespaces ×2 locales (38/38/28/28), deep parity both
  directions, non-empty values, 14 interpolation placeholders, the ICU
  plural category shapes (en one/other; ar zero/one/two/few/many/other),
  namespace consumption (1 + 4 scopes), ZERO sweep both files, 35+25
  absent-literal source pins, 34+28 keyed-call-site pins, both ledger
  removals, exact-18 numeric ledger, LIVE candidate sum == 646 computed
  from the tree, and the survivor pins (date-fns, SEV config split,
  unit tokens, shared chrome import).

## 6. Suite

- `bun run lint` → 0. `bunx tsc --noEmit` → 0.
- Full suite in the CI gate env shape (Postgres :5433, BOM-stripped env):
  **1135 pass / 18 skip / 0 fail** (10,415 expects, 79 files; reconciliation
  1114@R83 + 21 r84 = 1135).
- Bare run (no env): **1106 pass / 18 skip / 29 fail** — the 29 fails are the
  unchanged R64 hermeticity contract (service-JWT/SSH/worker planes needing
  real secrets/sockets; fail blocks re-enumerated: P1-007 ×2, R50, R50.8,
  R51-A1, R62 P1-1, SAFE-002 ×2, service JWT verification) — zero i18n
  failures.
- i18n suites in isolation: **79/79** (r56+r80+r81+r82+r83+r84).

## 7. LIVE verification (agent-browser, admin@faya.local, EN + AR rtl/ar)

**incidents (EN):** title/description byte-exact; five KPI cards
(`Open incidents` + live chip, `SLA breached` + `4 past their SLA target`,
`MTTA`/`Mean time to acknowledge · 2 samples / 30d`, `MTTR`/`Mean time to
resolve · 2 samples / 30d`, `SLA compliance`/`2/2 resolved within SLA /
30d`); group chips `All`/`Active · 4`/`Resolved`/`In review`/`Closed`/
`SLA breached · 4`; toolbar (sr-only `Search incidents`, placeholder
`Search title or number…`, `Severity`/`Any severity`, `Site`/`Any site`,
`Sort`/`Newest first`); `Incidents — 6` counted title; row counts ICU on the
wire (`1 dev · 1 alert`, `1 dev · 0 alerts`, `2 dev · 1 alert`); keyed sort
exercised live (`Severity (SEV1 first)` → SEV1 row first); live search
`FortiGate` → `Incidents — 1` → keyed `Reset` → `Incidents — 6`.
**Pagination note:** the demo fleet holds 6 incidents (pageSize 25 →
totalPages 1), so the pagination footer is not reachable live in this
dataset — it is source-pinned (template + both buttons) exactly like the
counted-title path; identical shape was live-verified in R82 (perf-interfaces,
5 pages) and R83 (perf-devices, 2 pages).

**incidents (AR rtl/ar):** `الحوادث`, `دورة حياة الحوادث مع مؤقتات SLA
والجداول الزمنية ومراجعات ما بعد الحادث`, KPI chrome (`الحوادث المفتوحة`,
`مباشر` chip, `4 تجاوزت هدف SLA`, `متوسط وقت الإقرار · 2 عينة / 30d`,
`متوسط وقت الحل · 2 عينة / 30d`, `الالتزام بـ SLA`, `2/2 تمت معالجتها ضمن
SLA / 30d`), chips `الكل`/`نشطة · 4`/`تمت المعالجة`/`قيد المراجعة`/`مغلق`/
`تجاوز SLA · 4`, toolbar (`البحث في الحوادث`, `ابحث بالعنوان أو الرقم…`,
`الخطورة`/`أي خطورة`, `الموقع`/`أي موقع`, `الترتيب حسب`/`الأحدث أولاً`),
`الحوادث — 6`, AR ICU plurals on the wire (`تنبيه واحد` one / `0 تنبيهات`
zero-fallback / `2 جهاز · تنبيه واحد`); SEV2 filter live → `الحوادث — 2` →
keyed `إعادة تعيين` → `الحوادث — 6`; `document.documentElement` = `rtl | ar`.

**perf-availability (EN, 24H → 7D):** `Availability` +
`Uptime and SLA attainment — last 24 hours` (7D interpolation live:
`— last 7 days`); `Fleet Availability` + `Target 99.90%` + progress aria
`Fleet availability 100.00% against target 99.90%` + **meets branch**
(`Meeting the SLA target for this window.`) at 24H; switched the keyed range
chips to 7D → **below branch goes live** (`Below target by 1.60 percentage
points.` — both ternary sides verified on the wire); `By Site` +
`Worst site first` + table aria + five headers; `By Device — worst 25` —
empty at 24H (EmptyState verified live), **populated at 7D**: table aria +
`Device`/`Site`/`Uptime`/`Downtime` headers + sr-only
`— open device detail` accessible names on the wire.

**perf-availability (AR rtl/ar):** `الإتاحة`, `مدة التشغيل وبلوغ SLA — last
24 hours` (the documented `{range}` survivor), `إتاحة الأسطول`,
`الهدف 99.90%`, progress aria `إتاحة الأسطول 100.00% مقابل الهدف 99.90%`,
meets `يلبي هدف SLA لهذه النافذة.`, below `أقل من الهدف بمقدار 1.60 نقطة
مئوية.`, `حسب الموقع`/`الموقع الأسوأ أولاً` + five Arabic headers
(`الموقع`/`مدة التشغيل`/`التدهور`/`مدة التوقف`/`الأجهزة`), device table aria
`الإتاحة حسب الجهاز — مدة التشغيل مقابل هدف SLA، الأجهزة الأسوأ أولاً` + four
headers + `— فتح تفاصيل الجهاز` sr-only; the 24H device EmptyState verified
live (`لا توجد بيانات أجهزة` + `لا توجد عينات إتاحة للأجهزة في هذه النافذة.`).

**Cross-cutting:** zero console errors, zero page errors, zero
MISSING_MESSAGE across every step in both locales; mobile 390×844 →
`390 vs 390` (no horizontal overflow) on both views; 6 screenshots in
`agent-ctx/` (r84-incidents-en/ar, r84-availability-en/ar/ar-7d, plus mobile
390 for both views; untracked, per tranche convention).

## 8. Remaining tranches (ascending size)

admin-collectors (19), perf-overview (27 — **keys the shared perf chrome**,
retiring the cross-view survivor), admin-api-clients (27), changes (27),
events (27), snapshots (29), drift (30), backup-compliance (30),
change-approvals (33), alerts (36), maintenance (38), discovery (43),
incident-detail (43), admin-integrations (47), admin-users (51),
change-detail (52), backups (61) — 17 entries / 646 candidates.
End-state rule unchanged: empty ledger → the sweep flips to forbid
candidates in every view.
