"use client";

import {
  Boxes,
  Building2,
  MapPin,
  Network,
  ShieldCheck,
} from "lucide-react";

import { useSites } from "@/hooks/api/use-sites";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusDot } from "@/components/domain/status-dot";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DEVICE_STATUS, getStatusConfig } from "@/lib/domain/status";
import type { SiteSummary } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";

/**
 * Sites (Phase 2): per-site aggregates — device mix, interface count and
 * backup compliance — with a drill-down into the filtered device inventory.
 */
export function SitesView() {
  const sites = useSites();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Locations, device distribution and backup posture per site"
        title="Sites"
      />

      {sites.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton className="h-52 rounded-xl" key={index} />
          ))}
        </div>
      ) : sites.isError ? (
        <ErrorState
          onRetry={() => void sites.refetch()}
          reason={sites.error.message}
          title="Sites could not be loaded"
        />
      ) : (sites.data?.length ?? 0) === 0 ? (
        <EmptyState
          description="Sites are created by administrators and group devices by location."
          icon={Building2}
          title="No sites configured"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sites.data?.map((site) => (
            <SiteCard
              key={site.id}
              onViewDevices={() =>
                setActiveView("network.devices", { siteId: site.id })
              }
              site={site}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SiteCard({
  site,
  onViewDevices,
}: {
  site: SiteSummary;
  onViewDevices: () => void;
}) {
  const statusEntries = Object.entries(site.statusCounts).filter(
    ([, count]) => count > 0
  );

  return (
    <SectionCard
      className="flex flex-col"
      contentClassName="flex flex-1 flex-col gap-4"
      description={
        [site.region, site.address].filter(Boolean).join(" · ") || undefined
      }
      title={site.name}
    >
      {/* Header row: code + device totals */}
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-md border bg-surface-subtle px-2 py-0.5 font-tech text-xs ltr-technical text-muted-foreground">
          {site.code}
        </span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Boxes aria-hidden="true" className="size-4" />
          <span className="font-semibold tabular-nums text-foreground">
            {site.managedCount}
          </span>
          managed / {site.deviceCount} total
        </span>
      </div>

      {/* Device status mix */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">Device status</p>
        {statusEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {statusEntries.map(([status, count]) => {
              const config = getStatusConfig(DEVICE_STATUS, status);
              return (
                <li className="flex items-center gap-2 text-sm" key={status}>
                  <StatusDot
                    className={config.dotClass}
                    label={config.label}
                  />
                  <span>{config.label}</span>
                  <span className="ms-auto tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Meta + compliance */}
      <div className="mt-auto flex flex-col gap-3 border-t pt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Network aria-hidden="true" className="size-3.5" />
            {site.interfaceCount} interfaces
          </span>
          <span className="flex items-center gap-1.5">
            <MapPin aria-hidden="true" className="size-3.5" />
            {Object.keys(site.criticalityMix).length} criticality classes
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              Backup compliance
            </span>
            <BackupComplianceBadge
              value={
                site.compliance.pct === null
                  ? "UNKNOWN"
                  : site.compliance.pct >= 90
                    ? "COMPLIANT"
                    : site.compliance.pct >= 70
                      ? "AT_RISK"
                      : "NON_COMPLIANT"
              }
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {site.compliance.compliant}/{site.compliance.total} devices compliant
            </span>
          </div>
          <Button onClick={onViewDevices} size="sm" variant="outline">
            View devices
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
