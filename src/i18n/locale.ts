/**
 * Locale constants for FayaNMS i18n (Task 8-a).
 *
 * Client-side next-intl wiring: NO [locale] route segment, NO plugin, NO
 * server request config. The active locale lives in the preferences store
 * (persisted under "fayanms-prefs") and is applied to
 * `document.documentElement.lang/dir` by the LocaleProvider.
 *
 * F-057 (batch 20): the locale is ALSO mirrored into the `fayanms-locale`
 * cookie on every provider flip, so the root layout can resolve the same
 * locale server-side (await cookies()) and render the initial <html lang
 * dir> — and the OG locale/alternateLocale — WITHOUT the old "SSR always
 * renders en/ltr" hydration tradeoff. The provider's pre-mount render is
 * fed the server-resolved locale through an RSC prop, so SSR and the
 * hydration pass always agree (see ADR-locale-ssr-cookie).
 *
 * Pure module (no React, no store imports) so it is safe to import from
 * server code, stores and client components alike.
 */

export const LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * F-057: the cookie that makes the UI locale visible to SSR. Written by the
 * LocaleProvider (client-side, document.cookie) on every locale change —
 * NOT by a server action — so the next request's root layout can read it
 * with await cookies() and start the render from the user's language.
 */
export const LOCALE_COOKIE = "fayanms-locale";

/**
 * One year. The locale is a stable per-browser preference; the cookie is a
 * server-readable mirror of the preferences store, not a session value.
 */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The exact cookie string the LocaleProvider writes. Values are the locale
 * codes themselves (en|ar — cookie-safe, no encoding), path=/ so every
 * route sees it, SameSite=Lax (a preference mirror, never cross-site
 * state), and no Secure flag so plain-HTTP lab deployments still persist.
 */
export function localeCookieFor(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * F-057 pure SSR resolver: raw cookie value → render locale. Absent,
 * empty, or malformed values (scrubbed storage, tampering, old shapes)
 * fall back to the default en — the layout must never render an arbitrary
 * string into <html lang> from cookie input.
 */
export function resolveLocaleFromCookie(
  value: string | undefined | null
): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * The provider's render-safe resolution as a pure function (F-057 pin
 * surface): pre-mount (server render AND the hydration pass) the
 * server-resolved cookie locale wins — so both sides agree byte-for-byte;
 * post-mount a valid persisted store value wins (the user's in-browser
 * preference, same flip path that writes the cookie).
 */
export function resolveRenderLocale(
  ssrLocale: Locale,
  stored: unknown,
  mounted: boolean
): Locale {
  return mounted && isLocale(stored) ? stored : ssrLocale;
}

/**
 * OpenGraph locale tags use the language_TERRITORY convention (the OG
 * spec's default territory per language — ar_AR/en_US). Kept next to the
 * locale constants so the layout metadata and its pins share one source.
 */
export const OG_LOCALES: Record<Locale, string> = {
  en: "en_US",
  ar: "ar_AR",
};

/**
 * F-057: OG `locale` + `alternateLocale` (exactly the other locale) for the
 * resolved render locale, consumed by the root layout's generateMetadata.
 */
export function ogLocalesFor(locale: Locale): {
  locale: string;
  alternateLocale: string[];
} {
  const other: Locale = locale === "ar" ? "en" : "ar";
  return { locale: OG_LOCALES[locale], alternateLocale: [OG_LOCALES[other]] };
}

/** Native (in-language) display name for the language switcher. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

/** Reading direction for each locale. */
export type Direction = "ltr" | "rtl";

export function dirFor(locale: Locale): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}

export function isRtl(locale: Locale): boolean {
  return dirFor(locale) === "rtl";
}

/** Runtime guard for persisted values (old pref objects may miss `locale`). */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}
