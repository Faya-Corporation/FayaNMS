import { cn } from "@/lib/utils";
import { FAYANMS_BRAND } from "@/lib/brand/identity";

export interface FayaNMSProductBadgeProps {
  /** Product-context label; defaults to the brand edition ("Enterprise"). */
  context?: string;
  className?: string;
}

/**
 * Optional product-context badge (edition / NOC mode). Deliberately separate
 * from the core mark — the edition is never baked into the logo geometry.
 */
export function FayaNMSProductBadge({
  context,
  className,
}: FayaNMSProductBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border bg-surface-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
    >
      {context ?? FAYANMS_BRAND.edition}
    </span>
  );
}
