import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { LocaleProvider } from "@/i18n/locale-provider";

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
  title: "FayaNMS — Network Operations Management",
  description:
    "Enterprise network operations platform for multi-vendor device inventory, configuration backup and drift detection, controlled change management, and incident & performance monitoring.",
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
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
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
