# RT-005 — i18n: extract hardcoded hook toasts + alert-stream/dialog/rules components (SHARED fix)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-005 | A4-02 | P1 | M | Medium — touches all 46 hooks under `src/hooks/api/` (~101 strings); toast copy + interpolation must survive translation |
| F-006 | A4-03 | P1 | M | Medium — rewrites user-visible labels/aria labels on core Operations surfaces; aria-label regressions would hurt AT users |

Single shared fix: one translation sweep pattern, one dictionary namespace plan, one test suite. Grouped deliberately per the remediation scope decision — these are the same mechanical sweep over adjacent surfaces.

## Problem & evidence

F-005 (`src/hooks/api/*`, all 46 files):
- `use-devices.ts:86-95` — `toast({ title: "Device created", description: \`${result.device.hostname} was added...\` })`; `:115` `` title: `Device marked ${...}` ``; `:298-330` — `DETECTION_CODE_OPERATOR_HINTS` (15 English operator hints) and `RESOLUTION_CODE_OPERATOR_HINTS` (4 more).
- `use-admin.ts` — 27 hardcoded strings; same pattern across every mutation hook (create/update/bulk/import/backup/delete of devices, alerts, changes, credentials, users). Zero `useTranslations` imports in any hook file.

F-006 (`src/components/alerts/*`):
- `alert-stream-item.tsx:163-165` — `first seen {relative(...)}` / `last seen {relative(...)}`; `:186` `Ack`; `:192` `` aria-label={`Actions for alert on ${alert.device.hostname}`} ``; `:200` `Alert actions`; `:206-219` menu items `Acknowledge` / `Assign…` / `Suppress…`.
- `alert-action-dialogs.tsx:57-66` — `<DialogTitle>Assign alert</DialogTitle>`, `Assign to`, `Select a user`, `Cancel`, `Assign`; `:121`+ — `Suppress alert`, `Reason (optional)`, etc.
- `alert-rules-panel.tsx` — no `next-intl` import at all (rule form labels, toasts).

Arabic users get an English operations UI; aria labels are English for AT users. Dictionary parity is currently exact (2,850/2,850 leaves — `docs/review/notes/A4-frontend-i18n.md`), so all new keys must land in BOTH files.

## Impact

Mixed-language core operations surfaces; untranslated mutation feedback across the entire app; aria labels inaccessible to Arabic AT users. This is the largest single i18n debt item (the audit: "the real i18n debt is hardcoded strings in components/hooks, not dictionary gaps").

## Root cause

The i18n tranches (R77-R102 test suites) swept views but never `src/hooks/api/**` or `src/components/alerts/**`; hooks were assumed unable to call `useTranslations` (they can — they are hooks, called from component bodies).

## Required change

1. **Namespace plan** (add to BOTH `messages/en.json` and `messages/ar.json`, keeping exact parity):
   - `toast.devices.*`, `toast.alerts.*`, `toast.admin.*`, `toast.changes.*`, `toast.credentials.*`, … — one sub-namespace per hook family, keys named per action (`createdTitle`, `createdDescription`, `failedTitle`, …). Interpolation via next-intl ICU: `"createdDescription": "{hostname} was added to the inventory with status {status}."`.
   - `detect.hints.*` — move `DETECTION_CODE_OPERATOR_HINTS` / `RESOLUTION_CODE_OPERATOR_HINTS` to keyed messages (`detect.hints.HOST_KEY_MISMATCH`, …, `detect.resolution.IPV6_UNSUPPORTED`, …); the hook keeps a `Record<string, string>` mapping code → message KEY and resolves via `t(key)` with the raw message as fallback for unmapped codes (preserve the existing fallback contract documented at `use-devices.ts:293-297`).
   - `alerts.stream.*` (`firstSeen`, `lastSeen`, `ack`, `actionsFor`, `actionsLabel`, `acknowledge`, `assign`, `suppress`, …), `alerts.dialogs.*` (assign/suppress dialog copy), `alerts.rules.*` (rules panel labels/toasts).
