"use client";

import { useTranslations } from "next-intl";
import { format } from "date-fns";

import { StatusDot } from "@/components/domain/status-dot";

interface AppFooterProps {
  /** Timestamp (ms) of the last successful dashboard refresh. */
  lastRefreshAt: number | null;
}

/**
 * Sticky status footer: system status, product/version marker and the last
 * data refresh time. Sticks to the bottom of the viewport when content is
 * short (root flex column + mt-auto) and respects iOS safe-area insets.
 */
export function AppFooter({ lastRefreshAt }: AppFooterProps) {
  const tFooter = useTranslations("footer");

  return (
    <footer className="mt-auto border-t bg-surface-subtle pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-1 px-4 py-2.5 text-xs text-muted-foreground sm:flex-row md:px-6">
        <span className="inline-flex items-center gap-2" role="status">
          <StatusDot label={tFooter("systemOperational")} pulse token="success" />
          {tFooter("systemOperational")}
        </span>
        <span className="hidden md:block">
          {tFooter("version")}
        </span>
        <span className="tabular-nums">
          {tFooter("lastRefresh", {
            time: lastRefreshAt ? format(lastRefreshAt, "HH:mm:ss") : "—",
          })}
        </span>
      </div>
    </footer>
  );
}
