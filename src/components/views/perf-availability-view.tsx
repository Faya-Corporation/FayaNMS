"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { HeartPulse, Target } from "lucide-react";

import { usePerformanceAvailability } from "@/hooks/api/use-performance";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { Progress } from "@/components/ui/progress";
import { SectionCard } from "@/components/domain/section-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { cn } from "@/lib/utils";
import type { PerfAvailabilityDevice, PerfAvailabilitySite, PerfRange } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { PerfRangeChips, fmtPct, perfRangeLabel } from "./perf-overview-view";

function uptimeTone(pct: number, target: number): string {
  if (pct >= target) return "text-success";
  if (pct >= 99) return "text-warning";
  return "text-danger";
}

function fmtDowntime(minutes: number): string {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

/**
 * Availability (Task 6-b): fleet uptime vs the SLA target, worst-first
 * site and device tables. All numbers come straight from the frozen
 * /performance/availability contract.
 */
export function PerfAvailabilityView() {
  const t = useTranslations("perfAvailability");
  // Shared perf chrome translator — perfRangeLabel is keyed in the
  // perf-overview tranche (R85) and takes this perfOverview translator.
  const tRange = useTranslations("perfOverview");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const [range, setRange] = useState<PerfRange>("24H");

  const availability = usePerformanceAvailability(range);
  const data = availability.data?.data;
  const target = data?.slaTargetPct ?? 99.9;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={t("description", { range: perfRangeLabel(range, tRange) })}
        primaryAction={<PerfRangeChips onChange={setRange} value={range} />}
        title={t("title")}
      />

      {availability.isError ? (
        <ErrorState
          onRetry={() => void availability.refetch()}
          reason={availability.error.message}
          title={t("error.title")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
            <OverallCard
              className="md:col-span-2 xl:col-span-4"
              loading={!data}
              overallPct={data?.overallPct}
              target={target}
            />
            <SiteTable
              className="md:col-span-2 xl:col-span-8"
              loading={!data}
              sites={data?.bySite ?? []}
              target={target}
            />
          </div>
          <DeviceTable
            devices={data?.byDevice.slice(0, 25) ?? []}
            loading={!data}
            onOpenDevice={(deviceId) =>
              setActiveView("network.device-detail", { deviceId })
            }
            target={target}
          />
        </div>
      )}
    </div>
  );
}

function OverallCard({
  className,
  loading,
  overallPct,
  target,
}: {
  className?: string;
  loading: boolean;
  overallPct: number | undefined;
  target: number;
}) {
  const t = useTranslations("perfAvailability");
  const meetsTarget = overallPct !== undefined && overallPct >= target;

  return (
    <SectionCard className={className} title={t("overall.cardTitle")}>
      {loading || overallPct === undefined ? (
        <div className="flex h-[168px] flex-col justify-center">
          <WidgetSkeleton rows={3} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums">
              {fmtPct(overallPct, 2)}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                meetsTarget
                  ? "border-success/25 bg-success-subtle text-success"
                  : "border-warning/25 bg-warning-subtle text-warning"
              )}
            >
              <Target aria-hidden="true" className="size-3" />
              {t("overall.target", { pct: fmtPct(target, 2) })}
            </span>
          </div>
          <Progress
            aria-label={t("overall.progressAria", {
              pct: fmtPct(overallPct, 2),
              target: fmtPct(target, 2),
            })}
            value={Math.max(0, Math.min(100, overallPct))}
          />
          <p
            className={cn(
              "text-sm font-medium",
              meetsTarget ? "text-success" : "text-warning"
            )}
          >
            {meetsTarget
              ? t("overall.meets")
              : t("overall.below", { delta: (target - overallPct).toFixed(2) })}
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function SiteTable({
  className,
  loading,
  sites,
  target,
}: {
  className?: string;
  loading: boolean;
  sites: PerfAvailabilitySite[];
  target: number;
}) {
  const t = useTranslations("perfAvailability");
  return (
    <SectionCard
      className={className}
      contentClassName="p-0"
      description={t("site.cardDescription")}
      title={t("site.cardTitle")}
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : sites.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description={t("site.emptyDescription")}
            icon={HeartPulse}
            title={t("site.emptyTitle")}
          />
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table
            aria-label={t("site.ariaLabel")}
            className="w-full text-sm"
          >
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-start font-medium" scope="col">{t("site.col.site")}</th>
                <th className="px-4 py-2 text-end font-medium" scope="col">{t("site.col.uptime")}</th>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">{t("site.col.degraded")}</th>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">{t("site.col.downtime")}</th>
                <th className="px-4 py-2 text-end font-medium" scope="col">{t("site.col.devices")}</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  className="border-b transition-colors last:border-0 hover:bg-accent/50"
                  key={site.siteCode}
                >
                  <td className="px-4 py-2">
                    <span className="flex flex-col">
                      <span className="font-medium">{site.siteCode}</span>
                      <span className="max-w-[200px] truncate text-xs text-muted-foreground" title={site.siteName}>
                        {site.siteName}
                      </span>
                    </span>
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 text-end font-medium tabular-nums",
                      uptimeTone(site.uptimePct, target)
                    )}
                  >
                    {fmtPct(site.uptimePct, 2)}
                  </td>
                  <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
                    {fmtPct(site.degradedPct, 2)}
                  </td>
                  <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
                    {fmtDowntime(site.downtimeMinutes)}
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums">{site.deviceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function DeviceTable({
  devices,
  loading,
  onOpenDevice,
  target,
}: {
  devices: PerfAvailabilityDevice[];
  loading: boolean;
  onOpenDevice: (deviceId: string) => void;
  target: number;
}) {
  const t = useTranslations("perfAvailability");
  return (
    <SectionCard
      contentClassName="p-0"
      description={t("device.cardDescription")}
      title={t("device.cardTitle")}
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : devices.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description={t("device.emptyDescription")}
            icon={HeartPulse}
            title={t("device.emptyTitle")}
          />
        </div>
      ) : (
        <div tabIndex={0} className="max-h-96 overflow-y-auto">
          <table
            aria-label={t("device.ariaLabel")}
            className="w-full text-sm"
          >
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-start font-medium" scope="col">{t("device.col.device")}</th>
                <th className="px-4 py-2 text-start font-medium" scope="col">{t("device.col.site")}</th>
                <th className="px-4 py-2 text-end font-medium" scope="col">{t("device.col.uptime")}</th>
                <th className="px-4 py-2 text-end font-medium" scope="col">{t("device.col.downtime")}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr
                  className="border-b transition-colors last:border-0 hover:bg-accent/50"
                  key={device.deviceId}
                >
                  <td className="px-4 py-2">
                    <button
                      className="max-w-[260px] truncate font-tech text-sm text-primary hover:underline ltr-technical"
                      onClick={() => onOpenDevice(device.deviceId)}
                      title={device.hostname}
                      type="button"
                    >
                      {device.hostname}
                    </button>
                    <span className="sr-only"> — {t("row.openDevice")}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{device.siteCode}</td>
                  <td
                    className={cn(
                      "px-4 py-2 text-end font-medium tabular-nums",
                      uptimeTone(device.uptimePct, target)
                    )}
                  >
                    {fmtPct(device.uptimePct, 2)}
                  </td>
                  <td className="px-4 py-2 text-end text-muted-foreground tabular-nums">
                    {fmtDowntime(device.downtimeMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