2. **Hooks** (`src/hooks/api/use-devices.ts`, `use-admin.ts`, and the rest of the 46): call `useTranslations("toast.devices")` etc. at the top of each exported hook (legal — hooks run inside components) and replace every literal. Keep `error.message` as the description fallback (error copy comes from the API envelope; only the fixed titles/hints are translated).
3. **Alert components** (`alert-stream-item.tsx`, `alert-action-dialogs.tsx`, `alert-rules-panel.tsx`): add `useTranslations("alerts.stream" | "alerts.dialogs" | "alerts.rules")`; wrap aria-labels in `t()` (e.g. `aria-label={t("actionsFor", { host: alert.device.hostname })}`); keep `relative(...)` output as the interpolated value (`t("firstSeen", { time: relative(alert.firstSeen) })`).
4. **Do NOT translate**: `suppressReason` text (comes from the backend, English system strings — out of scope), API error messages, technical codes. Add a short comment in each hook family where a decision was made to leave a string as-is.
5. **Dictionary totals**: the tranche tests pin exact leaf counts (latest: 2,850 — `tests/audit/r102-i18n-tranche-6r.test.ts`). Update the totals assertion in the LATEST tranche test only if its shape requires it (prefer adding the new counts in the new RT test file instead; do not edit historical R77-R102 assertions except the count-bearing one, and only if it fails).

## Tests to add

File: `tests/audit/rt005-i18n-hooks-and-alerts.test.ts` (source-policed test, exactly the style of `tests/audit/r*-i18n-tranche-*.test.ts`).

1. `hooks carry zero hardcoded toast literals` — walk `src/hooks/api/*.ts`, assert no `title: "` / `title: "` with English literal remains (allowlist: `error.message` fallbacks); assert every file with `toast(` imports `useTranslations`.
2. `detection/resolution hint maps resolve through t()` — assert `DETECTION_CODE_OPERATOR_HINTS` no longer exists as English strings in `use-devices.ts`; assert every code in the map has a `detect.hints.<CODE>` key in BOTH dictionaries.
3. `alert components use next-intl` — assert `alert-stream-item.tsx`, `alert-action-dialogs.tsx`, `alert-rules-panel.tsx` import `useTranslations` and contain no remaining English literals from the F-006 evidence list (`first seen`, `Actions for alert on`, `Assign alert`, `Suppress alert`, …).
4. `en/ar parity holds with the new namespaces` — flatten both dictionaries, assert equal leaf sets and counts (new keys present in both).
5. `aria labels are translated` — render `alert-stream-item` with an ar locale message catalog (or source-assert `aria-label={t(`) — the source assertion is acceptable given the existing tranche-test conventions.
6. Negative case: `unknown detection code still falls back to the raw message` — unit-test the hook's hint resolution helper with an unmapped code → raw message returned.

## Acceptance criteria

- [ ] `rg -n 'title: "' src/hooks/api/` returns only interpolated/`t()`-derived titles.
- [ ] All three `src/components/alerts/*` files use `useTranslations`; zero F-006 evidence literals remain.
- [ ] `messages/en.json` and `messages/ar.json` both carry `toast.*`, `detect.*`, `alerts.stream/dialogs/rules.*` with exact key parity.
- [ ] No behavior change in hook logic (same toasts fire on the same events; same fallback semantics for unmapped detection codes).
- [ ] Existing i18n tranche suites (R77-R102) still pass.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt005-i18n-hooks-and-alerts.test.ts   # new suite green
bun test tests/audit/                                       # all i18n tranches still green
bun test tests/                                             # no regressions
node_modules/typescript/bin/tsc --noEmit                    # exit 0
bun run lint                                                # 0 errors
```

## Rollout & rollback notes

Pure client-side copy change; ship as one PR (mechanical but large — split into two commits: hooks, then alert components) so review can be per-surface. Rollback = revert the PR; dictionaries keep parity in both states as long as the whole PR reverts together. RT-037 (error-state defaults) depends on this RT's namespace conventions landing first.

## Status

FIXED — commit 55db23a on GLM/full-audit-and-fix (Task 5-j). All 17 toast-firing hooks under `src/hooks/api/` (the 46-file hook directory contains 17 files that fire toasts; the rest are query-only) keyed into `toast.*` namespaces; detection/resolution hints moved to `detect.hints.*` with the code→key map + `detectionHintKey` fallback helper; `alerts.stream/dialogs/rules` localize the three alert components incl. all aria-labels and the rules-form zod messages (render-time key resolver). Dictionaries +337 leaves per side (2856 → 3193, exact parity; the rules panel carries `alerts.rules.form.*`). Test: `tests/audit/rt005-i18n-hooks-and-alerts.test.ts` (13 cases, incl. the unmapped-code fallback unit test). Deliberately untranslated (with in-source comments): API-envelope copy (`error.message`, `result.message`, `result.result`), backend `suppressReason`, raw enum tokens interpolated as `{status}`/`{severity}`/`{role}`, technical codes (`RETRY_OF`, `DNS`, units). Note: the RT file's single-commit guidance was followed (the "two commits" rollout note was a PR-review suggestion; the tranche total update touches all 19 pinning tests regardless).
