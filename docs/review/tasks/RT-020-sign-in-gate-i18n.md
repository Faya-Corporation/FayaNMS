# RT-020 — Sign-in gate: localize the login surface (en/ar)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-019 | A4-04 | P2 | S | Low — copy-only sweep on the pre-auth screen; error-copy mapping must keep the credentials-vs-disabled distinction |

## Problem & evidence

`src/components/auth/sign-in-gate.tsx` — entirely hardcoded English, no `useTranslations`:
- line 67: `"Invalid email or password."` (CredentialsSignin mapping), line 76: `"Sign-in failed — the server could not be reached."`
- line 100: `Sign in to your account to access the platform.`
- line 105/117: `<Label>Email</Label>` / `<Label>Password</Label>`; line 131: `` aria-label={showPassword ? "Hide password" : "Show password"} ``
- lines 153-167: `Signing in…` / `Sign in`; lines 173-185: `Demo credentials` aside, `Demo accounts`, the password hint sentence; lines 224-229: the auditor-privacy footnote.

`LocaleProvider` deliberately mounts next-intl ABOVE the gate (layout.tsx:99), so the component CAN translate — it just never does. Arabic users get an English sign-in with English error copy.

## Impact

The first screen every user sees is English-only for ar users, including security-relevant error copy and aria labels (AT users).

## Root cause

The gate predates the i18n tranches and was never swept (documented in A4-04).

## Required change

1. **Dictionary** — add namespace `auth.signIn.*` to BOTH `messages/en.json` and `messages/ar.json` (exact parity): `subtitle`, `email`, `password`, `showPassword`, `hidePassword`, `submit`, `submitting`, `errorCredentials`, `errorServer`, `demoTitle`, `demoAsideLabel`, `demoPasswordHint` (ICU-safe: keep the `faya123` code as `{code}` interpolation wrapped in the `ltr-technical` span), `privacyNote`.
2. **`src/components/auth/sign-in-gate.tsx`** — `const t = useTranslations("auth.signIn");` and replace every literal above. Preserve EXACTLY:
   - the `result.error === "CredentialsSignin"` branch (translate the message, keep the mapping: NextAuth error codes are not translated, only the display copy);
   - the non-CredentialsSignin branch renders `result.error` verbatim (server-sent "Account disabled" — leave as-is with a comment, or add `auth.signIn.errorDisabled` ONLY if the string is matched locally — it is not; keep verbatim);
   - all `htmlFor`/`id` pairs and `autoComplete` values (behavioral, not copy);
   - `aria-label={t(showPassword ? "hidePassword" : "showPassword")}`.
3. Demo-account names/roles/emails (lines 25-31) are DATA (seeded personas) — leave untranslated; translate only the surrounding copy. Keep `ROLE_TONE` untouched.
4. Update dictionary totals in the newest tranche test IF it pins exact counts (same rule as RT-005).

## Tests to add

File: `tests/audit/rt020-sign-in-gate-i18n.test.ts` (source police + render, style of `tests/audit/r56-i18n-chrome-sweep.test.ts`).

1. `sign-in gate uses next-intl` — assert `useTranslations` import and `auth.signIn` namespace usage in `sign-in-gate.tsx`.
2. `zero hardcoded copy remains` — regex for the F-019 evidence literals (`Invalid email or password.`, `Demo accounts`, `Show password`, `Sign in to your account`) → zero hits.
3. `credentials error mapping preserved` — source/render assertion: the `CredentialsSignin` conditional still selects the translated `errorCredentials` key (and NOT the raw result.error).
4. `dictionaries carry auth.signIn in both locales` — parity walk: same key set in en/ar; leaf-count total updated consistently.
5. `aria labels translated` — assert show/hide aria-labels go through `t()`.

## Acceptance criteria

- [ ] The entire sign-in surface renders localized in en and ar (copy, aria labels, error messages).
- [ ] Error semantics unchanged (CredentialsSignin → generic invalid; other errors verbatim).
- [ ] Form behavior (ids, autoComplete, pending state) untouched.
- [ ] Dictionary parity exact; tranche suites still green.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt020-sign-in-gate-i18n.test.ts   # new suite green
bun test tests/audit/                                   # i18n tranches green
bun test tests/                                         # no regressions
node_modules/typescript/bin/tsc --noEmit                # exit 0
bun run lint                                            # 0 errors
```

## Rollout & rollback notes

Copy-only; revert-safe. Scope note (flagged during planning): this RT was not explicitly enumerated in the binding scope list — it is written because F-019 is a P2/S fixable finding left unassigned; the main agent can re-scope to BACKLOG by dropping the file and the plan row.
