"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";

import { usePreferencesStore } from "@/stores/preferences";
import {
  DEFAULT_LOCALE,
  dirFor,
  isLocale,
  type Direction,
  type Locale,
} from "./locale";

import enMessages from "../../messages/en.json";
import arMessages from "../../messages/ar.json";

/** Both dictionaries ship in the client bundle (~small JSON files). */
const MESSAGES: Record<Locale, AbstractIntlMessages> = {
  en: enMessages as AbstractIntlMessages,
  ar: arMessages as AbstractIntlMessages,
};

const emptySubscribe = () => () => {};
/** Hydration-safe "client is ready" flag (same pattern as app-shell). */
const useMounted = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/**
 * The locale that is safe to RENDER right now.
 *
 * HYDRATION SAFETY: the server and the first client render always resolve
 * to "en" (the default). A persisted locale is only honored once the client
 * is mounted — identical to how next-themes defers `theme` — so SSR markup
 * and the hydration pass can never disagree. Post-mount, a stored "ar"
 * re-renders the tree and the effect below flips `documentElement`.
 */
export function useCurrentLocale(): Locale {
  const mounted = useMounted();
  const stored = usePreferencesStore((state) => state.locale);
  return mounted && isLocale(stored) ? stored : DEFAULT_LOCALE;
}

/** Reading direction helpers derived from the render-safe locale. */
export function useLocaleInfo(): {
  locale: Locale;
  dir: Direction;
  isRtl: boolean;
} {
  const locale = useCurrentLocale();
  return { locale, dir: dirFor(locale), isRtl: locale === "ar" };
}

/**
 * Mounts next-intl for the single-route app shell and mirrors the active
 * locale onto <html lang dir> whenever it changes. Kept at the root of the
 * provider tree (inside ThemeProvider) so every view — including the
 * sign-in gate — can call useTranslations().
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useCurrentLocale();

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirFor(locale);
  }, [locale]);

  return (
    <NextIntlClientProvider
      // Deterministic zone: the app never formats dates through next-intl
      // (date-fns does), but pinning avoids the ENVIRONMENT_FALLBACK
      // hydration-mismatch warning on the server (Task 8-a).
      timeZone="UTC"
      locale={locale}
      messages={MESSAGES[locale]}
    >
      {children}
    </NextIntlClientProvider>
  );
}
