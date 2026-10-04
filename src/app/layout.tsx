import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { LocaleProvider } from "@/i18n/locale-provider";
import {
  LOCALE_COOKIE,
  dirFor,
  ogLocalesFor,
  resolveLocaleFromCookie,
  type Locale,
} from "@/i18n/locale";
import {
  BRAND_TITLE,
  BRAND_TITLE_TEMPLATE,
  BRAND_THEME_COLOR,
  FAYANMS_BRAND,
} from "@/lib/brand/identity";
import { siteUrl } from "@/lib/brand/site-url";

const fontSans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const fontMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

// F-026 (batch 9): the origin is a RUNTIME value (`SITE_URL`, resolved per
// request by siteUrl() from src/lib/brand/site-url.ts) — the static metadata
// export would have baked a build-time value into prerendered pages (and the
// NEXT_PUBLIC_ prefix froze the build placeholder into the client bundles of
// the published images). force-dynamic makes the root layout — and therefore
// every page's metadata — request-evaluated: host-side origin values take
// effect WITHOUT a rebuild. An authenticated ops dashboard has no meaningful
// static-shell optimization to lose; the tradeoff is deliberate and recorded
// in the F-026 register row.
export const dynamic = "force-dynamic";

/**
 * F-057: the request's render locale. The `fayanms-locale` cookie is the
 * SSR mirror the LocaleProvider writes on every client flip; absent or
 * invalid values resolve to the default en (never an arbitrary string in
 * <html lang>). Legal here because the root layout is force-dynamic
 * (F-026) — every evaluation is request-scoped.
 */
async function requestLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  return resolveLocaleFromCookie(cookieStore.get(LOCALE_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const ogLocales = ogLocalesFor(locale);
  return {
    metadataBase: new URL(siteUrl()),
    title: {
      default: BRAND_TITLE,
      template: BRAND_TITLE_TEMPLATE,
    },
    description: FAYANMS_BRAND.description,
    keywords: [
      FAYANMS_BRAND.name,
      "network management",
      "NMS",
      "NOC",
      "configuration backup",
      "change management",
      "incident management",
      "network monitoring",
    ],
    applicationName: FAYANMS_BRAND.name,
    creator: FAYANMS_BRAND.name,
    publisher: FAYANMS_BRAND.name,
    // Phase B0 (BRAND-001): the external Z-AI/ChatGLM favicon was removed.
    // Local file-based metadata (src/app/icon.svg, apple-icon, opengraph-image)
    // now supplies every browser/app icon — no third-party identity fetches.
    openGraph: {
      type: "website",
      siteName: FAYANMS_BRAND.name,
      title: BRAND_TITLE,
      description: FAYANMS_BRAND.description,
      // F-057: the OG locale follows the RESOLVED request locale, with the
      // other language declared as the alternate — share/SEO metadata is no
      // longer hardcoded en_US for Arabic sessions.
      locale: ogLocales.locale,
      alternateLocale: ogLocales.alternateLocale,
    },
    twitter: {
      card: "summary_large_image",
      title: BRAND_TITLE,
      description: FAYANMS_BRAND.description,
    },
    robots: {
      index: true,
      follow: true,
    },
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: FAYANMS_BRAND.shortName,
      statusBarStyle: "black-translucent",
    },
  };
}

export const viewport: Viewport = {
  themeColor: BRAND_THEME_COLOR,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await requestLocale();
  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      suppressHydrationWarning
    >
      <body
        className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* LocaleProvider (Task 8-a + F-057): the server-resolved cookie
              locale seeds BOTH the SSR render and the hydration pass (RSC
              prop → byte-identical markup); the client's persisted flip
              stays authoritative post-mount and rewrites the mirror cookie
              on every resolved locale. */}
          <LocaleProvider initialLocale={locale}>
            {/* MotionProvider (Task 8-b): framer-motion honors the OS
                reduced-motion preference (WCAG 2.3.3). */}
            <MotionProvider>
              <AuthSessionProvider>
                <QueryProvider>
                  {children}
                  <Toaster />
                </QueryProvider>
              </AuthSessionProvider>
            </MotionProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
