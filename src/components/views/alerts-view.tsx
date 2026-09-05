"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { BellRing, CircleCheck } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useAlerts } from "@/hooks/api/use-alerts";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SEVERITY } from "@/lib/domain/status";
import { cn } from "@/lib/utils";
import { ALERT_STATUS_UI, lookupStatusConfig } from "./status-extras";

const STATUS_FILTERS = ["ALL", "ACTIVE", "ACKNOWLEDGED", "SUPPRESSED", "RESOLVED"] as const;

const SEVERITY_FILTERS = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

/**
 * Live alert stream (Phase 1 slice): status chips + severity filter over
 * /api/v1/alerts. Acknowledge/suppress flows land with the alerting
 * engine in Phase 5.
 */
export function AlertsView() {
  const { toast } = useToast();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [severity, setSeverity] = useState<(typeof SEVERITY_FILTERS)[number]>("ALL");

  const alerts = useAlerts(
    {
      status: status === "ALL" ? undefined : status,
      severity: severity === "ALL" ? undefined : severity,
      pageSize: 25,
    },
    { refetchInterval: 10_000 }
  );

  const rows = alerts.data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Live alert stream, newest activity first"
        title="Alerts"
      />

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((filter) => {
          const label =
            filter === "ALL"
              ? "All"
              : lookupStatusConfig(ALERT_STATUS_UI, filter).label;
          return (
            <button
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                status === filter
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              key={filter}
              onClick={() => setStatus(filter)}
              type="button"
            >
              {label}
            </button>
          );
        })}
        <Select
          onValueChange={(value) => setSeverity(value as (typeof SEVERITY_FILTERS)[number])}
          value={severity}
        >
          <SelectTrigger aria-label="Filter by severity" className="ms-auto h-8 w-36 text-xs">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            {SEVERITY_FILTERS.map((filter) => (
              <SelectItem key={filter} value={filter}>
                {filter === "ALL"
                  ? "All severities"
                  : `${filter.charAt(0)}${filter.slice(1).toLowerCase()}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SectionCard
        contentClassName="p-0"
        description="Auto-refreshes every 10 seconds"
        title="Alert Stream"
      >
        {alerts.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void alerts.refetch()}
              reason={alerts.error.message}
              title="Alerts could not be loaded"
            />
          </div>
        ) : alerts.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Nothing matches the current filters — the network is quiet."
              icon={CircleCheck}
              title="No alerts to show"
            />
          </div>
        ) : (
          <ul>
            {rows.map((alert) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 transition-colors last:border-0 hover:bg-accent/50"
                key={alert.id}
              >
                <SeverityBadge className="shrink-0" value={alert.severity} />
                <span className="w-36 shrink-0 truncate text-sm font-medium" title={alert.device.hostname}>
                  {alert.device.hostname}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                  title={alert.message}
                >
                  {alert.message}
                </span>
                {alert.count > 1 && (
                  <span
                    aria-label={`Fired ${alert.count} times`}
                    className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums"
                  >
                    ×{alert.count}
                  </span>
                )}
                <span className="w-24 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                  {formatDistanceToNow(new Date(alert.lastSeen), { addSuffix: true })}
                </span>
                <StatusBadge
                  className="hidden md:inline-flex"
                  config={lookupStatusConfig(ALERT_STATUS_UI, alert.status)}
                  withIcon={false}
                />
                <Button
                  aria-label={`Acknowledge alert on ${alert.device.hostname}`}
                  disabled={alert.status !== "ACTIVE"}
                  onClick={() =>
                    toast({
                      title: "Alert actions arrive with Phase 5",
                      description: "Acknowledge, assign and suppress ship with the alerting engine.",
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  <BellRing aria-hidden="true" />
                  Ack
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
