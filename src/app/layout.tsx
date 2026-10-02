import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { LocaleProvider } from "@/i18n/locale-provider";
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

export async function generateMetadata(): Promise<Metadata> {
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
      locale: "en_US",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* LocaleProvider (Task 8-a): SSR/hydration always render "en"/ltr;
              a persisted "ar" applies post-mount and flips <html dir>. */}
          <LocaleProvider>
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
