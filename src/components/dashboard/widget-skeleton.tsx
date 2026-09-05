"use client";

import { cn } from "@/lib/utils";

/** Structure-matching skeleton used inside SectionCard while loading. */
export function WidgetSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn("flex flex-col gap-2.5", className)}
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-9 animate-pulse rounded-md bg-muted"
          style={{ opacity: 1 - index * 0.15 }}
        />
      ))}
      <span className="sr-only">Loading widget data…</span>
    </div>
  );
}
