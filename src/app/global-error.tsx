"use client";

import { useEffect, useSyncExternalStore } from "react";

import { FayaNMSMark } from "@/components/brand";
import { Button } from "@/components/ui/button";

/**
 * GLOBAL error boundary (RT-004 / F-004, audit A4-01).
 *
 * Last-resort boundary: it replaces the ENTIRE root document (providers
 * included), so per the Next.js contract it must render its own
 * <html>/<body>. Because the root layout — which mounts LocaleProvider
 * (next-intl) and ThemeProvider — is not present in this tree,
 * `useTranslations` cannot resolve here; the copy is deliberately
 * bilingual-neutral (EN + AR) so an Arabic operator is never stranded.
 *
 * Direction: `dir` is adopted from `document.documentElement.dir` on the
 * post-hydration pass (SSR + first client render stay ltr/en, the repo's
 * hydration-safe `useSyncExternalStore` mounted-flag pattern) so an Arabic
 * session keeps RTL. Colors use design tokens (bg-background/
 * text-foreground) so the screen follows dark mode whenever the `.dark`
 * class is present on <html>.
 */

interface AppGlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const emptySubscribe = () => () => {};

export default function AppGlobalError({ error }: AppGlobalErrorProps) {
  // Hydration-safe "client is ready" flag (same pattern as app-shell):
  // server + first client render resolve to ltr/en, the mounted re-render
  // reads the live direction — no setState-in-effect needed.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const dir: "ltr" | "rtl" =
    mounted && document.documentElement.dir === "rtl" ? "rtl" : "ltr";

  useEffect(() => {
    // Trace log for support; the error object is never rendered.
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html dir={dir} lang={dir === "rtl" ? "ar" : "en"} suppressHydrationWarning>
      <body className="bg-background font-sans text-foreground antialiased">
        <main
          className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center"
          role="alert"
        >
          <span className="mb-1 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FayaNMSMark size="lg" tone="brand" />
          </span>
          {/* Bilingual-neutral copy — renders OUTSIDE LocaleProvider. */}
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="text-sm text-muted-foreground" dir="rtl" lang="ar">
            حدث خطأ ما
          </p>
          <Button
            className="mt-2"
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload
          </Button>
        </main>
      </body>
    </html>
  );
}
