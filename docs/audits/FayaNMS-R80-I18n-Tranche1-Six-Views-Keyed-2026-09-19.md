# FayaNMS — R80: i18n Tranche 1 — Six Views Keyed (placeholder · ztp · changes-templates · noc · changes-calendar · sites)

**Date:** 2026-09-19 · **Branch:** `z_ai_v2` (synced to `origin/main` = `7f35bb5` before this round) · **Suite:** 1064 → **1073/18/0** (8,919 expects, 75 files) · lint 0 · tsc 0 · LIVE green

---

## 1. Provenance and why this round exists

The R56-era orchestrator handoff (`worklog.md` Task 10-integration+closeout) documented two
remaining i18n surfaces: (1) the `status-extras.ts` legacy maps — **completed in that same
closeout** (the file already carries the `(family, key, …)` signature with `labelKey`
resolution; all 22 `status.*` families exist in both dictionaries); and (2) the per-view
`.label` adoptions + chrome copy — machine-tracked since R56 by the `PENDING_VIEWS` debt
ledger in `tests/audit/r56-i18n-chrome-sweep.test.ts` (32 views pinned at ceilings that
"may only shrink").

Truth-first re-measurement this round: the ledger was **untouched at 824 shallow-sweep
candidates across 33 files** (R56 ceilings all exact). With the roadmap's authorable queue
empty (Phase HC fully landed at R79/HC-6; the rest operator-gated), the debt ledger is the
only remaining in-sandbox authorable program → **R80 = tranche 1: fully key the six
smallest views** (all ≤ 9 candidates), removing 33 candidates and six ledger entries
(824 → 791; ledger 32 → 26).

## 2. What changed

### 2.1 Dictionaries (`messages/en.json`, `messages/ar.json`) — five new namespaces

Byte-preserving text insertion before the final root brace (the R56 discipline — no
re-serialization; zero existing content lines removed):

| Namespace | Leaves (en = ar) | Consumed by |
|---|---|---|
| `sites` | 13 | `sites-view.tsx` (both components) |
| `noc` | 23 | `noc-view.tsx` |
| `changesCalendar` | 17 | `changes-calendar-view.tsx` |
| `changeTemplates` | 11 | `changes-templates-view.tsx` |
| `placeholder` | 2 | `placeholder-view.tsx` |

Total dictionary: 1,484 = 1,484 leaves per locale (deep parity, both directions —
machine-pinned by the R56 sweep, which still passes unchanged).

Arabic is genuine professional net-ops terminology consistent with the existing
dictionary style: المواقع، حالة الأجهزة، الالتزام بالنسخ الاحتياطي، فئات حرجية،
الحوادث النشطة، التنبيهات النشطة، الأجهزة حسب الحالة، عبر الأسطول، تقويم التغييرات،
النوافذ المجدولة، قوالب التغيير، نقاط انطلاق لكل مورد… ICU `{count}`/`{total}`/
`{compliant}`/`{online}`/`{managed}`/`{month}`/`{phase}`/`{mtta}`/`{mttr}` placeholders
in lockstep.

### 2.2 Views keyed (hand-cleaned against the FULL inventory, not just the sweep regexes)

- **sites-view.tsx** — PageHeader, ErrorState, EmptyState, managed/total, device status,
  no-devices, interfaces, criticality classes, backup compliance label + compliant count,
  View devices (9 sweep candidates + 4 non-swept literals; both components consume `sites`).
- **noc-view.tsx** — wallboard title, SLA-breached chip, fullscreen button (aria + text),
  active-incidents section aria + heading + open-count + MTTA/MTTR suffix, all-clear,
  fleet-health section aria, devices-by-status + online/managed, active-alerts top-N,
  jobs + active-in-queue + total, backup-compliance + fleet-wide window + ok/late/bad,
  footnote (7 sweep candidates + 13 non-swept literals incl. lowercase and template copy).
- **changes-calendar-view.tsx** — title (ICU month), description, prev/next month aria,
  Today, scheduled windows, error title, **the seven weekday headers** (new
  `weekdays.{sun..sat}` keys replacing the `WEEKDAYS` English array), "{n} more…",
  no-site fallback, empty-month note (7 sweep candidates + 4 non-swept).
