"use client";

import { Plug, Puzzle } from "lucide-react";

import { DeviceVendorIcon, FayanmsIcon } from "@/components/icons";

import { useDrivers } from "@/hooks/api/use-admin";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";

/**
 * Administration → Device Drivers (Task 7-b).
 *
 * Vendor adapter catalog derived from src/lib/vendors — the same manifests
 * the config backup + change apply engines dispatch through. Static
 * surface: the adapters ARE the drivers.
 */

export function AdminDriversView() {
  const driversQuery = useDrivers();
  const drivers = driversQuery.data?.drivers ?? [];

  const capabilityCount = new Set(
    drivers.flatMap((d) => d.capabilities.map((c) => c.key))
  ).size;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Device Drivers"
        description="Vendor adapter catalog and capabilities used by backup, diff and change engines"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Adapters" value={String(drivers.length)} icon={Plug} />
        <KpiCard
          label="Distinct capabilities"
          value={String(capabilityCount)}
          icon={Puzzle}
        />
        <KpiCard
          label="Config flavors"
          value={String(new Set(drivers.map((d) => d.configFlavor)).size)}
          icon={Plug}
        />
      </div>

      <SectionCard title="Catalog" description="Every adapter is reachable through the change engine's apply path">
        {driversQuery.isLoading ? (
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : driversQuery.isError ? (
          <ErrorState
            title="Could not load drivers"
            reason="Try again."
            onRetry={() => void driversQuery.refetch()}
          />
        ) : drivers.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No drivers registered"
            description="Vendor adapters appear here once defined in the drivers registry."
          />
        ) : (
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {drivers.map((driver) => (
              <div
                key={driver.adapter}
                className="min-w-0 rounded-lg border p-4 transition-colors hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium">
                      {/* Vendor adapter glyph (decorative — vendorLabel names it). */}
                      <DeviceVendorIcon vendor={driver.vendor} />
                      {driver.vendorLabel}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-muted-foreground">
                      <span className="break-all">{driver.adapter}</span>
                      <span aria-hidden="true">·</span>
                      <span className="flex items-center gap-1">
                        {/* Config-flavor prefix (decorative — flavor text adjacent). */}
                        <FayanmsIcon name="configuration" size={12} />
                        <span>
                          flavor {driver.configFlavor}
                        </span>
                      </span>
                    </div>
                  </div>
                  <Badge variant="secondary">{driver.capabilities.length} caps</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {driver.capabilities.map((cap) => (
                    <Badge key={cap.key} variant="outline" className="whitespace-normal text-[10px]">
                      {cap.label}
                    </Badge>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {driver.modelFlavors.map((flavor) => (
                    <Badge
                      key={flavor}
                      variant="secondary"
                      className="whitespace-normal break-all font-mono text-[10px]"
                    >
                      {flavor}
                    </Badge>
                  ))}
                </div>
                {driver.notes && (
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    {driver.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
