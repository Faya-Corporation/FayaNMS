"use client";

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
  return (
    <footer className="mt-auto border-t bg-surface-subtle pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-1 px-4 py-2.5 text-xs text-muted-foreground sm:flex-row md:px-6">
        <span className="inline-flex items-center gap-2" role="status">
          <StatusDot label="All systems operational" pulse token="success" />
          All systems operational
        </span>
        <span className="hidden md:block">
          FayaNMS v0.1.0 — Phase 1 Foundation
        </span>
        <span className="tabular-nums">
          Last refresh{" "}
          <span className="font-tech ltr-technical">
            {lastRefreshAt ? format(lastRefreshAt, "HH:mm:ss") : "—"}
          </span>
        </span>
      </div>
    </footer>
  );
}
