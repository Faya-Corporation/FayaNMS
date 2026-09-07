"use client";

import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Minus, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { StatusToken } from "@/lib/domain/status";
import { StatusDot } from "./status-dot";

export interface KpiTrend {
  /** Pre-formatted delta, e.g. "+2.4%", "-11 min". */
  value: string;
  direction: "up" | "down" | "flat";
  /**
   * Whether the movement is good. Omit for neutral coloring.
   * Lets "down" be positive (e.g. latency) or "up" negative (e.g. errors).
   */
  positive?: boolean;
}

export interface KpiCardStatus {
  label: string;
  token: StatusToken;
  /** Pulse the dot for live/running states. */
  pulse?: boolean;
}

interface KpiCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: KpiTrend;
  status?: KpiCardStatus;
  description?: string;
  loading?: boolean;
  className?: string;
}

const TREND_ICONS = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
} as const;

function trendTone(trend: KpiTrend): string {
  if (trend.direction === "flat") return "text-muted-foreground";
  if (trend.positive === true) return "text-success";
  if (trend.positive === false) return "text-danger";
  return "text-muted-foreground";
}

/**
 * Compact KPI tile for dashboard summaries: label, big value, optional icon,
 * trend chip with semantic coloring, live status dot and a short description.
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  trend,
  status,
  description,
  loading = false,
  className,
}: KpiCardProps) {
  const tCommon = useTranslations("common");
  const TrendIcon = trend ? TREND_ICONS[trend.direction] : null;
  const valueText = String(value);

  if (loading) {
    return (
      <div
        className={cn(
          "rounded-xl border bg-card p-4 shadow-e1",
          className
        )}
        aria-busy="true"
        aria-live="polite"
        data-slot="kpi-card"
      >
        <div className="flex items-start justify-between gap-3">
          <SkeletonLine className="h-3 w-20" />
          <SkeletonLine className="size-8 rounded-md" />
        </div>
        <SkeletonLine className="mt-3 h-7 w-24" />
        <SkeletonLine className="mt-2 h-3 w-28" />
      </div>
    );
  }

  return (
    <div
      className={cn("rounded-xl border bg-card p-4 shadow-e1", className)}
      data-slot="kpi-card"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground" title={label}>
          {label}
        </p>
        {Icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon aria-hidden="true" className="size-4" />
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="truncate text-2xl font-semibold tracking-tight tabular-nums"
          title={valueText}
        >
          {valueText}
        </span>
        {trend && TrendIcon && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-medium",
              trendTone(trend)
            )}
          >
            <TrendIcon aria-hidden="true" className="size-3" />
            <span className="tabular-nums">{trend.value}</span>
            <span className="sr-only">
              {trend.direction === "flat"
                ? tCommon("trend.noChange")
                : trend.positive === false
                  ? tCommon("trend.worse")
                  : trend.positive === true
                    ? tCommon("trend.better")
                    : trend.direction === "up"
                      ? tCommon("trend.up")
                      : tCommon("trend.down")}
            </span>
          </span>
        )}
        {status && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <StatusDot
              label={status.label}
              pulse={status.pulse}
              token={status.token}
            />
            {status.label}
          </span>
        )}
      </div>
      {description && (
        <p
          className="mt-1.5 line-clamp-2 text-xs text-muted-foreground"
          title={description}
        >
          {description}
        </p>
      )}
    </div>
  );
}

function SkeletonLine({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
