import { cn } from "@/lib/utils";
import { FAYANMS_BRAND } from "@/lib/brand/identity";
import type { BrandTone } from "@/lib/brand/types";

const WORDMARK_SIZES = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
} as const;

const WORDMARK_TONES: Record<BrandTone, string> = {
  brand: "text-[#2563EB]",
  current: "",
  white: "text-white",
  mono: "text-foreground",
};

export interface FayaNMSWordmarkProps {
  size?: keyof typeof WORDMARK_SIZES;
  tone?: BrandTone;
  /** Render the product descriptor under/beside the name (context-dependent). */
  withDescriptor?: boolean;
  className?: string;
}

/**
 * FayaNMS wordmark as real TEXT (plan §8: in-app wordmark uses typography,
 * not lettering baked into SVG). Self-accessible — real text needs no
 * aria-hidden gymnastics.
 */
export function FayaNMSWordmark({
  size = "md",
  tone = "current",
  withDescriptor = false,
  className,
}: FayaNMSWordmarkProps) {
  return (
    <span className={cn("inline-flex min-w-0 flex-col leading-tight", className)}>
      <span
        className={cn(
          "truncate font-semibold tracking-tight",
          WORDMARK_SIZES[size],
          WORDMARK_TONES[tone]
        )}
      >
        {FAYANMS_BRAND.name}
      </span>
      {withDescriptor ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {FAYANMS_BRAND.descriptor}
        </span>
      ) : null}
    </span>
  );
}
