"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";

import { usePreferencesStore } from "@/stores/preferences";
import {
  DEFAULT_LOCALE,
  dirFor,
  isLocale,
  localeCookieFor,
  resolveRenderLocale,
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
 * F-057: the server-resolved locale travels to every consumer of
 * useCurrentLocale(). LocaleProvider seeds it from the root layout's
 * cookie read (an RSC prop — serialized into the flight payload, so the
 * hydration pass sees EXACTLY the value the server rendered with);
 * consumers outside the provider fall back to the default (the old
 * always-en behavior, which global-error's own documentElement read
 * already covers).
 */
const SSR_LOCALE_CONTEXT = createContext<Locale>(DEFAULT_LOCALE);

/**
 * The locale that is safe to RENDER right now.
 *
 * HYDRATION SAFETY (F-057): pre-mount — the server render AND the first
 * client render — resolveRenderLocale returns the server's cookie-derived
 * locale, so SSR markup and the hydration pass can never disagree. The
 * provider's <html lang dir> is rendered server-side from the SAME
 * resolution (root layout reads the same cookie), and next-intl children
 * render with the same messages on both sides.
 *
 * Post-mount, a stored preference re-renders the tree (zustand persist,
 * synced before first paint) and the effect below flips `documentElement`
 * AND rewrites the cookie — the only transition that can differ from SSR,
 * and only when the two persistence layers were externally diverged
 * (e.g. cookies cleared but localStorage kept). Identical to how
 * next-themes defers `theme`.
 */
export function useCurrentLocale(): Locale {
  const ssrLocale = useContext(SSR_LOCALE_CONTEXT);
  const mounted = useMounted();
  const stored = usePreferencesStore((state) => state.locale);
  return resolveRenderLocale(ssrLocale, stored, mounted);
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
 *
 * F-057: `initialLocale` is the root layout's server-side cookie
 * resolution (resolveLocaleFromCookie over `fayanms-locale`) — the SSR
 * render starts from the user's language instead of the old always-en
 * tradeoff, and the same value seeds SSR_LOCALE_CONTEXT so the hydration
 * pass agrees. The flip effect is IDEMPOTENT: it writes documentElement
 * lang/dir AND the mirror cookie from ONE source (the resolved locale),
 * so en→ar→en lands byte-identically on the initial state (same html
 * attributes, same cookie value, same store value).
 */
export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  /** Raw `fayanms-locale` cookie value resolved server-side (validated here). */
  initialLocale?: string;
}) {
  const ssrLocale = isLocale(initialLocale) ? initialLocale : DEFAULT_LOCALE;
  const mounted = useMounted();
  const stored = usePreferencesStore((state) => state.locale);
  const locale = resolveRenderLocale(ssrLocale, stored, mounted);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirFor(locale);
    // The SSR mirror (F-057): written on EVERY resolved locale — mount
    // included — so the next request's root layout starts from it.
    document.cookie = localeCookieFor(locale);
  }, [locale]);

  return (
    <SSR_LOCALE_CONTEXT.Provider value={ssrLocale}>
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
    </SSR_LOCALE_CONTEXT.Provider>
  );
}
