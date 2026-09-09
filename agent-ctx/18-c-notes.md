# Task 18-c — Report Builder — implementation notes

## Files (ownership respected)
- `src/app/api/v1/reports/run/route.ts` (NEW) — POST on-demand generation, audited REPORT_BUILT.
- `src/components/views/report-builder-view.tsx` (NEW) — the view (not routed yet; orchestrator wires it).
- `src/hooks/api/use-report-builder.ts` (NEW) — `useRunReportBuilder` mutation + client artifact types.
- `agent-ctx/18-c-i18n.json` (NEW) — EN=AR (50 = 50) flat `builder.*` keys for the orchestrator to merge.

## Engineering decisions (documented in code comments too)
1. **saveSchedule hook = reuse, not duplicate.** `useCreateReportSchedule` in
   `src/hooks/api/use-reports.ts` already POSTs `/api/v1/reports/schedules` with the
   right envelope + cache invalidation (reports/jobs/events). The view imports it
   directly; `use-report-builder.ts` only adds the new `/reports/run` mutation and
   documents the reuse in its header.
2. **Client-side mirror of two pure helpers.** `src/lib/reports/generate.ts` imports
   the db client (server-only), so `expectedRangeFor` and `artifactToCsv` are
   deliberately duplicated (~6 and ~12 lines respectively) in the view with explicit
   "mirrors … in generate.ts" comments. Range labels resolve through the existing
   `reports.ranges.*` i18n keys (chosen over per-type i18n strings — cleaner: one
   mapping + already-localized labels).
3. **Save dialog includes a Recipients field.** The spec's minimal dialog (name +
   same selection) would 400 against the schedules POST contract, which requires
   `recipients: min(1)` valid emails (≤ 20). Dialog mirrors the scheduled-view
   conventions (comma-separated, client EMAIL_RE check, `text-danger` inline errors)
   and defaults `isActive: true` (API default). Success → toast + in-dialog success
   panel with an "Open scheduled reports" button → `setActiveView("reports.scheduled")`.
4. **PDF/XLSX honesty.** Generation is format-tagged only on this demo platform
   (artifact rows/columns identical; same as the scheduled pipeline). Documented in
   the route header AND surfaced in the UI via `builder.formatNote` + the
   delivery-format tag chip in the preview meta line. CSV/JSON downloads stay
   enabled for every format.
5. **Type cards** = Radix `RadioGroup` + card-wrapped `RadioGroupItem` (roving
   tabindex / arrow keys / SR semantics for free), grid-cols-1 sm:2 lg:3, per-card
   expected-range hint recomputed from the live frequency selection.

## Verification evidence
- `bunx tsc --noEmit` → 0 errors under src/ (fixed one self-inflicted shadowing of
  date-fns `format` by renaming the state to `deliveryFormat`).
- `bun run lint` → exit 0.
- `POST /api/v1/reports/run` unauthenticated → 401 UNAUTHENTICATED envelope
  (identical to schedules POST behavior — correct).
- Signed-in curl (credentials flow, admin@faya.local): valid body → success envelope
  `{ artifact, correlationId: RB-Y5TZXU }`, AVAILABILITY/DAILY → range LAST_24_HOURS,
  29 rows, columns hostname/site/uptimePct/downtimeMinutes/state/slaDelta;
  CAPACITY/QUARTERLY/PDF → RB-MVLXL2, 72 rows, format tag PDF, extra body key
  stripped by `.strip()`.
- Invalid body → 400 INVALID_BODY with the Zod first-issue message.
- Audit: GET /api/v1/events?action=REPORT_BUILT → 2 rows, actor "Amal Al-Sabri"
  (authenticated actor), resourceType REPORT, labels "AVAILABILITY · DAILY" /
  "CAPACITY · QUARTERLY", result SUCCESS, matching RB- ids, afterJson =
  {reportType, frequency, format, range, rows, generatedAt} — no artifact content.
- dev.log: no compile errors.
- Note: the two verification audit rows remain in the DB (no events DELETE API);
  orchestrator's post-phase pristine reseed covers this.

## i18n
- 50 `builder.*` keys EN = AR (verified programmatically, zero diff).
- Reused without duplication: `reports.types.*`, `reports.frequencies.*`,
  `reports.formats.*`, `reports.ranges.*`, `common.cancel`.
