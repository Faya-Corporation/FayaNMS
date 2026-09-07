"use client";

import { useState } from "react";
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
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const [range, setRange] = useState<PerfRange>("24H");

  const availability = usePerformanceAvailability(range);
  const data = availability.data?.data;
  const target = data?.slaTargetPct ?? 99.9;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={`Uptime and SLA attainment — ${perfRangeLabel(range)}`}
        primaryAction={<PerfRangeChips onChange={setRange} value={range} />}
        title="Availability"
      />

      {availability.isError ? (
        <ErrorState
          onRetry={() => void availability.refetch()}
          reason={availability.error.message}
          title="Availability data could not be loaded"
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
  const meetsTarget = overallPct !== undefined && overallPct >= target;

  return (
    <SectionCard className={className} title="Fleet Availability">
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
              Target {fmtPct(target, 2)}
            </span>
          </div>
          <Progress
            aria-label={`Fleet availability ${fmtPct(overallPct, 2)} against target ${fmtPct(target, 2)}`}
            value={Math.max(0, Math.min(100, overallPct))}
          />
          <p
            className={cn(
              "text-sm font-medium",
              meetsTarget ? "text-success" : "text-warning"
            )}
          >
            {meetsTarget
              ? "Meeting the SLA target for this window."
              : `Below target by ${(target - overallPct).toFixed(2)} percentage points.`}
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
  return (
    <SectionCard
      className={className}
      contentClassName="p-0"
      description="Worst site first"
      title="By Site"
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : sites.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description="No sites have availability samples in this window."
            icon={HeartPulse}
            title="No site data"
          />
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-start font-medium">Site</th>
                <th className="px-4 py-2 text-end font-medium">Uptime</th>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">Degraded</th>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">Downtime</th>
                <th className="px-4 py-2 text-end font-medium">Devices</th>
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
  return (
    <SectionCard
      contentClassName="p-0"
      description="Worst 25 devices in the selected window"
      title="By Device — worst 25"
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : devices.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description="No device availability samples in this window."
            icon={HeartPulse}
            title="No device data"
          />
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-start font-medium">Device</th>
                <th className="px-4 py-2 text-start font-medium">Site</th>
                <th className="px-4 py-2 text-end font-medium">Uptime</th>
                <th className="px-4 py-2 text-end font-medium">Downtime</th>
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
                    <span className="sr-only"> — open device detail</span>
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
