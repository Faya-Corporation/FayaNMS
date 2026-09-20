# FayaNMS — R86: i18n Tranche 6b — admin-collectors keyed (2026-09-20)

**Branch:** `main` (single-branch repo) · **Base:** `4eb1405` (R85 confirm) · **Suite files:** 80 → 81

## 1. What landed

One view fully keyed — the R56 `PENDING_VIEWS` debt ledger's seventh shrink:
**17 → 16 entries (619 → 600 candidates)**.

- `admin-collectors-view.tsx` (ADMINISTRATION → "Collectors") — the registry
  half through the GROWN `collectors` namespace: **+29 leaves** per locale
  (`kind` 4 + `status` 2 + `registry` 23; the namespace totals 82 leaves —
  the Phase 15-b `distribution` section was already keyed and is untouched,
  keeping its own `useTranslations("collectors.distribution")` hook).

## 2. The keyed inventory (including the non-swept plane)

Swept plane — 19 candidates, matching the ledger ceiling exactly
(11 PROP + 8 JSX):

- PageHeader title + description; the `Refresh` action button.
- Three KPI labels (`Online`, `Worker service`, `Jobs completed`).
- The Registry card pair (`Rows persist the last known state — OFFLINE
  keeps history`).
- Error title + the non-swept `reason="Try again."` prop (PROP_RE never
  matched `reason=` — the R81 drivers precedent, keyed as
  `registry.error.reason`).
- Empty pair; table aria-label; the seven column headers.

Non-swept plane (hand-cleaned):

- `KIND_LABELS` (module-level label records) replaced by `KIND_KEYS`
  resolved via `` t(`kind.${key}`) `` at render with raw-token fallback —
  the R82 SORT_CHIPS / R81 GROUPS / R84 STATUS_GROUPS dynamic-key
  precedent. The raw-token fallback is load-bearing: `CollectorRow.kind`
  and `.status` are open `string` contracts in `api-client.ts`, so unknown
  tokens render as the API value exactly as before.
- The raw `{collector.status}` render now resolves via
  `` t(`status.${key}`) `` (same fallback shape).
- The `workerReachable ? "reachable" : "unreachable"` KPI value ternary →
  `registry.kpi.reachable` / `registry.kpi.unreachable`.
- The `"never"` last-seen fallback → `registry.row.never`.

## 3. Dictionaries

- `collectors.kind` / `collectors.status` / `collectors.registry`
  inserted inside the existing `collectors` namespace (R81 capacity.chrome
  precedent) — byte-preserving, +49 lines each file, zero deletions.
- Dictionary 1,822 → **1,851 = 1,851 leaves**, deep parity both directions
  (script-verified + machine-pinned).
