"use client";

import { useTranslations } from "next-intl";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  /** Human-readable reason, e.g. the error message. */
  reason?: string;
  /** Correlation/request ID to quote in support channels. */
  correlationId?: string;
  onRetry?: () => void;
  /** Localized retry label; defaults to the localized common.retry. */
  retryLabel?: string;
  /** Extra content (e.g. "Contact the network team" links). */
  extra?: React.ReactNode;
  className?: string;
}

/**
 * Error placeholder per spec §71: clear title, the reason, a correlation ID
 * for log tracing and a retry escape hatch. Never blame the user.
 *
 * RT-037/F-053: the component's own chrome (default title, correlation
 * prefix, retry label) resolves through next-intl; caller-provided
 * title/retryLabel keep precedence (prop ?? localized default). The
 * correlation id stays an LTR technical token inside its ltr-technical
 * span (rich-text tag, RT-020 pattern).
 */
export function ErrorState({
  title,
  reason,
  correlationId,
  onRetry,
  retryLabel,
  extra,
  className,
}: ErrorStateProps) {
  const t = useTranslations("common");
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border bg-surface-subtle px-6 py-12 text-center",
        className
      )}
      role="alert"
    >
      <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-danger-subtle text-danger">
        <TriangleAlert aria-hidden="true" className="size-5" />
      </span>
      <p className="text-sm font-medium text-foreground">{title ?? t("errors.genericTitle")}</p>
      {reason && (
        <p className="max-w-md rounded-md bg-danger-subtle px-3 py-1.5 text-sm text-danger">
          {reason}
        </p>
      )}
      {correlationId && (
        <p className="font-tech text-muted-foreground">
          {t.rich("errors.correlationId", {
            id: correlationId,
            tech: (chunks) => <span className="ltr-technical">{chunks}</span>,
          })}
        </p>
      )}
      {onRetry && (
        <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">
          <RotateCcw aria-hidden="true" />
          {retryLabel ?? t("retry")}
        </Button>
      )}
      {extra && <div className="mt-1 text-sm text-muted-foreground">{extra}</div>}
    </div>
  );
}
