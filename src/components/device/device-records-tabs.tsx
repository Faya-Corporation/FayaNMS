"use client";

import { format, formatDistanceToNow } from "date-fns";
import {
  GitPullRequestArrow,
  CloudUpload,
  History,
  Siren,
} from "lucide-react";

import {
  useDeviceAlerts,
  useDeviceAudit,
  useDeviceChanges,
  useDeviceIncidents,
  useDeviceSnapshots,
} from "@/hooks/api/use-device-detail";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { ChangeStatusBadge } from "@/components/domain/change-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  ALERT_STATUS,
  CHANGE_STATUS,
  INCIDENT_STATUS,
  SEVERITY,
  getStatusConfig,
} from "@/lib/domain/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ */
/* Shared bits                                                          */
/* ------------------------------------------------------------------ */

function TabSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
      ))}
    </div>
  );
}

function TabError({
  message,
  onRetry,
  title,
}: {
  message: string;
  onRetry: () => void;
  title: string;
}) {
  return <ErrorState onRetry={onRetry} reason={message} title={title} />;
}

/* ------------------------------------------------------------------ */
/* Backups tab                                                          */
/* ------------------------------------------------------------------ */

interface BackupsTabProps {
  deviceId: string;
  device: {
    lastBackupAt: string | null;
    backupCompliance: string;
  };
  onViewConfig: (snapshotId: string) => void;
}

/**
 * Backups tab: compliance summary + backup/snapshot history. "View config"
 * jumps to the Config tab with the snapshot preselected.
 */
