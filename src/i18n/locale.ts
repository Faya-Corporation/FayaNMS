/**
 * Locale constants for FayaNMS i18n (Task 8-a).
 *
 * Client-side next-intl wiring: NO [locale] route segment, NO plugin, NO
 * server request config. The active locale lives in the preferences store
 * (persisted under "fayanms-prefs") and is applied to
 * `document.documentElement.lang/dir` after mount by the LocaleProvider —
 * the same hydration-safe pattern next-themes uses.
 *
 * Pure module (no React, no store imports) so it is safe to import from
 * server code, stores and client components alike.
 */

export const LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

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
