import { cn } from "@/lib/utils";

interface SectionCardProps {
  title?: string;
  description?: string;
  /** Header actions (filters, links, small buttons). */
  actions?: React.ReactNode;
  /** Override the default density-aware content padding. */
  contentClassName?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Standard content card: 10px radius, subtle border, minimal elevation,
 * optional header row with actions. Content padding follows the active
 * density tier via --density-pad (p-card).
 */
export function SectionCard({
  title,
  description,
  actions,
  contentClassName,
  children,
  className,
}: SectionCardProps) {
  const hasHeader = Boolean(title || description || actions);

  return (
    <section
      className={cn("rounded-xl border bg-card shadow-e1", className)}
      data-slot="section-card"
    >
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-card", contentClassName)}>{children}</div>
    </section>
  );
}