- Terminology: المجمّعات (nav verbatim), المجمّع stem for the kind labels
  (المجمّع الدوري / مجموعّع التكوين), محرك stem (محرك التنبيهات /
  محرك الاحتفاظ — R85's `محرك الاحتفاظ البيانات` shape), متصل/غير متصل
  (status.device verbatim), خدمة العامل (the worker = العامل, established),
  آ **خر ظهور** (the established lastSeen term, reused verbatim),
  القدرات (drivers caps stem), تحديث (existing refresh key verbatim),
  أبدًا, حاول مجددًا. (drivers.error.reason verbatim).
- All new leaves are STATIC strings — no interpolation placeholders
  (pinned: the registry chrome has no templates).

## 4. Survivors (documented in-source + machine-pinned)

- The `online/total` ratio, `toLocaleString()` numerals, and the em-dash
  empty placeholders (numeric chip ` · ` + fmtMetric precedent).
- Capability badges are data-plane tokens in font-mono (the drivers-
  registry vendorLabel/adapter precedent).
- Data-plane hostnames/names (`worker-1`); `{collector.host ?? "—"}`.
- date-fns `formatDistanceToNow` English relative time (no ar locale
  wired anywhere — device-config-tab / R83-R85 precedent).
- The OFFLINE technical token stays Latin inside the AR card-description
  sentence (SEV-token / v{version} data-plane precedent) — pinned in the
  AR dictionary value itself.
- `v{agent.version}` + role/siteCode font-tech spans in the
  already-keyed distribution section (untouched).

## 5. Governance

- r56 sweep ledger: `admin-collectors-view.tsx` entry REMOVED — **16
  entries remaining**, live candidate sum over the ledgered files **600**
  (619 − 19), computed from the tree by the new pin (not quoted).
  Ceilings == live on every entry.
- Sweep header R86 paragraph + ledger doc comment updated.
- r81/r82/r83/r84/r85 numeric pins updated to HEAD truth per the
  R82→R81 convention (16 entries / 600 sum); r85's dictionary-total pins
  updated to 1,851 = 1,851.
- NEW `tests/audit/r86-i18n-tranche-6b.test.ts` — 18 pins:
  29-new-leaves ×2 locales (4+2+23, namespace total 82), dictionary
  totals 1,851 = 1,851, deep parity both directions, non-empty values,
  namespace consumption (1 `collectors` hook + the untouched
  `collectors.distribution` hook), ZERO sweep, 25 absent-literal source
  pins, 22 keyed-call-site pins, 10 dynamic-key/fallback pins, ledger
  removal + exact-16 numeric ledger + LIVE sum == 600 computed from the
  tree, all-static value shape, the AR OFFLINE-token survivor in the
  dictionary, drivers-error reason parity in BOTH locales, the lastSeen
  AR term reuse, and the data-plane/date-fns survivor pins.

## 6. Verification

- **Gates:** lint 0 · tsc 0 · i18n suites in isolation
  **118/118** (r56+r80..r86) · full suite
  **1174/18/0 in the CI gate env shape** (Postgres :5433; 11,189 expects,
  81 files; reconciliation 1156@R85 + 18 r86) · bare
  **1145/18/29** (29 = the unchanged R64 hermeticity contract; fail
  blocks re-enumerated: R50.8, service JWT, R51-A1, R50, SAFE-002 ×2,
  R62 P1-1, P1-007 ×2 — identical block set to R85).
- **LIVE (agent-browser, admin@faya.local, EN + AR rtl/ar):**
  - EN: title/description/Refresh/KPI labels byte-exact; worker down in
    dev → the KPI value honestly renders `unreachable` and the row's
    last-seen renders the keyed `never` fallback — both keyed states
    exercised live; `Registry` card; table aria; seven headers; the
    `Poller` kind badge via the dynamic-key path; `Offline` status.
  - AR (`ar / rtl` asserted): المجمّعات (nav verbatim), سجل المجمّعات —
    يُفحص مباشرةً من خدمة العامل, تحديث (exercised live — click ok),
    KPI متصل / خدمة العامل + غير قابلة للوصول + المهام المكتملة + — ,
    السجل card, table aria سجل المجمّعات — المجمّع والنقطة النهائية
    والقدرات وآخر ظهور, seven Arabic headers incl. آخر ظهور, المجمّع
    الدوري badge, غير متصل status, أبدًا fallback; the already-keyed
    distribution section renders `4 متصل` intact.
  - Honest live-coverage note: only the worker (POLLER) row exists in the
    demo DB right now (logical collectors register when their job types
    run), so Config collector / Alert engine / Retention engine badges
    are dictionary-pinned but their Arabic labels were not exercised on
    the wire this round; the dynamic-key mechanism itself is
    live-verified through the Poller badge.
  - Zero console errors / MISSING_MESSAGE / page errors in BOTH locales;
    mobile 390 no h-overflow (AR). 2 screenshots (agent-ctx, untracked).

## 7. Ledger after R86

16 entries / **600 candidates** (from 32 entries / 824 at R56):
admin-api-clients (27), admin-credentials (26), admin-integrations (47),
admin-users (51), alerts (36), backup-compliance (30), backups (61),
change-approvals (33), change-detail (52), changes (27), discovery (43),
drift (30), events (27), incident-detail (43), maintenance (38),
snapshots (29).

Next tranches by ascending size: admin-credentials (26), then the three
27s (admin-api-clients, changes, events), snapshots (29), drift (30),
backup-compliance (30), change-approvals (33), alerts (36),
maintenance (38), discovery (43), incident-detail (43),
admin-integrations (47), admin-users (51), change-detail (52),
backups (61). End-state rule unchanged: empty ledger → the sweep flips to
forbid candidates in every view.

db/, .env, PAT never staged.
