"use client";

import { formatDistanceToNow } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  ShieldCheck,
  UserRound,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { useAlerts } from "@/hooks/api/use-alerts";
import {
  useAcknowledgeAlert,
  useAssignAlert,
  useCreateIncidentFromAlert,
  useResolveAlert,
  useSuppressAlert,
  useUnsuppressAlert,
} from "@/hooks/api/use-alert-mutations";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { StatusBadge } from "@/components/domain/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AlertStreamRow } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { ALERT_STATUS_UI, lookupStatusConfig } from "@/components/views/status-extras";

/** Severity → left stream edge class (literal classes, no dynamic tokens). */
const SEVERITY_EDGE: Record<string, string> = {
  CRITICAL: "border-l-danger",
  HIGH: "border-l-danger-orange",
  MEDIUM: "border-l-warning",
  LOW: "border-l-info",
  INFO: "border-l-neutral",
};

function relative(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export interface AlertStreamItemProps {
  alert: AlertStreamRow;
  onAssign: (alert: AlertStreamRow) => void;
  onSuppress: (alert: AlertStreamRow) => void;
}

/**
 * One alert-stream row (Task 5-a): severity edge, device + site, message,
 * rule/incident/count chips, child-group expander and the action dropdown.
 * Children (suppressed dependents of a device-down root) render grouped
 * under the root when expanded.
 */
export function AlertStreamItem({ alert, onAssign, onSuppress }: AlertStreamItemProps) {
  const [expanded, setExpanded] = useState(false);
  const ack = useAcknowledgeAlert();
  const unsuppress = useUnsuppressAlert();
  const resolve = useResolveAlert();
  const createIncident = useCreateIncidentFromAlert();
  const assign = useAssignAlert();
  const suppress = useSuppressAlert();

  const childCount = alert._count?.childAlerts ?? 0;
  const isOpen = alert.status !== "RESOLVED";

  return (
    <li className="border-b last:border-0">
      <div
        className={cn(
          "group flex flex-col gap-1.5 border-l-4 px-3 py-2.5 transition-colors hover:bg-accent/40 md:flex-row md:items-center md:gap-3 md:px-4",
          SEVERITY_EDGE[alert.severity] ?? "border-l-neutral"
        )}
      >
        {childCount > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${childCount} suppressed child alert${childCount === 1 ? "" : "s"}`}
            className="flex w-fit shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4" />
            )}
            <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-warning tabular-nums">
              {childCount} suppressed
            </span>
          </button>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <SeverityBadge value={alert.severity} />
            <button
              type="button"
              className="max-w-40 shrink-0 truncate text-sm font-semibold hover:text-primary"
              title={`Open ${alert.device.hostname}`}
              onClick={() =>
                useNavigationStore
                  .getState()
                  .setActiveView("network.device-detail", { deviceId: alert.device.id })
              }
            >
              {alert.device.hostname}
            </button>
            {alert.device.site && (
              <span className="shrink-0 text-xs text-muted-foreground" title={alert.device.site.name}>
                {alert.device.site.code}
              </span>
            )}
            <StatusBadge
              config={lookupStatusConfig(ALERT_STATUS_UI, alert.status)}
              withIcon={false}
            />
            {alert.rule && (
              <Badge variant="outline" className="max-w-44 shrink-0 gap-1 font-normal">
                <Wrench aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{alert.rule.name}</span>
              </Badge>
            )}
            {alert.count > 1 && (
              <span
                aria-label={`Fired ${alert.count} times`}
                className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums"
              >
                ×{alert.count}
              </span>
            )}
            {alert.incident && (
              <Badge
                variant="outline"
                className="shrink-0 border-danger/25 bg-danger-subtle font-normal text-danger"
              >
                <ExternalLink aria-hidden="true" className="me-1 size-3" />
                {alert.incident.number}
              </Badge>
            )}
            {alert.assignedTo && (
              <Badge variant="outline" className="shrink-0 gap-1 font-normal">
                <UserRound aria-hidden="true" className="size-3 shrink-0" />
                <span className="max-w-24 truncate">{alert.assignedTo.name}</span>
              </Badge>
            )}
          </div>
          <p className="min-w-0 truncate text-sm text-muted-foreground" title={alert.message}>
            {alert.message}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
            <span>first seen {relative(alert.firstSeen)}</span>
            <span aria-hidden="true">·</span>
            <span>last seen {relative(alert.lastSeen)}</span>
            {alert.suppressReason && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 text-neutral">
                  <ShieldCheck aria-hidden="true" className="size-3" />
                  {alert.suppressReason}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1">
          {alert.status === "ACTIVE" && (
            <Button
              size="sm"
              variant="outline"
              disabled={ack.isPending}
              onClick={() => ack.mutate(alert.id)}
            >
              Ack
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`Actions for alert on ${alert.device.hostname}`}
                size="icon"
                variant="ghost"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Alert actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={alert.status !== "ACTIVE" || ack.isPending}
                onSelect={() => ack.mutate(alert.id)}
              >
                Acknowledge
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!isOpen || assign.isPending}
                onSelect={() => onAssign(alert)}
              >
                Assign…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={(alert.status !== "ACTIVE" && alert.status !== "ACKNOWLEDGED") || suppress.isPending}
                onSelect={() => onSuppress(alert)}
              >
                Suppress…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={alert.status !== "SUPPRESSED" || unsuppress.isPending}
                onSelect={() => unsuppress.mutate(alert.id)}
              >
                Unsuppress
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {alert.incident ? (
                <DropdownMenuItem
                  onSelect={() =>
                    useNavigationStore.getState().setActiveView("ops.incidents")
                  }
                >
                  View incident
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={!isOpen || createIncident.isPending}
                  onSelect={() => createIncident.mutate(alert.id)}
                >
                  Create incident…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={!isOpen || resolve.isPending}
                onSelect={() => resolve.mutate(alert.id)}
                className="text-success focus:text-success"
              >
                Resolve
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {expanded && childCount > 0 && (
        <AlertChildren rootId={alert.id} rootHostname={alert.device.hostname} />
      )}
    </li>
  );
}

/**
 * Children of a root device-down alert: fetched on expand via
 * ?parentAlertId= and rendered indented under the root row.
 */
function AlertChildren({ rootId, rootHostname }: { rootId: string; rootHostname: string }) {
  const children = useAlerts({ parentAlertId: rootId, pageSize: 20 });
  const rows = children.data?.data ?? [];

  if (children.isLoading) {
    return (
      <div className="flex flex-col gap-2 bg-surface-subtle px-8 py-3">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="h-8 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-8 py-3 text-xs text-muted-foreground">
        No child alerts recorded for this root.
      </div>
    );
  }
  return (
    <ul className="border-t bg-surface-subtle" aria-label={`Suppressed child alerts of ${rootHostname}`}>
      {rows.map((child) => (
        <li
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-6 py-2 ps-10 last:border-0 md:px-10"
          key={child.id}
        >
          <SeverityBadge value={child.severity} />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={child.message}>
            {child.message}
          </span>
          <StatusBadge
            config={lookupStatusConfig(ALERT_STATUS_UI, child.status)}
            withIcon={false}
          />
        </li>
      ))}
    </ul>
  );
}
