/**
 * Open-findings batch 20 — F-057 (P3, BACKLOG order):
 * SSR always rendered en/ltr and OG locale was hardcoded en_US.
 *
 *   History: Task 8-a shipped i18n client-side (no [locale] segment): the
 *   locale lived ONLY in the zustand preferences store, the LocaleProvider
 *   flipped documentElement post-mount, and the server never knew the
 *   locale — so SSR announced lang="en" to Arabic users' first paint and
 *   share/SEO metadata was permanently en_US (the documented hydration
 *   tradeoff, finding A4-12/F-057).
 *
 *   The closure (the BACKLOG plan's named mechanism): a `fayanms-locale`
 *   cookie MIRRORS the client locale — written by the SAME flip effect that
 *   already owned documentElement (document.cookie, path=/, one-year
 *   max-age, SameSite=Lax; every resolved locale, mount included, so the
 *   mirror self-heals). The root layout (force-dynamic since F-026, so
 *   cookie reads are legal) resolves the cookie through the pure
 *   resolveLocaleFromCookie (absent/invalid → en fallback) and renders the
 *   initial <html lang dir> plus OG locale/alternateLocale (en_US/ar_AR)
 *   from it. The resolved locale reaches the provider as an RSC prop, so
 *   the SSR render and the hydration pass derive the SAME locale from the
 *   SAME input — no document.cookie parsing during render, no mismatch.
 *
 *   Rig notes: like batch 14 this closure is a pure-unit suite — no DB, no
 *   sessions. The render-safe resolution (resolveRenderLocale) and the
 *   cookie/OG mappers are extracted into src/i18n/locale.ts (the module
 *   that is already the server-safe shared locale surface) so the flip
 *   matrix is unit-testable; the provider/layout wiring is pinned by
 *   source (one cookie writer, one resolver call site, async cookies()).
 *   The en→ar→en idempotency pin walks the resolution state machine —
 *   initial → flipped → back — and asserts the EXACT initial state
 *   (locale, direction, cookie string).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  dirFor,
  isLocale,
  localeCookieFor,
  ogLocalesFor,
  resolveLocaleFromCookie,
  resolveRenderLocale,
} from "../../src/i18n/locale";

const layoutSource = readFileSync("src/app/layout.tsx", "utf8");
const providerSource = readFileSync("src/i18n/locale-provider.tsx", "utf8");
const localeSource = readFileSync("src/i18n/locale.ts", "utf8");
const switcherSource = readFileSync("src/components/shell/app-header.tsx", "utf8");
const adrSource = readFileSync("docs/adr/ADR-locale-ssr-cookie.md", "utf8");

/* ── resolveLocaleFromCookie: the SSR resolver matrix ────────────────────── */

