"use client";

import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  /** Falls back to the translated common.emptyTitle when omitted. */
  title?: string;
  /** One or two sentences telling the user what they can do next. Falls
   *  back to the translated common.emptyDescription when omitted. */
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Empty content placeholder. Copy should be helpful, not apologetic:
 * state what is missing and offer the next step ("No devices yet — add your
 * first device to start collecting configs"). Callers pass their specific
 * copy; the defaults come from the `common` dictionary (Task 8-a).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: EmptyStateProps) {
  const tCommon = useTranslations("common");

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-surface-subtle px-6 py-12 text-center",
        className
      )}
    >
      {Icon && (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title ?? tCommon("emptyTitle")}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : title ? null : (
        <p className="max-w-sm text-sm text-muted-foreground">
          {tCommon("emptyDescription")}
        </p>
      )}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}