export function BackupsTab({ deviceId, device, onViewConfig }: BackupsTabProps) {
  const snapshots = useDeviceSnapshots(deviceId);

  const rows = [...(snapshots.data?.data ?? [])].sort(
    (a, b) => b.version - a.version
  );

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionCard description="Fleet policy compliance for this device" title="Backup Compliance">
          <BackupComplianceBadge value={device.backupCompliance} />
          <p className="mt-2 text-sm text-muted-foreground tabular-nums">
            {device.lastBackupAt
              ? `Last successful backup ${formatDistanceToNow(new Date(device.lastBackupAt), { addSuffix: true })}`
              : "No successful backup on record yet."}
          </p>
        </SectionCard>
        <SectionCard description="Versions captured by jobs, policies and changes" title="Retention Snapshot">
          <p className="text-3xl font-semibold tabular-nums">{rows.length}</p>
          <p className="text-sm text-muted-foreground">
            configuration versions stored (oldest pruned by retention policy)
          </p>
        </SectionCard>
      </div>

      <SectionCard contentClassName="p-0" title="Backup History">
        {snapshots.isLoading ? (
          <div className="p-4">
            <TabSkeleton />
          </div>
        ) : snapshots.isError ? (
          <div className="p-4">
            <TabError
              message={snapshots.error.message}
              onRetry={() => void snapshots.refetch()}
              title="Backup history could not be loaded"
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Trigger “Backup now” from the device header to capture the first configuration."
              icon={CloudUpload}
              title="No backups recorded"
            />
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((snapshot) => (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={snapshot.id}>
                <span className="font-tech text-sm font-medium ltr-technical">
                  v{snapshot.version}
                </span>
                <span className="text-sm text-muted-foreground">
                  {format(new Date(snapshot.createdAt), "MMM d, yyyy HH:mm")}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {(snapshot.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                  <span className="font-tech ltr-technical">
                    {snapshot.sha256.slice(0, 10)}…
                  </span>
                </span>
                {snapshot.correlationId && (
                  <span className="hidden text-xs text-muted-foreground font-tech ltr-technical sm:inline">
                    {snapshot.correlationId}
                  </span>
                )}
                <Button
                  className="ms-auto"
                  onClick={() => onViewConfig(snapshot.id)}
                  size="sm"
                  variant="ghost"
                >
                  View config
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Changes tab                                                          */
/* ------------------------------------------------------------------ */

export function ChangesTab({ deviceId }: { deviceId: string }) {
  const changes = useDeviceChanges(deviceId);

  return (
    <SectionCard
      contentClassName="p-0"
      description="Change requests that include this device"
      title="Linked Changes"
    >
      {changes.isLoading ? (
        <div className="p-4">
          <TabSkeleton />
        </div>
      ) : changes.isError ? (
        <div className="p-4">
          <TabError
            message={changes.error.message}
            onRetry={() => void changes.refetch()}
            title="Changes could not be loaded"
          />
        </div>
      ) : (changes.data?.data.length ?? 0) === 0 ? (
        <div className="p-4">
          <EmptyState
            description="Changes appear here once this device is added to a change request's scope."
            icon={GitPullRequestArrow}
            title="No linked changes"
          />
        </div>
      ) : (
        <ul className="divide-y">
          {changes.data?.data.map((change) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={change.id}>
              <span className="font-tech text-sm font-medium ltr-technical">
                {change.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm" title={change.title}>
                {change.title}
              </span>
              <ChangeRiskBadge value={change.riskLevel} />
              <ChangeStatusBadge value={change.status} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {change.scheduledStart
                  ? format(new Date(change.scheduledStart), "MMM d, HH:mm")
                  : "Unscheduled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Incidents tab                                                        */
/* ------------------------------------------------------------------ */

export function IncidentsTab({ deviceId }: { deviceId: string }) {
  const incidents = useDeviceIncidents(deviceId);

  return (
    <SectionCard
      contentClassName="p-0"
      description="Incidents correlated to this device"
      title="Linked Incidents"
    >
      {incidents.isLoading ? (
        <div className="p-4">
          <TabSkeleton />
        </div>
      ) : incidents.isError ? (
        <div className="p-4">
          <TabError
            message={incidents.error.message}
            onRetry={() => void incidents.refetch()}
            title="Incidents could not be loaded"
          />
        </div>
      ) : (incidents.data?.data.length ?? 0) === 0 ? (
        <div className="p-4">
          <EmptyState
            description="Incidents raised against this device will appear here with their SLA timers."
            icon={Siren}
            title="No linked incidents"
          />
        </div>
      ) : (
        <ul className="divide-y">
          {incidents.data?.data.map((incident) => {
            const status = getStatusConfig(INCIDENT_STATUS, incident.status);
            const overdue =
              incident.slaDueAt !== null &&
              incident.resolvedAt === null &&
              new Date(incident.slaDueAt).getTime() < Date.now();
            return (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={incident.id}>
                <span className="font-tech text-sm font-medium ltr-technical">
                  {incident.number}
                </span>
                <SeverityBadge value={incident.severity} />
                <span className="min-w-0 flex-1 truncate text-sm" title={incident.title}>
                  {incident.title}
                </span>
                <StatusBadge config={status} withIcon={false} />
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    overdue ? "text-danger" : "text-muted-foreground"
                  )}
                >
                  {incident.resolvedAt
                    ? `Resolved ${formatDistanceToNow(new Date(incident.resolvedAt), { addSuffix: true })}`
                    : incident.slaDueAt
                      ? `SLA due ${formatDistanceToNow(new Date(incident.slaDueAt), { addSuffix: true })}`
                      : "No SLA target"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts tab                                                           */
/* ------------------------------------------------------------------ */

export function DeviceAlertsTab({ deviceId }: { deviceId: string }) {
  const alerts = useDeviceAlerts(deviceId, { pageSize: 50 });

  return (
    <SectionCard
      contentClassName="p-0"
      description="Alert stream for this device (active, acknowledged, resolved)"
      title="Alerts"
    >
      {alerts.isLoading ? (
        <div className="p-4">
          <TabSkeleton />
        </div>
      ) : alerts.isError ? (
        <div className="p-4">
          <TabError
            message={alerts.error.message}
            onRetry={() => void alerts.refetch()}
            title="Alerts could not be loaded"
          />
        </div>
      ) : (alerts.data?.data.length ?? 0) === 0 ? (
        <div className="p-4">
          <EmptyState
            description="Threshold and availability alerts for this device will stream in here."
            icon={Siren}
            title="No alerts on record"
          />
        </div>
      ) : (
        <ul className="divide-y">
          {alerts.data?.data.map((alert) => {
            const status = getStatusConfig(ALERT_STATUS, alert.status);
            const severity = getStatusConfig(SEVERITY, alert.severity);
            return (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={alert.id}>
                <StatusBadge config={severity} withIcon />
                <span className="min-w-0 flex-1 truncate text-sm" title={alert.message}>
                  {alert.message}
                </span>
                {alert.ruleName && (
                  <span className="hidden text-xs text-muted-foreground md:inline">
                    rule: {alert.ruleName}
                  </span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                  ×{alert.count}
                </span>
                <StatusBadge config={status} withIcon={false} />
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatDistanceToNow(new Date(alert.lastSeen), { addSuffix: true })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Audit tab                                                            */
/* ------------------------------------------------------------------ */

export function DeviceAuditTab({
  deviceId,
  pageSize = 50,
}: {
  deviceId: string;
  pageSize?: number;
}) {
  const audit = useDeviceAudit(deviceId, { pageSize });

  return (
    <SectionCard
      contentClassName="p-0"
      description="Who did what to this device, with correlation IDs"
      title="Audit Trail"
    >
      {audit.isLoading ? (
        <div className="p-4">
          <TabSkeleton rows={6} />
        </div>
      ) : audit.isError ? (
        <div className="p-4">
          <TabError
            message={audit.error.message}
            onRetry={() => void audit.refetch()}
            title="Audit trail could not be loaded"
          />
        </div>
      ) : (audit.data?.data.length ?? 0) === 0 ? (
        <div className="p-4">
          <EmptyState
            description="Platform actions (logins, backups, changes) touching this device are recorded here."
            icon={History}
            title="No audit events yet"
          />
        </div>
      ) : (
        <ul className="divide-y">
          {audit.data?.data.map((event) => {
            const success = event.result !== "FAILURE";
            return (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={event.id}>
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", success ? "bg-success" : "bg-danger")}
                />
                <span className="font-tech text-sm ltr-technical">{event.action}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {event.resourceLabel ?? event.resourceType}
                </span>
                <span className="text-xs text-muted-foreground">{event.actorName}</span>
                {event.correlationId && (
                  <span className="hidden text-xs text-muted-foreground font-tech ltr-technical lg:inline">
                    {event.correlationId}
                  </span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {format(new Date(event.createdAt), "MMM d, HH:mm:ss")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
