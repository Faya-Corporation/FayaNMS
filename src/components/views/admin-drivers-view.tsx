"use client";

import { Plug, Puzzle } from "lucide-react";
import { useTranslations } from "next-intl";

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
 *
 * i18n (R81 tranche 2): all chrome keyed through the `drivers` namespace.
 * Documented data-plane survivors (registry manifests, rendered as-is in
 * both locales — same precedent as the VENDOR_LABELS product names):
 * driver.vendorLabel, driver.adapter, cap.label, driver.configFlavor and
 * driver.notes all come from the drivers registry (src/lib/vendors).
 */

export function AdminDriversView() {
  const t = useTranslations("drivers");
  const driversQuery = useDrivers();
  const drivers = driversQuery.data?.drivers ?? [];

  const capabilityCount = new Set(
    drivers.flatMap((d) => d.capabilities.map((c) => c.key))
  ).size;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label={t("kpi.adapters")} value={String(drivers.length)} icon={Plug} />
        <KpiCard
          label={t("kpi.capabilities")}
          value={String(capabilityCount)}
          icon={Puzzle}
        />
        <KpiCard
          label={t("kpi.configFlavors")}
          value={String(new Set(drivers.map((d) => d.configFlavor)).size)}
          icon={Plug}
        />
      </div>

      <SectionCard title={t("catalog.title")} description={t("catalog.description")}>
        {driversQuery.isLoading ? (
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : driversQuery.isError ? (
          <ErrorState
            title={t("error.title")}
            reason={t("error.reason")}
            onRetry={() => void driversQuery.refetch()}
          />
        ) : drivers.length === 0 ? (
          <EmptyState
            icon={Plug}
            title={t("empty.title")}
            description={t("empty.description")}
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
                        {/* Config-flavor prefix (decorative — flavor text adjacent). xs=14px is the documented glyph minimum (B2-022). */}
                        <FayanmsIcon name="configuration" size="xs" />
                        <span>{t("flavorPrefix", { flavor: driver.configFlavor })}</span>
                      </span>
                    </div>
                  </div>
                  <Badge variant="secondary">
                    {t("caps", { count: driver.capabilities.length })}
                  </Badge>
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
