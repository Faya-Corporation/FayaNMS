import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

export interface PageHeaderBreadcrumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: PageHeaderBreadcrumb[];
  /** Secondary actions (2–3 max per design spec). */
  actions?: React.ReactNode;
  /** The single primary action of the page (max 1 per design spec). */
  primaryAction?: React.ReactNode;
  className?: string;
}

/**
 * Page title block: breadcrumbs, title + description, and the action row.
 * Action hierarchy: at most one primary action, rendered last (right edge);
 * keep secondary actions to 2–3. Stacks vertically below md.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  primaryAction,
  className,
}: PageHeaderProps) {
  const lastCrumbIndex = (breadcrumbs?.length ?? 0) - 1;

  return (
    <header className={cn("flex flex-col gap-3", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === lastCrumbIndex;
              return (
                <Fragment key={`${crumb.label}-${index}`}>
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : crumb.href ? (
                      <BreadcrumbLink asChild>
                        <a href={crumb.href}>{crumb.label}</a>
                      </BreadcrumbLink>
                    ) : (
                      <span className="text-muted-foreground">{crumb.label}</span>
                    )}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator />}
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="max-w-3xl text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {(primaryAction || actions) && (
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">
            {actions}
            {primaryAction}
          </div>
        )}
      </div>
    </header>
  );
}