describe("resolveLocaleFromCookie (F-057 SSR resolver)", () => {
  test("the contract cookie name is fayanms-locale with locale-code values", () => {
    expect(LOCALE_COOKIE).toBe("fayanms-locale");
    expect(LOCALES).toEqual(["en", "ar"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  test("valid values resolve to themselves (en/ar)", () => {
    expect(resolveLocaleFromCookie("en")).toBe("en");
    expect(resolveLocaleFromCookie("ar")).toBe("ar");
  });

  test("absent/invalid values fall back to en (never an arbitrary <html lang>)", () => {
    for (const bad of [undefined, null, "", "   ", "EN", "en-US", "ar-SA", "fr", "ar;", "faya"]) {
      expect(resolveLocaleFromCookie(bad)).toBe("en");
    }
  });

  test("the fallback direction is ltr (the pre-F-057 default posture)", () => {
    expect(dirFor(resolveLocaleFromCookie(undefined))).toBe("ltr");
    expect(dirFor(resolveLocaleFromCookie("ar"))).toBe("rtl");
  });

  test("isLocale stays the single validation gate (exact-match, case-sensitive)", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale("Ar")).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

/* ── localeCookieFor: the mirror cookie the provider writes ──────────────── */

describe("localeCookieFor (F-057 cookie mirror)", () => {
  test("carries the contract name, a bare locale value, path=/, max-age, SameSite=Lax", () => {
    for (const locale of LOCALES) {
      const cookie = localeCookieFor(locale);
      expect(cookie).toContain(`${LOCALE_COOKIE}=${locale};`);
      expect(cookie).toContain("path=/");
      expect(cookie).toContain(`max-age=${LOCALE_COOKIE_MAX_AGE}`);
      expect(cookie).toContain("SameSite=Lax");
    }
    expect(LOCALE_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });

  test("flip en→ar→en rewrites the IDENTICAL cookie string (idempotent mirror)", () => {
    const initial = localeCookieFor("en");
    const flipped = localeCookieFor("ar");
    const back = localeCookieFor("en");
    expect(back).toBe(initial);
    expect(flipped).not.toBe(initial);
  });
});

/* ── ogLocalesFor: OG locale + alternateLocale mapping ───────────────────── */

describe("ogLocalesFor (F-057 OG mapping)", () => {
  test("en renders en_US with ar_AR as the single alternate", () => {
    expect(ogLocalesFor("en")).toEqual({
      locale: "en_US",
      alternateLocale: ["ar_AR"],
    });
  });

  test("ar renders ar_AR with en_US as the single alternate", () => {
    expect(ogLocalesFor("ar")).toEqual({
      locale: "ar_AR",
      alternateLocale: ["en_US"],
    });
  });

  test("the mapping is symmetric and total over the locale union", () => {
    for (const locale of LOCALES) {
      const og = ogLocalesFor(locale);
      expect(og.alternateLocale).toHaveLength(1);
      // Exactly the OTHER locale's tag — never itself, never en_US-for-ar.
      const other = ogLocalesFor(locale === "ar" ? "en" : "ar");
      expect(og.alternateLocale[0]).toBe(other.locale);
      expect(og.locale).not.toBe(og.alternateLocale[0]);
    }
  });
});

/* ── resolveRenderLocale: the provider's resolution + flip idempotency ───── */

describe("resolveRenderLocale (F-057 provider resolution)", () => {
  test("pre-mount (server render AND hydration pass) the server-resolved locale wins", () => {
    // Even with a persisted preference present, the unmounted render —
    // the one that must match SSR — returns the server locale.
    expect(resolveRenderLocale("en", "ar", false)).toBe("en");
    expect(resolveRenderLocale("ar", "en", false)).toBe("ar");
    expect(resolveRenderLocale("ar", undefined, false)).toBe("ar");
  });

  test("post-mount a valid persisted store value wins (the client flip path)", () => {
    expect(resolveRenderLocale("en", "ar", true)).toBe("ar");
    expect(resolveRenderLocale("ar", "en", true)).toBe("en");
  });

  test("an invalid store value never leaks post-mount (isLocale guard holds)", () => {
    expect(resolveRenderLocale("ar", "EN", true)).toBe("ar");
    expect(resolveRenderLocale("ar", 42, true)).toBe("ar");
    expect(resolveRenderLocale("en", null, true)).toBe("en");
  });

  test("flip en→ar→en returns the EXACT initial state (locale, dir, cookie)", () => {
    // Initial: first visit, no persisted preference — SSR en/ltr.
    const initial = resolveRenderLocale(DEFAULT_LOCALE, undefined, false);
    const initialState = {
      locale: initial,
      dir: dirFor(initial),
      cookie: localeCookieFor(initial),
    };

    // Flip to ar: store persisted + mounted → ar/rtl + its cookie.
    const arabic = resolveRenderLocale(initial, "ar", true);
    expect(arabic).toBe("ar");
    expect(dirFor(arabic)).toBe("rtl");
    expect(localeCookieFor(arabic)).toContain("fayanms-locale=ar");

    // Flip back: store en again → byte-identical initial state.
    const back = resolveRenderLocale(initial, "en", true);
    expect(back).toBe(initialState.locale);
    expect(dirFor(back)).toBe(initialState.dir);
    expect(localeCookieFor(back)).toBe(initialState.cookie);

    // The same round-trip from an ar-cookie session flips ar→en→ar.
    const arInitial = resolveRenderLocale("ar", undefined, false);
    expect(resolveRenderLocale(arInitial, "en", true)).toBe("en");
    const arBack = resolveRenderLocale(arInitial, "ar", true);
    expect(arBack).toBe("ar");
    expect(localeCookieFor(arBack)).toBe(localeCookieFor(arInitial));
  });
});

/* ── SSR/client agreement: one resolution, both sides ─────────────────────── */

describe("SSR/client agreement (layout resolver ↔ provider resolution)", () => {
  test("the provider's pre-mount render returns the layout's resolution for the SAME raw input", () => {
    for (const raw of ["en", "ar", "EN", "fr", "", "ar-SA", undefined, null]) {
      const serverResolved = resolveLocaleFromCookie(raw);
      // The provider validates the RSC prop with the SAME isLocale gate…
      const providerProp = isLocale(raw) ? raw : DEFAULT_LOCALE;
      // …so the hydration pass (mounted=false) resolves identically — even
      // when the persisted store disagrees with the cookie.
      const hydrated = resolveRenderLocale(providerProp, "ar", false);
      expect(hydrated).toBe(serverResolved);
      expect(dirFor(hydrated)).toBe(dirFor(serverResolved));
    }
  });
});

/* ── wiring pins: layout reads, provider writes, one writer ──────────────── */

describe("F-057 wiring (layout ↔ provider ↔ switcher)", () => {
  test("the root layout resolves the locale from an awaited cookies() read", () => {
    expect(layoutSource).toContain('import { cookies } from "next/headers"');
    expect(layoutSource).toContain("await cookies()");
    expect(layoutSource).toContain("cookieStore.get(LOCALE_COOKIE)?.value");
    expect(layoutSource).toContain("resolveLocaleFromCookie");
    // The SAME resolution feeds both the html element and the provider.
    expect(layoutSource).toContain("lang={locale}");
    expect(layoutSource).toContain("dir={dirFor(locale)}");
    expect(layoutSource).toContain("<LocaleProvider initialLocale={locale}>");
  });

  test("the old hardcoded en/ltr SSR posture is gone from the layout", () => {
    expect(layoutSource).not.toContain('locale: "en_US"');
    expect(layoutSource).not.toContain('<html lang="en"');
    expect(layoutSource).not.toContain('dir="ltr"');
  });

  test("OG metadata carries the resolved locale + alternateLocale", () => {
    expect(layoutSource).toContain("ogLocalesFor(locale)");
    expect(layoutSource).toContain("locale: ogLocales.locale");
    expect(layoutSource).toContain("alternateLocale: ogLocales.alternateLocale");
  });

  test("the provider writes the mirror cookie in the SAME effect that flips documentElement", () => {
    // One effect, one source of truth: the effect body must flip lang, dir,
    // AND the cookie together and depend on the resolved locale alone.
    const effectBody = providerSource.slice(
      providerSource.indexOf("useEffect(() => {"),
      providerSource.indexOf("}, [locale]);")
    );
    expect(effectBody).toContain("root.lang = locale");
    expect(effectBody).toContain("root.dir = dirFor(locale)");
    expect(effectBody).toContain("document.cookie = localeCookieFor(locale)");
    expect(providerSource).toContain("initialLocale");
    expect(providerSource).toContain("SSR_LOCALE_CONTEXT.Provider");
  });

  test("the language switcher stays store-only — the provider effect is the SINGLE cookie writer", () => {
    expect(switcherSource).toContain("setLocale");
    expect(switcherSource).not.toContain("document.cookie");
    expect(providerSource).toContain("document.cookie");
  });

  test("the pure resolvers live in the server-safe shared module, not the component", () => {
    expect(localeSource).toContain("export function resolveLocaleFromCookie");
    expect(localeSource).toContain("export function resolveRenderLocale");
    expect(localeSource).toContain("export function localeCookieFor");
    expect(localeSource).toContain("export function ogLocalesFor");
  });
});

/* ── documentation pin: the ADR records the mechanism + the honest edges ──── */

describe("F-057 documentation (ADR-locale-ssr-cookie)", () => {
  test("the ADR names the cookie contract and the priority rule", () => {
    expect(adrSource).toContain("fayanms-locale");
    expect(adrSource).toContain("SameSite=Lax");
    expect(adrSource).toContain("resolveLocaleFromCookie");
    expect(adrSource).toContain("resolveRenderLocale");
    expect(adrSource).toContain("F-057");
  });

  test("the ADR documents the idempotency requirement and the divergence edges", () => {
    expect(adrSource).toContain("byte-identically");
    expect(adrSource).toContain("localStorage cleared");
    expect(adrSource).toContain("Honest limitations");
  });
});
