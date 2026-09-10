import { cn } from "@/lib/utils";
import { FayaNMSMark } from "./fayanms-mark";
import { FayaNMSWordmark } from "./fayanms-wordmark";
import { FAYANMS_BRAND } from "@/lib/brand/identity";
import type { BrandTone } from "@/lib/brand/types";

export interface FayaNMSLockupProps {
  variant?: "compact" | "horizontal" | "stacked";
  showDescriptor?: boolean;
  showEdition?: boolean;
  markTone?: BrandTone;
  className?: string;
}

/**
 * Canonical FayaNMS lockup (Phase B0, BRAND-002/003).
 *
 * The ONLY way product identity is composed in app surfaces — no screen may
 * hand-assemble mark + name. Compact = mark alone; horizontal = sidebar and
 * headers; stacked = sign-in, report covers, onboarding.
 *
 * The mark is decorative whenever the wordmark text is present.
 */
export function FayaNMSLockup({
  variant = "horizontal",
  showDescriptor = false,
  showEdition = false,
  markTone = "current",
  className,
}: FayaNMSLockupProps) {
  if (variant === "compact") {
    return (
      <FayaNMSMark
        size="md"
        tone={markTone}
        title={FAYANMS_BRAND.name}
        decorative={false}
        className={className}
      />
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
        {showDescriptor ? (
          <span className="text-xs text-muted-foreground">
            {FAYANMS_BRAND.descriptor}
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
        withDescriptor={showDescriptor}
      />
      {showEdition ? (
        <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {FAYANMS_BRAND.edition}
        </span>
      ) : null}
    </span>
  );
}
