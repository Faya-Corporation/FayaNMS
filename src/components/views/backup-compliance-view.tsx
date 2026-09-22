"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("backupCompliance");
  const items = [
    { className: "bg-success", label: t("legend.compliant") },
    { className: "bg-warning", label: t("legend.atRisk") },
    { className: "bg-danger", label: t("legend.nonCompliant") },
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
  const t = useTranslations("backupCompliance");
  const compliance = useBackupCompliance();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  if (compliance.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          description={t("page.description")}
          title={t("page.title")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <KpiCard key={index} label="" loading value="" />
          ))}
        </div>
        <SectionCard className="min-h-48" title={t("site.title")}>
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
          description={t("page.description")}
          title={t("page.title")}
        />
        <ErrorState
          onRetry={() => void compliance.refetch()}
          reason={
            compliance.error instanceof Error
              ? compliance.error.message
              : t("error.unknown")
          }
          title={t("error.load")}
        />
      </div>
    );
  }

  const data: BackupCompliancePayload = compliance.data;
  const { kpis, perSite, staleDevices } = data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description={t("page.description")}
        title={t("page.title")}
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={t("kpi.compliant.description", {
            compliant: kpis.compliant,
            managed: kpis.managedDevices,
          })}
          icon={ShieldCheck}
          label={t("kpi.compliant.label")}
          status={{ label: t("kpi.compliant.status"), token: "success" }}
          value={`${kpis.compliantPct}%`}
        />
        <KpiCard
          description={t("kpi.atRisk.description")}
          icon={ShieldAlert}
          label={t("kpi.atRisk.label")}
          status={{ label: t("kpi.atRisk.status"), token: "warning" }}
          value={kpis.atRisk}
        />
        <KpiCard
          description={t("kpi.nonCompliant.description")}
          icon={CloudOff}
          label={t("kpi.nonCompliant.label")}
          status={{ label: t("kpi.nonCompliant.status"), token: "danger" }}
          value={kpis.nonCompliant}
        />
        <KpiCard
          description={t("kpi.snapshots.description")}
          icon={Activity}
          label={t("kpi.snapshots.label")}
          value={kpis.snapshotsLast24h}
        />
      </div>

      {/* Per-site breakdown */}
      <SectionCard
        contentClassName="p-0"
        actions={<ComplianceLegend />}
        description={t("site.description")}
        title={t("site.title")}
      >
        {perSite.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("site.emptyDescription")}
              icon={ShieldCheck}
              title={t("site.emptyTitle")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("site.tableAria")} className="min-w-[760px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("site.headers.site")}</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("site.headers.managed")}</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                    {t("site.headers.compliant")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("site.headers.atRisk")}</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    {t("site.headers.nonCompliant")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) w-48 px-(--density-cell-x)">
                    {t("site.headers.mix")}
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
                          {site.compliantPct !== null
                            ? t("site.percent", { percent: site.compliantPct })
                            : "—"}
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
        description={t("stale.description")}
        title={t("stale.title")}
      >
        {staleDevices.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("stale.emptyDescription")}
              icon={ShieldCheck}
              title={t("stale.emptyTitle")}
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
                  aria-label={t("row.openDeviceAria", { hostname: device.hostname })}
                  className="font-tech text-sm font-medium ltr-technical text-foreground underline-offset-4 hover:text-primary hover:underline"
                  onClick={() =>
                    setActiveView("network.device-detail", { deviceId: device.deviceId })
                  }
                  type="button"
                >
                  {device.hostname}
                </button>
                <span className="text-xs text-muted-foreground">
                  {device.siteCode ?? t("row.unassigned")}
                </span>
                <BackupComplianceBadge value={device.band} />
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {device.lastBackupAt
                    ? `${format(new Date(device.lastBackupAt), "MMM d, HH:mm")} (${formatDistanceToNow(
                        new Date(device.lastBackupAt),
                        { addSuffix: true }
                      )})`
                    : t("row.noBackup")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
