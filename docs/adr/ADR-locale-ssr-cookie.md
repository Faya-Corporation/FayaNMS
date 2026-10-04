# ADR — SSR Locale via the `fayanms-locale` Cookie (F-057 / A4-12)

**Status:** Accepted (batch 20, branch `GLM/open-findings-batch-20`)
**Context findings:** F-057 (P3) / A4-12 — "SSR always renders en/ltr (documented hydration tradeoff); OG locale always en_US"
**Companion code:** `src/i18n/locale.ts` (pure resolvers), `src/i18n/locale-provider.tsx` (flip + cookie write), `src/app/layout.tsx` (SSR read)

---

## 1. Context

Task 8-a shipped i18n (en/ar) client-side with NO `[locale]` route segment:
the locale lived only in the zustand preferences store (localStorage
`fayanms-prefs`), and the LocaleProvider applied it to
`document.documentElement` post-mount. The server never knew the locale, so:

- SSR rendered `<html lang="en" dir="ltr">` for everyone — an Arabic user's
  first paint was announced `lang="en"` (AT + RTL-correctness cost);
- `generateMetadata` hardcoded OG `locale: "en_US"` — share/SEO metadata
  never reflected (or alternated with) Arabic;
- the "SSR always en, client flips post-mount" behavior was a documented,
  deliberately accepted hydration tradeoff.

## 2. Decision

1. **Cookie mirror, client-written.** The LocaleProvider's flip effect — the
   single code path that already owned `documentElement.lang/dir` — now also
   writes `fayanms-locale=<locale>` (`document.cookie`, `path=/`,
   `max-age=31536000`, `SameSite=Lax`, no Secure flag so plain-HTTP lab
   deployments persist). It is written on EVERY resolved locale, mount
   included, so the mirror self-heals a deleted cookie. No server action,
   no middleware involvement — the cookie is a projection of the client's
   locale, not an independent preference.

2. **Root layout reads it server-side.** The layout (already
   `force-dynamic` per F-026, so cookie reads are legal) resolves
   `await cookies().get("fayanms-locale")?.value` through the pure
   `resolveLocaleFromCookie` — absent/invalid values fall back to `en`,
   and no cookie-controlled string other than `en|ar` can reach
   `<html lang>`. The resolution feeds the initial `<html lang dir>` AND
   the OG `locale`/`alternateLocale` (`en_US`/`ar_AR`, exactly the other
   language as the alternate).

3. **Hydration agreement via an RSC prop, not a second cookie parse.**
   The server-resolved locale is passed to `<LocaleProvider initialLocale>`.
   As a serialized RSC prop it is byte-identical in the server render and
   the client's hydration pass, so both render the same next-intl locale +
   messages and can never disagree — no `document.cookie` parsing during
   render, no `suppressHydrationWarning` reliance for locale content (the
   `<html>` attribute stays suppressed for the theme provider's class
   mutation).

4. **Client authority post-mount; idempotent flips.** The render-safe
   resolution is the pure `resolveRenderLocale(ssrLocale, stored, mounted)`:
   pre-mount the server locale wins; post-mount a valid persisted store
   value wins. The flip effect writes `documentElement.lang/dir` and the
   cookie from ONE source (the resolved locale), so en→ar→en lands
   byte-identically on the initial state (same attributes, same cookie
   value, same store value).

## 3. Priority between the two persistence layers

The preferences store (localStorage) remains the client-side authority;
the cookie is the server-readable mirror. They are written by the same
flip path and only diverge through external interference:

- localStorage cleared, cookie intact → SSR starts Arabic, the empty store
  resolves to `en` post-mount and rewrites the cookie (one visible flip,
  self-consistent thereafter — accepted edge, see §5).
- cookie cleared, localStorage intact → SSR starts English, the store
  re-asserts the persisted locale post-mount and rewrites the cookie
  (the pre-F-057 behavior, now self-healing for the next request).

## 4. Consequences

- First paint for Arabic users is `<html lang="ar" dir="rtl">` with Arabic
  content — the AT/SEO cost of the old tradeoff is gone for every visit
  after the first locale choice.
- OG metadata follows the resolved locale with the other language declared
  as `alternateLocale`.
- Shared caches must not strip the cookie: the locale is per-browser, and
  the layout is already force-dynamic (no HTML cache surface).
- CSP/cookie audits: one first-party, non-sensitive, `SameSite=Lax`
  preference cookie (`fayanms-locale`), value constrained to `en|ar`.

## 5. Honest limitations

- A FIRST visit from a browser whose localStorage predates F-057 with an
  `ar` preference but no cookie still gets one en→ar flip post-mount (the
  old behavior for that visit; the cookie is written, so every later visit
  starts correct).
- The cookie does not follow the preference across browsers/devices — it
  is per-browser by definition; signed-in users keep per-browser locales.
- Bots/crawlers without the cookie still see en_US metadata — the
  `alternateLocale` declaration is the SEO signal, not cloaking per-bot.
