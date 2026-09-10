import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { LocaleProvider } from "@/i18n/locale-provider";
import { FAYANMS_BRAND, siteUrl } from "@/lib/brand/identity";

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

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "FayaNMS — Network Operations Management",
    template: "%s · FayaNMS",
  },
  description: FAYANMS_BRAND.description,
  keywords: [
    "FayaNMS",
    "network management",
    "NMS",
    "NOC",
    "configuration backup",
    "change management",
    "incident management",
    "network monitoring",
  ],
  applicationName: FAYANMS_BRAND.name,
  creator: "FayaNMS",
  publisher: "FayaNMS",
  // Phase B0 (BRAND-001): the external Z-AI/ChatGLM favicon was removed.
  // Local file-based metadata (src/app/icon.svg, apple-icon, opengraph-image)
  // now supplies every browser/app icon — no third-party identity fetches.
  openGraph: {
    type: "website",
    siteName: FAYANMS_BRAND.name,
    title: "FayaNMS — Network Operations Management",
    description: FAYANMS_BRAND.description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "FayaNMS — Network Operations Management",
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

export const viewport: Viewport = {
  themeColor: "#2563EB",
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
