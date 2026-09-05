"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  ClipboardCheck,
  DatabaseBackup,
  FileDiff,
  Router,
  Siren,
  TriangleAlert,
  Wifi,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useDashboard } from "@/hooks/api/use-dashboard";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { DriftStatusBadge } from "@/components/domain/drift-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  TimeRangeSelect,
  type TimeRangeValue,
} from "@/components/domain/time-range-select";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { CapacityRisk, DashboardChange, DashboardIncident } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { HealthDistributionCard } from "@/components/dashboard/health-distribution-card";
import { UtilizationCard } from "@/components/dashboard/utilization-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { IncidentSeverityBadge } from "@/components/views/incident-severity-badge";
import {
  CHANGE_STATUS_UI,
  INCIDENT_STATUS_UI,
  lookupStatusConfig,
} from "@/components/views/status-extras";

function relative(iso: string | null): string {
  if (!iso) return "—";
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/** Gate G1 showpiece: fleet KPIs, trends, risks and activity. */
export function DashboardView() {
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const dashboard = useDashboard(range);
  const data = dashboard.data;
  const kpis = data?.kpis;

  const onRangeChange = (value: TimeRangeValue) => {
    // The API normalizes anything beyond a day to 7d rollups (or clamps
    // back to the available 24h of hourly rollups).
    setRange(value === "7d" || value === "30d" ? "7d" : "24h");
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={
          <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
            Updated{" "}
            {dashboard.dataUpdatedAt
              ? format(dashboard.dataUpdatedAt, "HH:mm:ss")
              : "—"}
          </span>
        }
        description="Network operations overview"
        primaryAction={
          <TimeRangeSelect
            onChange={onRangeChange}
            value={range}
          />
        }
        title="Dashboard"
      />

      {dashboard.isError ? (
        <ErrorState
          onRetry={() => void dashboard.refetch()}
          reason={dashboard.error.message}
          title="The dashboard could not be loaded"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              description="Excludes unmanaged devices"
              icon={Router}
              label="Managed Devices"
              loading={!data}
              value={kpis?.managedDevices ?? "—"}
            />
            <KpiCard
              description="Responding to polls"
              icon={Wifi}
              label="Online"
              loading={!data}
              status={
                kpis
                  ? { label: "live", pulse: true, token: "success" }
                  : undefined
              }
              value={kpis?.online ?? "—"}
            />
            <KpiCard
              className={cn(kpis && kpis.criticalAlerts > 0 && "border-danger/40")}
              description="ACTIVE severity CRITICAL"
              icon={Siren}
              label="Critical Alerts"
              loading={!data}
              status={
                kpis
                  ? kpis.criticalAlerts > 0
                    ? { label: "attention", pulse: true, token: "danger" }
                    : { label: "clear", token: "success" }
                  : undefined
              }
              value={kpis?.criticalAlerts ?? "—"}
            />
            <KpiCard
              description="Open across the lifecycle"
              icon={TriangleAlert}
              label="Active Incidents"
              loading={!data}
              value={kpis?.activeIncidents ?? "—"}
            />
            <KpiCard
              description="Change requests in review"
              icon={ClipboardCheck}
              label="Pending Approvals"
              loading={!data}
              status={
                kpis && kpis.pendingApprovals > 0
                  ? { label: "queue", token: "warning" }
                  : undefined
              }
              value={kpis?.pendingApprovals ?? "—"}
            />
            <KpiCard
              description="Compliant devices / managed"
              icon={DatabaseBackup}
              label="Backup Compliance"
              loading={!data}
              status={
                kpis === undefined
                  ? undefined
                  : kpis.backupCompliancePct >= 95
                    ? { label: "on target", token: "success" }
                    : kpis.backupCompliancePct >= 80
                      ? { label: "watch", token: "warning" }
                      : { label: "at risk", token: "danger" }
              }
              value={kpis ? `${kpis.backupCompliancePct}%` : "—"}
            />
          </div>

          {/* Row 2: trend + health */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
            <UtilizationCard
              data={data?.utilizationTrend ?? []}
              loading={!data}
              onRangeChange={onRangeChange}
              range={range}
            />
            <HealthDistributionCard
              data={data?.healthDistribution ?? []}
              loading={!data}
              total={data?.healthDistribution.reduce((sum, s) => sum + s.count, 0) ?? 0}
            />
          </div>

          {/* Row 3: incidents + changes */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ActiveIncidentsCard incidents={data?.activeIncidentsList ?? []} loading={!data} />
            <UpcomingChangesCard changes={data?.upcomingChanges ?? []} loading={!data} />
          </div>

          {/* Row 4: compliance + drift + capacity */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <BackupComplianceCard
              loading={!data}
              summary={data?.backupCompliance}
            />
            <DriftCard count={kpis?.driftCount} loading={!data} />
            <CapacityRisksCard loading={!data} risks={data?.capacityRisks ?? []} />
          </div>

          {/* Row 5: activity */}
          <RecentActivityCard activity={data?.recentActivity ?? []} loading={!data} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row 3 widgets                                                       */
/* ------------------------------------------------------------------ */

function ActiveIncidentsCard({
  incidents,
  loading,
}: {
  incidents: DashboardIncident[];
  loading: boolean;
}) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <SectionCard
      description="Open incidents ordered by severity"
      title="Active Incidents"
      actions={
        <Button
          onClick={() => setActiveView("ops.incidents")}
          size="sm"
          variant="ghost"
        >
          View all
          <ArrowRight aria-hidden="true" />
        </Button>
      }
    >
      {loading ? (
        <WidgetSkeleton rows={5} />
      ) : incidents.length === 0 ? (
        <EmptyState
          className="border-none bg-transparent py-8"
          description="Every incident is resolved — the network is quiet."
          icon={Siren}
          title="No active incidents"
        />
      ) : (
        <ul className="-my-1 flex flex-col">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <button
                className="group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-start transition-colors hover:bg-accent"
                onClick={() => setActiveView("ops.incidents")}
                type="button"
              >
                <IncidentSeverityBadge className="shrink-0" value={incident.severity} />
                <span className="font-tech shrink-0 text-muted-foreground ltr-technical">
                  {incident.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm" title={incident.title}>
                  {incident.title}
                </span>
                <StatusBadge
                  className="hidden lg:inline-flex"
                  config={lookupStatusConfig(INCIDENT_STATUS_UI, incident.status)}
                  withIcon={false}
                />
                <span className="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                  {relative(incident.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function UpcomingChangesCard({
  changes,
  loading,
}: {
  changes: DashboardChange[];
  loading: boolean;
}) {
  return (
    <SectionCard
      description="Approved and scheduled work, next first"
      title="Upcoming Changes"
    >
      {loading ? (
        <WidgetSkeleton rows={5} />
      ) : changes.length === 0 ? (
        <EmptyState
          className="border-none bg-transparent py-8"
          description="Approved or scheduled changes will appear here."
          icon={ClipboardCheck}
          title="No upcoming changes"
        />
      ) : (
        <ul className="-my-1 flex flex-col">
          {changes.map((change) => (
            <li
              className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent"
              key={change.id}
            >
              <ChangeRiskBadge className="shrink-0" value={change.riskLevel} />
              <span className="font-tech shrink-0 text-muted-foreground ltr-technical">
                {change.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm" title={change.title}>
                {change.title}
              </span>
              <StatusBadge
                className="hidden lg:inline-flex"
                config={lookupStatusConfig(CHANGE_STATUS_UI, change.status)}
                withIcon={false}
              />
              <span className="w-28 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                {change.scheduledStart
                  ? format(new Date(change.scheduledStart), "MMM d, HH:mm")
                  : "unscheduled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Row 4 widgets                                                       */
/* ------------------------------------------------------------------ */

function BackupComplianceCard({
  loading,
  summary,
}: {
  loading: boolean;
  summary:
    | {
        compliant: number;
        overdue: number;
        failed: number;
        never: number;
        unknown: number;
        lastSuccessfulBackupAt: string | null;
      }
    | undefined;
}) {
  const total =
    summary
      ? summary.compliant +
        summary.overdue +
        summary.failed +
        summary.never +
        summary.unknown
      : 0;
  const pct =
    summary && total > 0
      ? Math.round((summary.compliant / total) * 1000) / 10
      : 0;

  const counts = summary
    ? [
        { label: "Compliant", token: "success" as const, value: summary.compliant },
        { label: "Overdue", token: "warning" as const, value: summary.overdue },
        { label: "Failed", token: "danger" as const, value: summary.failed },
        { label: "Never", token: "neutral" as const, value: summary.never },
      ]
    : [];

  return (
    <SectionCard
      description="Managed devices by last-backup state"
      title="Backup Compliance"
    >
      {loading || !summary ? (
        <WidgetSkeleton rows={4} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{pct}%</span>
            <span className="text-sm text-muted-foreground">compliant</span>
            <BackupComplianceBadge
              className="ms-auto"
              value={pct >= 95 ? "COMPLIANT" : pct >= 80 ? "OVERDUE" : "FAILED"}
            />
          </div>
          <Progress
            aria-label={`Backup compliance ${pct} percent`}
            value={pct}
          />
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {counts.map((count) => (
              <li className="flex items-center gap-2" key={count.label}>
                <StatusDotSpan token={count.token} />
                <span className="text-muted-foreground">{count.label}</span>
                <span className="ms-auto font-medium tabular-nums">
                  {count.value}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Last successful backup{" "}
            <span className="font-medium text-foreground">
              {relative(summary.lastSuccessfulBackupAt)}
            </span>
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function StatusDotSpan({
  token,
}: {
  token: "success" | "warning" | "danger" | "neutral";
}) {
  const tone = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    neutral: "bg-neutral",
  }[token];
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", tone)}
    />
  );
}

function DriftCard({ count, loading }: { count: number | undefined; loading: boolean }) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <SectionCard
      description="Current config vs. approved baseline"
      title="Configuration Drift"
    >
      {loading || count === undefined ? (
        <WidgetSkeleton rows={4} />
      ) : count === 0 ? (
        <EmptyState
          className="border-none bg-transparent py-8"
          description="Baseline polling has not flagged any devices."
          icon={FileDiff}
          title="No configuration drift detected"
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-3xl font-semibold tabular-nums">{count}</span>
            <span className="text-sm text-muted-foreground">open</span>
            <DriftStatusBadge className="ms-auto" value="OPEN" />
          </div>
          <p className="text-xs text-muted-foreground">
            Running configs differ from their approved baselines. Review the
            diffs, then resolve or accept each record.
          </p>
          <Button
            className="self-start"
            onClick={() => setActiveView("config.drift")}
            size="sm"
            variant="outline"
          >
            Open Drift module
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

function CapacityRisksCard({
  loading,
  risks,
}: {
  loading: boolean;
  risks: CapacityRisk[];
}) {
  const metricLabel = (metric: string) =>
    metric === "UTILIZATION_IN" ? "Inbound" : "Outbound";

  return (
    <SectionCard
      description="Peak 24h interface utilization above 75%"
      title="Capacity Risks"
    >
      {loading ? (
        <WidgetSkeleton rows={4} />
      ) : risks.length === 0 ? (
        <EmptyState
          className="border-none bg-transparent py-8"
          description="No interface is above the 75% utilization threshold."
          title="No capacity risks right now"
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {risks.map((risk) => {
            const tone =
              risk.value > 95
                ? "bg-danger"
                : risk.value > 85
                  ? "bg-warning"
                  : "bg-primary";
            return (
              <li className="flex flex-col gap-1" key={`${risk.deviceId}-${risk.metric}`}>
                <div className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium" title={risk.hostname}>
                    {risk.hostname}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {metricLabel(risk.metric)}
                  </span>
                  <span className="w-14 shrink-0 text-end font-medium tabular-nums">
                    {risk.value}%
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn("h-full rounded-full", tone)}
                    style={{ width: `${Math.min(100, risk.value)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <span className="sr-only">
        Utilization bars turn warning above 85 percent and danger above 95
        percent.
      </span>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Row 5 widget                                                        */
/* ------------------------------------------------------------------ */

function RecentActivityCard({
  activity,
  loading,
}: {
  activity: {
    id: string;
    actorName: string;
    action: string;
    resourceLabel: string | null;
    result: string;
    createdAt: string;
  }[];
  loading: boolean;
}) {
  return (
    <SectionCard
      contentClassName="p-0"
      description="Latest 12 audit events"
      title="Recent Activity"
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={6} />
        </div>
      ) : activity.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            title="No audit events recorded yet"
          />
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-start font-medium">Time</th>
                <th className="px-4 py-2 text-start font-medium">Actor</th>
                <th className="px-4 py-2 text-start font-medium">Action</th>
                <th className="hidden px-4 py-2 text-start font-medium md:table-cell">
                  Resource
                </th>
                <th className="px-4 py-2 text-end font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((entry) => {
                const success = entry.result !== "FAILURE";
                return (
                  <tr
                    className="border-b transition-colors last:border-0 hover:bg-accent/50"
                    key={entry.id}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground tabular-nums">
                      {format(new Date(entry.createdAt), "HH:mm:ss")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span className="flex items-center gap-1.5">{entry.actorName}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span className="font-tech text-xs ltr-technical">
                        {entry.action}
                      </span>
                    </td>
                    <td className="hidden max-w-[220px] truncate px-4 py-2 text-muted-foreground md:table-cell">
                      {entry.resourceLabel ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-end">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                          success
                            ? "bg-success-subtle text-success"
                            : "bg-danger-subtle text-danger"
                        )}
                      >
                        {success ? "Success" : "Failure"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
