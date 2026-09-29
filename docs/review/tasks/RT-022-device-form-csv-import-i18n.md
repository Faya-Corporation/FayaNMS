# RT-022 — Device form + CSV import: localize labels and validation copy

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-021 | A4-06 | P2 | M | Medium — validation-message plumbing (zod→RHF→render) must map issues to keys without breaking server-message fallback |

## Problem & evidence

`src/components/device/device-form-sheet.tsx`:
- lines 65-92 — the form's zod schema bakes in English messages: `.min(1, "Hostname is required")`, `.max(63, "Hostname is limited to 63 characters")`, `.regex(HOSTNAME_PATTERN, "Letters, digits and hyphens only")`, `"Vendor is required"`, `"Enter a valid IPv4 management address"`, and the superRefine message `"LIVE devices require a linked SSH credential profile"` (lines 85-92).
- lines 514-516 — `<DialogTitle>` area literals (sheet copy).
`src/components/device/csv-import-dialog.tsx`:
- lines 50-53 — `csvRowSchema` messages: `"hostname is required"`, `"hostname may contain letters, digits and hyphens"`, `"vendor is required"`, `"mgmtIp must be a valid IPv4 address"`; line 110 + 163-164, 184 — `"Nothing to import"`, `<DialogTitle>Import devices from CSV</DialogTitle>` etc.

The Add/Edit-device sheet and CSV import bypass i18n entirely (labels + ALL client validation copy). They also DUPLICATE server-side validation copy (the same rules restated in `src/app/api/v1/devices/route.ts`) — message drift risk between client and server rejections.

## Impact

Arabic operators get English validation errors on the two most-used forms; drift risk between client and server wording.

## Root cause

Forms predate the i18n tranches; zod schema messages were treated as untranslatable.

## Required change

Follow the audit's mapping pattern (RHF `errors.*.message` → key at RENDER time):

1. **Dictionary** — add `devices.form.*` and `devices.csv.*` to BOTH dictionaries (parity). Keys per rule: `hostnameRequired`, `hostnameMax`, `hostnamePattern`, `vendorRequired`, `mgmtIpPattern`, `liveRequiresCredential`, `importTitle`, `nothingToImport`, etc. — plus the sheet's visible labels if any are hardcoded (verify at implementation; the field labels may already come from `devices.form.*` keys — audit A4-06 says labels AND zod messages are English, so sweep both).
2. **`device-form-sheet.tsx`** — switch the zod schema to KEY-BASED messages: `.min(1, "errors.devices.form.hostnameRequired")` style is brittle; preferred pattern: keep a `RULE_KEYS` map (`{ hostname_min: "hostnameRequired", hostname_max: "hostnameMax", hostname_regex: "hostnamePattern", ... }`) and resolve at render: wherever `errors.<field>.message` is rendered, run it through a `tForm(message)` helper that returns `t(message)` when the message IS a dictionary key, else renders verbatim (this preserves the server-side `reason` fallback contract from A4-06's suggested fix: "keep server messages as `reason` fallback"). The superRefine issue carries the key `"liveRequiresCredential"` the same way.
3. **`csv-import-dialog.tsx`** — same pattern for `csvRowSchema` row errors (rendered per-row in the preview table); translate the dialog chrome (`Import devices from CSV`, `Nothing to import`, dropzone copy) directly via `t()`.
4. Do NOT change the SERVER validation copy (`src/app/api/v1/devices` route + csv import route) in this RT — client keys are authoritative for the client; server messages remain the fallback for API-level rejections. Note the deliberate duplication in a comment.
5. Update dictionary totals in the newest tranche test if it pins exact counts.

## Tests to add

File: `tests/audit/rt022-device-forms-i18n.test.ts` (render + source police).

1. `form schema messages are dictionary keys` — assert the zod schema strings are key-shaped (no English prose) in both files; assert every referenced key exists in BOTH dictionaries.
2. `render shows translated validation error` — render the sheet, submit empty hostname with ar catalog → localized `hostnameRequired` visible (render test with next-intl test provider, style of `tests/brand/accessibility.test.tsx`).
3. `server reason fallback preserved` — negative case: an unknown message string (simulating a server rejection) renders verbatim, not `[missing key: …]`.
4. `live-ssh credential rule still blocks submit` — behavioral: LIVE_SSH without profile → credentialProfileId error rendered (translated), submit blocked.
5. `csv dialog chrome translated` — title/`nothingToImport` keys used; row errors resolve through the same helper.
6. `dictionaries parity` — en/ar key sets equal.

## Acceptance criteria

- [ ] All form/CSV labels and client validation copy localized; server fallback untouched.
- [ ] Unknown (server) messages render verbatim — no key-crash regression.
- [ ] LIVE_SSH credential rule behavior unchanged.
- [ ] Dictionary parity exact; tranches green.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt022-device-forms-i18n.test.ts   # new suite green
bun test tests/audit/                                   # tranches green
bun test tests/                                         # no regressions
node_modules/typescript/bin/tsc --noEmit                # exit 0
bun run lint                                            # 0 errors
```

## Rollout & rollback notes

Two components + dictionaries; revert-safe. Scope note (flagged during planning): F-021 was not in the explicit scope lists; written as a fixable P2/M finding — main agent may re-scope to BACKLOG (it is the largest of the three gap-closure i18n RTs) by dropping this file and the plan row.
