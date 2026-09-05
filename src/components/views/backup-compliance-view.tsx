"use client";

import { format, formatDistanceToNow } from "date-fns";
import { Activity, ShieldCheck, ShieldAlert, CloudOff } from "lucide-react";

import { useBackupCompliance } from "@/hooks/api/use-backup-compliance";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import type { BackupCompliancePayload } from "@/lib/api-client";

/**
 * Backup Compliance (Phase 3-a): fleet posture recomputed live from device
 * lastBackupAt — KPI cards, per-site breakdown with stacked compliance bars
 * and the worst-offender list. Bands (labeled, static windows):
 *   COMPLIANT ≤ 24 h · OVERDUE (at risk) 24–72 h · non-compliant > 72 h / never.
 */

function ComplianceBar({
  compliant,
  atRisk,
  nonCompliant,
}: {
  compliant: number;
  atRisk: number;
  nonCompliant: number;
}) {
  const total = compliant + atRisk + nonCompliant;
  if (total === 0) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      aria-hidden="true"
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      role="presentation"
    >
      <div className="bg-success" style={{ width: pct(compliant) }} />
      <div className="bg-warning" style={{ width: pct(atRisk) }} />
      <div className="bg-danger" style={{ width: pct(nonCompliant) }} />
    </div>
  );
}

function ComplianceLegend() {
  const items = [
    { className: "bg-success", label: "Compliant ≤ 24 h" },
    { className: "bg-warning", label: "At risk 24–72 h" },
    { className: "bg-danger", label: "Non-compliant > 72 h / never" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span className="flex items-center gap-1.5" key={item.label}>
          <span aria-hidden="true" className={cn("size-2 rounded-full", item.className)} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function BackupComplianceView() {
  const compliance = useBackupCompliance();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  if (compliance.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          description="Backup posture across the fleet, recomputed live from device backup state"
          title="Backup Compliance"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <KpiCard key={index} label="" loading value="" />
          ))}
        </div>
        <SectionCard className="min-h-48" title="Per-site compliance">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        </SectionCard>
      </div>
    );
  }

  if (compliance.isError || !compliance.data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          description="Backup posture across the fleet, recomputed live from device backup state"
          title="Backup Compliance"
        />
        <ErrorState
          onRetry={() => void compliance.refetch()}
          reason={
            compliance.error instanceof Error
              ? compliance.error.message
              : "Unknown error"
          }
          title="Backup compliance could not be loaded"
        />
      </div>
    );
  }

  const data: BackupCompliancePayload = compliance.data;
  const { kpis, perSite, staleDevices } = data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Backup posture across the fleet, recomputed live from device backup state"
        title="Backup Compliance"
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={`${kpis.compliant} of ${kpis.managedDevices} managed devices`}
          icon={ShieldCheck}
          label="Compliant"
          status={{ label: "backed up ≤ 24 h", token: "success" }}
          value={`${kpis.compliantPct}%`}
        />
        <KpiCard
          description="Last backup 24–72 h ago — next window decides"
          icon={ShieldAlert}
          label="At risk"
          status={{ label: "24–72 h", token: "warning" }}
          value={kpis.atRisk}
        />
        <KpiCard
          description="Older than 72 h or never backed up"
          icon={CloudOff}
          label="Non-compliant"
          status={{ label: "> 72 h / never", token: "danger" }}
          value={kpis.nonCompliant}
        />
        <KpiCard
          description="Configurations captured in the last 24 hours"
          icon={Activity}
          label="Snapshots (24 h)"
          value={kpis.snapshotsLast24h}
        />
      </div>

      {/* Per-site breakdown */}
      <SectionCard
        contentClassName="p-0"
        actions={<ComplianceLegend />}
        description="Compliance mix per site; devices without a site are grouped as Unassigned"
        title="Per-site compliance"
      >
        {perSite.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Add managed devices to start tracking backup compliance."
              icon={ShieldCheck}
              title="No managed devices"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Site</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Managed</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                    Compliant
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">At risk</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    Non-compliant
                  </TableHead>
                  <TableHead className="h-(--density-row-h) w-48 px-(--density-cell-x)">
                    Mix
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perSite.map((site) => (
                  <TableRow key={site.siteId ?? "__unassigned"}>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{site.siteName}</span>
                        {site.siteCode && (
                          <span className="font-tech text-xs ltr-technical text-muted-foreground">
                            {site.siteCode}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) tabular-nums">
                      {site.managed}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) tabular-nums text-success">
                      {site.compliant}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) tabular-nums text-warning">
                      {site.atRisk}
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums text-danger sm:table-cell">
                      {site.nonCompliant}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <div className="flex flex-col gap-1">
                        <ComplianceBar
                          atRisk={site.atRisk}
                          compliant={site.compliant}
                          nonCompliant={site.nonCompliant}
                        />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {site.compliantPct !== null ? `${site.compliantPct}% compliant` : "—"}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Stale devices */}
      <SectionCard
        contentClassName="p-0"
        description="Worst ten by last successful backup — never backed up first, then oldest"
        title="Devices needing attention"
      >
        {staleDevices.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Every managed device has a backup within the last 24 hours."
              icon={ShieldCheck}
              title="No stale devices"
            />
          </div>
        ) : (
          <ul className="divide-y">
            {staleDevices.map((device) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
                key={device.deviceId}
              >
                <button
                  aria-label={`Open ${device.hostname} device detail`}
                  className="font-tech text-sm font-medium ltr-technical text-foreground underline-offset-4 hover:text-primary hover:underline"
                  onClick={() =>
                    setActiveView("network.device-detail", { deviceId: device.deviceId })
                  }
                  type="button"
                >
                  {device.hostname}
                </button>
                <span className="text-xs text-muted-foreground">
                  {device.siteCode ?? "Unassigned"}
                </span>
                <BackupComplianceBadge value={device.band} />
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {device.lastBackupAt
                    ? `${format(new Date(device.lastBackupAt), "MMM d, HH:mm")} (${formatDistanceToNow(
                        new Date(device.lastBackupAt),
                        { addSuffix: true }
                      )})`
                    : "No successful backup on record"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
