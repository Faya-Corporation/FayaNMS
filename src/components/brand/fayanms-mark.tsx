import { cn } from "@/lib/utils";
import type { BrandTone } from "@/lib/brand/types";

const MARK_SIZES = {
  xs: 14,
  sm: 20,
  md: 24,
  lg: 32,
} as const;

export type FayaNMSMarkSize = keyof typeof MARK_SIZES;

const MARK_TONES: Record<BrandTone, string> = {
  brand: "text-[#2563EB]",
  current: "",
  white: "text-white",
  mono: "text-foreground",
};

export interface FayaNMSMarkProps {
  size?: FayaNMSMarkSize;
  tone?: BrandTone;
  /**
   * When true (default) the mark is purely decorative and hidden from
   * assistive tech — pair it with visible "FayaNMS" text. Set false and pass
   * `title` only when the mark stands alone.
   */
  decorative?: boolean;
  /** Accessible name for a standalone, meaningful mark. */
  title?: string;
  className?: string;
}

/**
 * FayaNMS primary product mark — network nodes inside a protected
 * operations ring (Phase B0, BRAND-002/004).
 *
 * Inline SVG using `currentColor` so the mark adapts to app theming without
 * separate dark geometry. Never animated, never keyboard-focusable, never
 * recolored with status semantics.
 */
export function FayaNMSMark({
  size = "md",
  tone = "current",
  decorative = true,
  title,
  className,
}: FayaNMSMarkProps) {
  const px = MARK_SIZES[size];
  const accessible = !decorative && Boolean(title);

  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={accessible ? undefined : true}
      focusable="false"
      role={accessible ? "img" : undefined}
      className={cn("shrink-0", MARK_TONES[tone], className)}
    >
      {accessible ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="8" r="1.5" />
      <circle cx="8" cy="15" r="1.5" />
      <circle cx="16" cy="15" r="1.5" />
      <line x1="12" y1="9.5" x2="12" y2="12" />
      <line x1="12" y1="12" x2="8.8" y2="13.8" />
      <line x1="12" y1="12" x2="15.2" y2="13.8" />
    </svg>
  );
}