- **changes-templates-view.tsx** — title, description, info banner, empty states,
  Use template, Default title, "Execution steps ({count})", the three ✓ badges
  (6 sweep candidates + 5 non-swept).
- **placeholder-view.tsx** — EmptyState description + the template-literal
  "This module arrives in {phase}" (1 sweep candidate + 1 non-swept template).
- **ztp-view.tsx** — **already fully keyed** (R44-era `ztp` namespace); its three sweep
  candidates are the technical example placeholders `FAB-2026-0117` / `BR2-ACC-SW-09` /
  `C9200L-48P-4X` (serial / hostname / model format hints — locale-neutral tokens).

### 2.3 Sweep governance moved with the tranche (`tests/audit/r56-i18n-chrome-sweep.test.ts`)

- Six files removed from `PENDING_VIEWS` (32 → 26 entries).
- New `KEYED_SURVIVORS` map with an EXACT-match pin ("keyed views carry EXACTLY their
  documented technical survivors") — the same governance precedent as devices-view's
  `LIVE` chip: `ztp-view.tsx` is pinned to exactly its three technical placeholders;
  any literal addition or change in that file now FAILS the sweep.
- The "every view with candidates is either clean, the LIVE chip, or ledgered" test now
  also skips `KEYED_SURVIVORS` files (their zero-tolerance contract lives in the new
  dedicated test).
- Header comment records the tranche (R80: six views keyed, 824 → 791 candidates).

### 2.4 New pins (`tests/audit/r80-i18n-tranche-1.test.ts` — 8 tests)

- **A** five new namespaces exist in BOTH dictionaries, leaf-balanced, non-trivial.
- **B** deep parity both directions for the five namespaces.
- **C** all six views consume their namespaces (`useTranslations("…")` source pins).
- **D** the five newly keyed views sweep at ZERO candidates; ztp's remaining three are
  EXACTLY the documented technical placeholders.
- **E** ledger governance source-pins: the r56 sweep no longer carries numeric ledger
  entries for the six files, and `KEYED_SURVIVORS` governs ztp-view.

## 3. Documented technical survivors (unchanged policy, R56 §)

`LIVE` chip (devices-view); date-fns English relative times and `MMMM yyyy`/`EEEE, MMM d`
month names (locale-neutral technical formatting, `ltr-technical` surfaces); the wallboard
clock (`en-GB` 24 h); MTTA/MTTR/SLA/NOC acronyms; `VENDOR_LABELS` product names
(Cisco IOS / IOS-XE, Fortinet FortiOS, Sophos SFOS, HPE AOS-CX); ztp's three technical
example placeholders (now exact-match governed); data-plane strings (hostnames, site
names/codes, template titles/steps, incident/alert messages, audit actions).

## 4. Gates (CI env shape)

```
set -a; . /tmp/fayanms-ci-gate.env; set +a; FAYANMS_PROBE_ALLOW_SPECIAL=true bun test tests/
  → 1073 pass / 18 skip / 0 fail · 8,919 expect() · 75 files   (was 1064/18/0, 8,616, 74)
bun run lint      → 0
bunx tsc --noEmit → 0
```

Bare `bun test` (ambient dev `.env`) fails ~30 service-JWT/worker-plane tests — the known
R64 hermeticity contract: those suites require the CI env shape (empty
`FAYANMS_SERVICE_*`), not a code regression; verified by a clean-tree stash baseline
reproducing the same failures.

## 5. LIVE verification (agent-browser, admin@faya.local, dev server 200)

**EN (baseline intact):**
- Sites: heading "Sites"; per-card "managed / N total", "Device status", "N interfaces",
  "N criticality classes", "Backup compliance", "N/N devices compliant", "View devices".
- NOC wallboard: "NOC — OPERATIONS WALLBOARD", "4 SLA BREACHED", "Fullscreen",
  "ACTIVE INCIDENTS", "— 4 OPEN · MTTA 7.5M · MTTR 115M", "DEVICES BY STATUS — 25/29
  ONLINE", "ACTIVE ALERTS — TOP 7", "JOBS / active in the queue / total 13489",
  "BACKUP COMPLIANCE / 96.6% / fleet-wide · 24h window / 28 ok · 0 late · 1 bad",
  full footnote.
- Change Calendar: "Change Calendar — September 2026", description, "Scheduled windows",
  "Today", Sun/Mon/Tue/Wed/Thu/Fri/Sat headers.
- Change Templates: title, description, banner, "Default title" ×4, "Execution steps (5)"
  ×4, Implementation/Validation/Rollback ✓ ×4, "Use template" ×4, vendor product names.
- ZTP: queue + history headings (form technical placeholders pinned in code).

**AR (switcher → `dir="rtl" lang="ar"`, zero MISSING_MESSAGE):**
- Sites: المواقع، مُدار من إجمالي N، حالة الأجهزة، N واجهات، N فئات حرجية، الالتزام
  بالنسخ الاحتياطي، N/N أجهزة ملتزمة.
- NOC: NOC — لوحة العمليات، 4 تجاوز SLA، ملء الشاشة، الحوادث النشطة، 4 مفتوحة،
  الأجهزة حسب الحالة + متصل، التنبيهات النشطة — أعلى 7، المهام ×2، في قائمة الانتظار،
  الإجمالي 13489، الالتزام بالنسخ الاحتياطي، عبر الأسطول · نافذة 24 ساعة، 28 سليم ·
  0 متأخر · 1 فاشل، التذييل العربي كاملاً.
- Calendar: تقويم التغييرات — September 2026 (date-fns month = documented survivor),
  وصف عربي، النوافذ المجدولة، اليوم، أحد/اثنين/ثلاثاء/أربعاء/خميس/جمعة/سبت.
- Templates: قوالب التغيير، البانر العربي كاملاً، استخدام القالب ×4، العنوان الافتراضي
  ×4، خطوات التنفيذ (5) ×4، تنفيذ/تحقق/تراجع ✓ ×4.
- ZTP: التهيئة الصفرية، سجل التهيئة.

**Health:** session console = zero errors / zero warnings / zero MISSING_MESSAGE (benign
HMR logs only); zero page errors; RTL `scrollWidth === 1440` at 1440 (no h-overflow);
LIVE three-point `200 / 200 / 401` (app · `/api/v1/meta` · unauth devices fail-closed).

Screenshots: `agent-ctx/verify-r80-sites-en.png`, `verify-r80-noc-en.png`,
`verify-r80-calendar-en.png`, `verify-r80-templates-en.png`,
`verify-r80-sites-ar-rtl.png`, `verify-r80-noc-ar-rtl.png`,
`verify-r80-calendar-ar-rtl.png`, `verify-r80-templates-ar-rtl.png`,
`verify-r80-placeholder-ar-rtl.png`.

**Placeholder note:** every registry key now resolves to an implemented view (44/44 have
router cases) — `PlaceholderView` is currently unreachable at runtime; its verification is
static (namespace consumption + zero candidates + parity pins). The keyed copy ships ready
for the day a registry entry falls through to the default branch again.

## 6. Sandbox infra note (dev-server resilience, no repo impact)

Mid-round the sandbox OOM-killed the dev server three times during the cold Turbopack
compile of `/` (cgroup `oom_kill` counter; 4 GB cgroup limit; peak > 2 GB RSS). Recovery:
`NODE_OPTIONS="--max-old-space-size=896"` + incremental warm-restart loop (each attempt
banks `.next/dev` cache) → green. Two diagnostic artifacts of that recovery are worth
recording for future rounds: (a) `next dev` **exits 0 silently when port 3000 is held by a
zombie server** — after killing the `bun run dev` wrapper, the child `next-server` can
survive and hold the port, making later starts look like instant crashes; check
`ss -tlnp | grep 3000` and the full process tree before restarting; (b) the suite must run
in the CI env shape (§4) — the bare invocation is not the gate. No repo file was changed
for any of this.

## 7. Handoff — the debt ledger after tranche 1

Ledger: **26 entries / 791 candidates** (was 32 / 824). Next tranches by ascending size:
admin-drivers (10), perf-capacity (16), admin-system (16), perf-interfaces (18),
perf-devices (20), baselines (20), incidents (22), perf-availability (22), … backups (61),
change-detail (52). The sweep's end-state rule is unchanged: when the ledger empties, flip
it to forbid candidates in every view. Non-status English copy outside the ledger's scope
(e.g. `status-extras.ts` consumers' data-derived labels) remains documented in the R56-era
handoff notes.

db/, `.env`, and the PAT were never staged. All work on branch `z_ai_v2`; `main` fast-forwarded to the same commit after push.
