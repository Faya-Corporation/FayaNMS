import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { FayaNMSMark } from "./fayanms-mark";
import { FayaNMSWordmark } from "./fayanms-wordmark";
import { FAYANMS_BRAND } from "@/lib/brand/identity";
import type { BrandTone } from "@/lib/brand/types";

export interface FayaNMSLockupProps {
  variant?: "compact" | "horizontal" | "stacked" | "tiled";
  showDescriptor?: boolean;
  showEdition?: boolean;
  markTone?: BrandTone;
  /**
   * Explicit override for the descriptor line — the SANCTIONED lockup API
   * for a localized subtitle (e.g. the translated `nav.brand.subtitle`).
   * Identity must never be re-composed outside this component (re-audit
   * B1-003); localized text goes HERE, not in hand-built mark + name rows.
   */
  descriptorOverride?: ReactNode;
  /**
   * Tiled-variant scale: "md" = sidebar / mobile drawer (32px tile, 20px
   * glyph, text-sm name), "lg" = sign-in (40px tile, 20px glyph, text-lg
   * name) — the documented container-vs-glyph minimums (re-audit B2-019).
   */
  tileSize?: "md" | "lg";
  className?: string;
}

/**
 * Canonical FayaNMS lockup (Phase B0, BRAND-002/003; re-audit B1-003).
 *
 * The ONLY way product identity is composed in app surfaces — no screen may
 * hand-assemble mark + name. Variants:
 *
 *  - compact    — brand tile with the white mark alone (collapsed sidebar);
 *  - tiled      — brand tile + wordmark + optional descriptor line
 *                 (desktop sidebar, mobile drawer, sign-in);
 *  - horizontal — inline mark + wordmark (headers, documents);
 *  - stacked    — centered mark + wordmark (report covers, onboarding).
 *
 * The mark is decorative whenever the wordmark text is present.
 */
export function FayaNMSLockup({
  variant = "horizontal",
  showDescriptor = false,
  showEdition = false,
  markTone = "current",
  descriptorOverride,
  tileSize = "md",
  className,
}: FayaNMSLockupProps) {
  if (variant === "compact") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground",
          className
        )}
      >
        <FayaNMSMark size="sm" tone="white" />
      </span>
    );
  }

  if (variant === "tiled") {
    const large = tileSize === "lg";
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center justify-center bg-primary text-primary-foreground",
            large ? "size-10 rounded-xl" : "size-8 rounded-md"
          )}
        >
          <FayaNMSMark size="sm" tone="white" />
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate font-semibold leading-tight tracking-tight",
              large ? "text-lg" : "text-sm"
            )}
          >
            {FAYANMS_BRAND.name}
          </span>
          {descriptorOverride != null || showDescriptor ? (
            <span
              className={cn(
                "block truncate text-muted-foreground",
                large ? "text-xs" : "text-[11px] leading-tight"
              )}
            >
              {descriptorOverride ?? FAYANMS_BRAND.descriptor}
            </span>
          ) : null}
          {showEdition ? (
            <span className="mt-0.5 inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {FAYANMS_BRAND.edition}
            </span>
          ) : null}
        </span>
      </span>
    );
  }

  if (variant === "stacked") {
    return (
      <span
        className={cn(
          "inline-flex flex-col items-center gap-2 text-center",
          className
        )}
      >
        <FayaNMSMark size="lg" tone={markTone} />
        <FayaNMSWordmark size="lg" tone={markTone} />
        {showDescriptor || descriptorOverride != null ? (
          <span className="text-xs text-muted-foreground">
            {descriptorOverride ?? FAYANMS_BRAND.descriptor}
          </span>
        ) : null}
        {showEdition ? (
          <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {FAYANMS_BRAND.edition}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <FayaNMSMark size="md" tone={markTone} />
      <FayaNMSWordmark
        size="md"
        tone={markTone}
        withDescriptor={showDescriptor || descriptorOverride != null}
        descriptorOverride={descriptorOverride}
      />
      {showEdition ? (
        <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {FAYANMS_BRAND.edition}
        </span>
      ) : null}
    </span>
  );
}
