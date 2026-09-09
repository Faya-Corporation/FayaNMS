# Task 10-c — i18n Depth Pass (status labels via shared badges + TimeRangeSelect)

Agent: i18n-depth-sweeper (Z.ai Code)

## What was done

1. **src/lib/domain/status.ts** — added `labelKey?: string` to `StatusBadgeConfig`; `makeConfig(family, key, label, token, icon)` now sets `labelKey: \`status.${family}.${key}\``. All call sites carry a lowerCamelCase family slug mirroring the file's section headers. `label` stays the English canonical string → zero behavior change for server consumers.

2. **src/hooks/use-status-label.ts (new, "use client")** — root-scoped `useTranslations()` + `t.has(labelKey)` guard + try/catch + `config.label` fallback.
   - CRITICAL next-intl mechanic: the translator must be ROOT-scoped. labelKey already contains `status.` and next-intl resolves keys RELATIVE to the namespace, so `useTranslations("status")` + `t("status.device.ONLINE")` looks up `status.status.*` and always misses (caught live: first AR render stayed English).
   - next-intl 4.7.0 has `t.has(key): boolean` (use-intl createBaseTranslator) and it returns false SILENTLY for missing keys — no console noise.

3. **src/components/domain/status-badge.tsx** — the single render site of `config.label` (span + title). Resolves via `useStatusLabel()`. The 7 wrapper badges (device/backup/change/drift/job/severity/change-risk) are pure pass-throughs with zero label renders → intentionally untouched ("exactly those that render a StatusBadgeConfig's label").

4. **src/components/domain/time-range-select.tsx** — labels resolve at render via `timeRange.options.<value>` (has-guard + English fallback from TIME_RANGES, which stays exported for the value type); aria-label/placeholder via `t("ariaLabel")/t("placeholder")`.

5. **messages/en.json + messages/ar.json** — appended `status` (82 keys) + `timeRange` (9 keys) via byte-preserving text insertion (git diff: zero existing content lines removed). Genuine Arabic network-ops terminology (متصل/غير متصل، مُمكَّن إدارياً، خامل، بانتظار الموافقة، قيد التراجع، تم التراجع، خطر منخفض…حرج، آخر 15 دقيقة…نطاق مخصص، النطاق الزمني). SEV tokens stay LTR.

## Deviation (forced by ownership boundary)

`labelKey` is OPTIONAL, not required: src/components/views/status-extras.ts (out of boundary, views/**) declares its own local makeConfig returning StatusBadgeConfig for 10 legacy maps (~70 configs). A required prop would break tsc with no legal fix. Those configs use the English-fallback path. Handoff: give status-extras' makeConfig the same `(family, key, …)` signature and add its families to both message files (suggested slugs: alertUi, incidentUi, changeUi, changeStepStatus, changeStepType, changeApprovalStatus, changeApprovalLevel, changeType, changeDeviceResult); hook needs no change.

## Verification results

- `bunx tsc --noEmit` → **0 errors under src/** (4 pre-existing in examples/ + skills/).
- `bun run lint` → clean (exit 0).
- Parity (bun one-liner): **EN 519 = AR 519** (428 → 519, +91), overall diff **0**; status **82 = 82** diff 0; timeRange **9 = 9** diff 0. Namespaces 12 → 14.
- Browser (agent-browser, admin@faya.local, :3000 → 200):
  - EN intact: Devices Online/Maintenance/Unmanaged; Incidents SEV1 — Critical / SEV2 — High / SEV3 — Medium + Open/Acknowledged/Investigating/Resolved/Closed; Backups Scheduled/Current; Job Center Succeeded/Running/Failed; TimeRangeSelect "Last 15 minutes…Custom range".
  - AR (dir=rtl): Devices **متصل/صيانة/غير مُدار** + **متوسط/مرتفع/منخفض/حرج** + **مطابق/لم تُؤخذ منه نسخة**; Incidents **SEV1 — حرج / SEV2 — مرتفع / SEV3 — متوسط**; Backups **مجدول/حالي**; Job Center **نجح/فاشل**; Drift **مفتوح**; Changes risk **خطر منخفض/متوسط/مرتفع**; TimeRangeSelect **النطاق الزمني** + **آخر 15 دقيقة/آخر ساعة/آخر 6 ساعات/آخر 24 ساعة/آخر 7 أيام/آخر 30 يوماً/نطاق مخصص**.
  - RTL: scrollWidth === viewport at 1440 (AR dashboard + drift, EN) ✓. Session console: **zero errors / zero warnings / zero MISSING_MESSAGE**.
- dev.log tail: clean (Prisma queries + 200s only).

## Known pre-existing issue found (not caused by this task, out of boundary)

At 375px the header actions cluster in shell/app-header.tsx (`ms-auto flex…`: search + data-dependent "1 critical alert" chip + notifications + user menu) overflows ~15px in BOTH locales (EN 396 / AR 390 vs vw 375). Zero badge elements overflow anywhere (badges are max-w-[24ch] truncate). Orchestrator handoff: wrap/hide the chip cluster at small widths.

## Remaining English status surfaces (documented, future pass)

status-extras.ts legacy maps (~70 configs, fallback English) + raw `.label` renders outside badges: devices-view chips/rows, backups-view 222/244/798, snapshots-view 187/206, drift-view 212, sites-view 121–123, reports-view 162, perf-interfaces-view 133/303, change-approvals-view 397–398/485, change-detail-view 711/1009, alerts-view 224, health-distribution-card 50, incidents-view 119, events-view private TIME_RANGES, kpi-card's own KpiCardStatus.
