"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Siren } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useIncidents } from "@/hooks/api/use-incidents";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { cn } from "@/lib/utils";
import { INCIDENT_SEVERITY, getStatusConfig } from "@/lib/domain/status";
import { INCIDENT_STATUS_UI, lookupStatusConfig } from "./status-extras";
import { IncidentSeverityBadge } from "./incident-severity-badge";

const SEVERITY_FILTERS = ["ALL", "SEV1", "SEV2", "SEV3", "SEV4"] as const;

/**
 * Incident list (Phase 1 slice): severity filter + lifecycle status over
 * /api/v1/incidents. Full lifecycle, SLA timers and PIR land in Phase 5.
 */
export function IncidentsView() {
  const { toast } = useToast();
  const [severity, setSeverity] = useState<(typeof SEVERITY_FILTERS)[number]>("ALL");

  const incidents = useIncidents({
    severity: severity === "ALL" ? undefined : severity,
    pageSize: 25,
  });

  const rows = incidents.data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Incident lifecycle with SLA timers"
        title="Incidents"
      />

      <div className="flex flex-wrap items-center gap-2">
        {SEVERITY_FILTERS.map((filter) => {
          const label =
            filter === "ALL"
              ? "All"
              : getStatusConfig(INCIDENT_SEVERITY, filter).label.split(" — ")[0];
          return (
            <button
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                severity === filter
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              key={filter}
              onClick={() => setSeverity(filter)}
              type="button"
            >
              {label}
            </button>
          );
        })}
      </div>

      <SectionCard contentClassName="p-0" title="All Incidents">
        {incidents.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void incidents.refetch()}
              reason={incidents.error.message}
              title="Incidents could not be loaded"
            />
          </div>
        ) : incidents.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No incidents match the current filter."
              icon={Siren}
              title="No incidents to show"
            />
          </div>
        ) : (
          <ul>
            {rows.map((incident) => (
              <li key={incident.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-start transition-colors last:border-0 hover:bg-accent/50"
                  onClick={() =>
                    toast({
                      title: "Incident detail arrives with Phase 5",
                      description: `${incident.number} — timeline, SLA and RCA export ship with the operations module.`,
                    })
                  }
                  type="button"
                >
                  <IncidentSeverityBadge className="shrink-0" value={incident.severity} />
                  <span className="font-tech shrink-0 text-muted-foreground ltr-technical">
                    {incident.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm" title={incident.title}>
                    {incident.title}
                  </span>
                  {incident.site && (
                    <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                      {incident.site.code}
                    </span>
                  )}
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {incident._count.devices} device{incident._count.devices === 1 ? "" : "s"}
                  </span>
                  <StatusBadge
                    className="hidden lg:inline-flex"
                    config={lookupStatusConfig(INCIDENT_STATUS_UI, incident.status)}
                    withIcon={false}
                  />
                  <span className="w-24 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                    {formatDistanceToNow(new Date(incident.createdAt), { addSuffix: true })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
