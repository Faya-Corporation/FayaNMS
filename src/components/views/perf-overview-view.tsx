"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  ArrowDownUp,
  Cpu,
  Gauge,
  HeartPulse,
  MemoryStick,
  RotateCcw,
  Save,
  Timer,
  Trash2,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { usePerformanceOverview } from "@/hooks/api/use-performance";
import {
  useMetricsRetention,
  usePruneMetricsRetention,
  useSaveMetricsRetention,
} from "@/hooks/api/use-metrics-retention";
import { HealthDistributionCard } from "@/components/dashboard/health-distribution-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  HealthSlice,
  PerfHealthDistribution,
  PerfMetaInfo,
  PerfOverviewPoint,
  PerfOverviewResult,
  PerfRange,
  RetentionTierConfig,
  RetentionTierKey,
} from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { useTokenColors } from "@/components/dashboard/use-token-colors";

/* ------------------------------------------------------------------ */
/* Shared perf helpers (used by the sibling performance views)         */
/* ------------------------------------------------------------------ */

export const PERF_RANGES: { value: PerfRange; label: string }[] = [
  { value: "1H", label: "1H" },
  { value: "24H", label: "24H" },
  { value: "7D", label: "7D" },
  { value: "30D", label: "30D" },
];

/** Compact 1H/24H/7D/30D chip group — the perf-slice range control. */
export function PerfRangeChips({
  value,
  onChange,
  className,
}: {
  value: PerfRange;
  onChange: (range: PerfRange) => void;
  className?: string;
}) {
  return (
    <div
      aria-label="Time range"
      className={cn("flex items-center gap-1 rounded-lg border bg-card p-1", className)}
      role="group"
    >
      {PERF_RANGES.map((range) => (
        <button
          aria-pressed={value === range.value}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === range.value
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
          key={range.value}
          onClick={() => onChange(range.value)}
          type="button"
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

/** Percent formatting with a trailing % and stable decimals. */
export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** Millisecond formatting. */
export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value)} ms`;
}

/** Human label for the rollup granularity reported in meta. */
export function granularityLabel(granularity: string | undefined): string {
  switch (granularity) {
    case "5M":
      return "5-minute rollups";
    case "1H":
      return "hourly rollups";
    case "1D":
      return "daily rollups";
    case "RAW":
      return "raw samples";
    default:
      return granularity ? `${granularity.toLowerCase()} buckets` : "rollups";
  }
}

/** X-axis tick formatter matched to the range length. */
export function perfTickFormatter(range: PerfRange) {
  return (ts: string) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return ts;
    return range === "7D" || range === "30D"
      ? format(date, "MMM d")
      : format(date, "HH:mm");
  };
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
} as const;

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

/**
 * Performance Overview (Task 6-b): fleet KPIs, availability + latency
 * charts, top utilizers, health distribution — plus the metrics-retention
 * panel (tier windows + manual prune) required by the Phase 6 gate.
 */
export function PerfOverviewView() {
  const [range, setRange] = useState<PerfRange>("24H");
  const overview = usePerformanceOverview(range);
  const data = overview.data?.data;
  const meta: PerfMetaInfo | undefined = overview.data?.meta;
  const kpis = data?.kpis;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        actions={
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:inline-flex">
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-success"
            />
            Updated{" "}
            {overview.dataUpdatedAt
              ? format(overview.dataUpdatedAt, "HH:mm:ss")
              : "—"}
          </span>
        }
        description="Fleet-wide performance at a glance — availability, latency, utilization"
        primaryAction={
          <PerfRangeChips onChange={setRange} value={range} />
        }
        title="Performance Overview"
      />

      {overview.isError ? (
        <ErrorState
          onRetry={() => void overview.refetch()}
          reason={overview.error.message}
          title="Performance data could not be loaded"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              description={`Availability across managed devices · ${meta ? granularityLabel(meta.granularity) : "rollups"}`}
              icon={HeartPulse}
              label="Avg Availability"
              loading={!data}
              status={
                kpis === undefined
                  ? undefined
                  : kpis.avgAvailabilityPct >= 99.9
                    ? { label: "on target", token: "success" }
                    : kpis.avgAvailabilityPct >= 99
                      ? { label: "watch", token: "warning" }
                      : { label: "below target", token: "danger" }
              }
              value={fmtPct(kpis?.avgAvailabilityPct)}
            />
            <KpiCard
              description="95th percentile of device latency"
              icon={Timer}
              label="Latency p95"
              loading={!data}
              value={fmtMs(kpis?.p95LatencyMs)}
            />
            <KpiCard
              description="Fleet average CPU"
              icon={Cpu}
              label="CPU Avg"
              loading={!data}
              value={fmtPct(kpis?.avgCpuPct)}
            />
            <KpiCard
              description="Fleet average memory"
              icon={MemoryStick}
              label="Memory Avg"
              loading={!data}
              value={fmtPct(kpis?.avgMemoryPct)}
            />
            <KpiCard
              description="Interface in + out average"
              icon={Activity}
              label="Avg Utilization"
              loading={!data}
              value={fmtPct(kpis?.avgUtilizationPct)}
            />
            <KpiCard
              description="Fleet-wide packet loss"
              icon={ArrowDownUp}
              label="Packet Loss"
              loading={!data}
              value={fmtPct(kpis?.packetLossPct, 2)}
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <AvailabilityCard
              loading={overview.isLoading}
              range={range}
              series={data?.series ?? []}
            />
            <LatencyCard
              loading={overview.isLoading}
              range={range}
              series={data?.series ?? []}
            />
          </div>

          {/* Top utilizers + health */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
            <TopUtilizersCard
              className="md:col-span-2 xl:col-span-8"
              loading={!data}
              utilizers={data?.topUtilizers ?? []}
            />
            <HealthSliceCard
              distribution={data?.healthDistribution}
              loading={!data}
            />
          </div>

          {/* Retention panel */}
          <RetentionPanel />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

function AvailabilityCard({
  loading,
  range,
  series,
}: {
  loading: boolean;
  range: PerfRange;
  series: PerfOverviewPoint[];
}) {
  const colors = useTokenColors();
  const points = series.filter((p) => p.availabilityPct !== undefined);
  const values = points.map((p) => p.availabilityPct as number);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const domainMin = Math.max(0, Math.floor(min) - 2);

  return (
    <SectionCard
      contentClassName="pt-4"
      title="Availability"
      description={`Share of managed devices reachable — ${perfRangeLabel(range)}`}
    >
      {loading ? (
        <WidgetSkeleton className="h-[260px]" rows={6} />
      ) : points.length === 0 ? (
        <ChartEmpty range={range} />
      ) : (
        <div
          aria-label={`Availability trend, averaged ${values.length > 0 ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : "—"} percent over ${perfRangeLabel(range)}.`}
          role="img"
        >
          <ResponsiveContainer height={260} width="100%">
            <AreaChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
            >
              <defs>
                <linearGradient id="perfAvailFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={colors.success} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={colors.success} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke={colors.border}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="ts"
                minTickGap={40}
                stroke={colors.mutedForeground}
                tick={{ fontSize: 11 }}
                tickFormatter={perfTickFormatter(range)}
                tickLine={false}
              />
              <YAxis
                domain={[domainMin, 100]}
                stroke={colors.mutedForeground}
                tick={{ fontSize: 11 }}
                tickFormatter={(value: number) => `${value}%`}
                tickLine={false}
                width={56}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number | string) => [`${Number(value).toFixed(2)}%`, "Availability"]}
                labelFormatter={(ts: string) => format(new Date(ts), "EEE, MMM d — HH:mm")}
              />
              <Area
                connectNulls
                dataKey="availabilityPct"
                dot={false}
                fill="url(#perfAvailFill)"
                name="availabilityPct"
                stroke={colors.success}
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionCard>
  );
}

function LatencyCard({
  loading,
  range,
  series,
}: {
  loading: boolean;
  range: PerfRange;
  series: PerfOverviewPoint[];
}) {
  const colors = useTokenColors();
  const points = series.filter((p) => p.latencyP95 !== undefined);
  const values = points.map((p) => p.latencyP95 as number);

  return (
    <SectionCard
      contentClassName="pt-4"
      title="Latency p95"
      description={`95th-percentile round-trip latency — ${perfRangeLabel(range)}`}
    >
      {loading ? (
        <WidgetSkeleton className="h-[260px]" rows={6} />
      ) : points.length === 0 ? (
        <ChartEmpty range={range} />
      ) : (
        <div
          aria-label={`Latency p95 trend, peaking at ${values.length > 0 ? Math.round(Math.max(...values)) : 0} milliseconds over ${perfRangeLabel(range)}.`}
          role="img"
        >
          <ResponsiveContainer height={260} width="100%">
            <LineChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
            >
              <CartesianGrid
                stroke={colors.border}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="ts"
                minTickGap={40}
                stroke={colors.mutedForeground}
                tick={{ fontSize: 11 }}
                tickFormatter={perfTickFormatter(range)}
                tickLine={false}
              />
              <YAxis
                stroke={colors.mutedForeground}
                tick={{ fontSize: 11 }}
                tickFormatter={(value: number) => `${value} ms`}
                tickLine={false}
                width={56}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number | string) => [`${Math.round(Number(value))} ms`, "Latency p95"]}
                labelFormatter={(ts: string) => format(new Date(ts), "EEE, MMM d — HH:mm")}
              />
              <Line
                connectNulls
                dataKey="latencyP95"
                dot={false}
                name="latencyP95"
                stroke={colors.accent}
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionCard>
  );
}

function ChartEmpty({ range }: { range: PerfRange }) {
  return (
    <EmptyState
      className="border-none bg-transparent py-8"
      description={
        range === "1H"
          ? "Raw samples are still being collected — try a longer range."
          : "No rollups cover this window yet. Longer ranges fill in as the retention engine aggregates."
      }
      icon={Gauge}
      title={`No data for the last ${perfRangeLabel(range)}`}
    />
  );
}

export function perfRangeLabel(range: PerfRange): string {
  switch (range) {
    case "1H":
      return "last hour";
    case "24H":
      return "last 24 hours";
    case "7D":
      return "last 7 days";
    case "30D":
      return "last 30 days";
  }
}

/* ------------------------------------------------------------------ */
/* Top utilizers + health                                              */
/* ------------------------------------------------------------------ */

function TopUtilizersCard({
  className,
  loading,
  utilizers,
}: {
  className?: string;
  loading: boolean;
  utilizers: PerfOverviewResult["data"]["topUtilizers"];
}) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <SectionCard
      className={className}
      contentClassName="p-0"
      description="Interfaces with the highest average utilization — click a device to inspect"
      title="Top Utilizers"
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : utilizers.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description="No interface utilization rollups for this window yet."
            icon={Activity}
            title="No utilization data"
          />
        </div>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {utilizers.map((utilizer) => {
            const tone =
              utilizer.utilPct > 80
                ? "bg-danger"
                : utilizer.utilPct > 60
                  ? "bg-warning"
                  : "bg-primary";
            return (
              <li key={utilizer.deviceId} className="border-b last:border-0">
                <button
                  className="flex w-full flex-col gap-1.5 px-4 py-2.5 text-start transition-colors hover:bg-accent/50"
                  onClick={() =>
                    setActiveView("network.device-detail", {
                      deviceId: utilizer.deviceId,
                    })
                  }
                  type="button"
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-tech text-sm ltr-technical"
                      title={utilizer.hostname}
                    >
                      {utilizer.hostname}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {utilizer.siteCode}
                    </span>
                    <span className="w-14 shrink-0 text-end text-sm font-medium tabular-nums">
                      {fmtPct(utilizer.utilPct)}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className={cn("block h-full rounded-full", tone)}
                      style={{ width: `${Math.min(100, utilizer.utilPct)}%` }}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function HealthSliceCard({
  distribution,
  loading,
}: {
  distribution: PerfHealthDistribution | undefined;
  loading: boolean;
}) {
  const slices: HealthSlice[] = distribution
    ? Object.entries(distribution).map(([status, count]) => ({
        status,
        count: count ?? 0,
      }))
    : [];
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);

  return (
    <HealthDistributionCard
      data={slices}
      loading={loading}
      total={total}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Retention panel                                                     */
/* ------------------------------------------------------------------ */

const TIER_ROWS: { key: RetentionTierKey; label: string; hint: string }[] = [
  {
    key: "raw",
    label: "Raw samples",
    hint: "Collector-resolution MetricSample rows",
  },
  {
    key: "rollup5M",
    label: "5-minute rollups",
    hint: "Fine-grained aggregates powering 1H/24H views",
  },
  {
    key: "rollup1H",
    label: "Hourly rollups",
    hint: "Powers 7-day dashboards",
  },
  {
    key: "rollup1D",
    label: "Daily rollups",
    hint: "Powers 30-day views and capacity forecasts",
  },
];

function RetentionPanel() {
  const retention = useMetricsRetention();
  const save = useSaveMetricsRetention();
  const prune = usePruneMetricsRetention();
  const [overrides, setOverrides] = useState<
    Partial<Record<RetentionTierKey, RetentionTierConfig>>
  >({});
  const [pruneOpen, setPruneOpen] = useState(false);

  const server = retention.data;
  const getValue = (key: RetentionTierKey): RetentionTierConfig =>
    overrides[key] ?? server?.[key] ?? { days: 0, enabled: false };

  const dirty =
    server !== undefined &&
    TIER_ROWS.some(({ key }) => {
      const override = overrides[key];
      return (
        override !== undefined &&
        (override.days !== server[key].days ||
          override.enabled !== server[key].enabled)
      );
    });

  const setOverride = (key: RetentionTierKey, patch: Partial<RetentionTierConfig>) => {
    setOverrides((current) => ({
      ...current,
      [key]: { ...getValue(key), ...patch },
    }));
  };

  const handleSave = () => {
    if (!server) return;
    save.mutate({
      raw: getValue("raw"),
      rollup5M: getValue("rollup5M"),
      rollup1H: getValue("rollup1H"),
      rollup1D: getValue("rollup1D"),
    });
  };

  const lastPrune = server?.lastPruneResult ?? null;

  return (
    <SectionCard
      contentClassName="p-0"
      description="How long raw samples and rollups are kept before the pruning job deletes them"
      title="Metrics Retention"
      actions={
        <>
          {dirty && (
            <Button
              onClick={() => setOverrides({})}
              size="sm"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </Button>
          )}
          <Button
            disabled={!server || !dirty || save.isPending}
            onClick={handleSave}
            size="sm"
          >
            <Save aria-hidden="true" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            onClick={() => setPruneOpen(true)}
            size="sm"
            variant="outline"
          >
            <Trash2 aria-hidden="true" />
            Prune now
          </Button>
        </>
      }
    >
      {retention.isError ? (
        <div className="p-4">
          <ErrorState
            onRetry={() => void retention.refetch()}
            reason={retention.error.message}
            title="Retention settings could not be loaded"
          />
        </div>
      ) : retention.isLoading || !server ? (
        <div className="flex flex-col gap-2 p-4">
          {TIER_ROWS.map((tier) => (
            <div
              className="h-11 animate-pulse rounded-md bg-muted/60"
              key={tier.key}
            />
          ))}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <ul role="list">
            {TIER_ROWS.map(({ key, label, hint }) => {
              const value = getValue(key);
              return (
                <li
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-0"
                  key={key}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label
                      className="sr-only"
                      htmlFor={`retention-days-${key}`}
                    >
                      {label} retention in days
                    </Label>
                    <Input
                      className="h-8 w-24 tabular-nums"
                      disabled={!value.enabled}
                      id={`retention-days-${key}`}
                      min={1}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        setOverride(key, {
                          days:
                            Number.isFinite(parsed) && parsed >= 1
                              ? Math.floor(parsed)
                              : 1,
                        });
                      }}
                      type="number"
                      value={value.days}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </div>
                  <div className="flex w-28 items-center justify-end gap-2">
                    <Switch
                      aria-label={`${label} retention ${value.enabled ? "enabled" : "disabled"}`}
                      checked={value.enabled}
                      onCheckedChange={(checked) =>
                        setOverride(key, { enabled: checked })
                      }
                    />
                    <span
                      className={cn(
                        "text-xs font-medium",
                        value.enabled ? "text-success" : "text-muted-foreground"
                      )}
                    >
                      {value.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Prune confirmation + last-run bookkeeping */}
      <AlertDialog onOpenChange={setPruneOpen} open={pruneOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prune expired metrics now?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes raw samples and rollups older than their retention
              windows. Pruning is permanent — the deleted history cannot be
              recovered. A re-run within 60 seconds is rejected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {server?.lastPrunedAt && (
            <p className="text-xs text-muted-foreground">
              Last prune ran{" "}
              <span className="font-medium text-foreground">
                {formatDistanceToNow(new Date(server.lastPrunedAt), {
                  addSuffix: true,
                })}
              </span>
              {lastPrune
                ? ` — deleted ${lastPrune.metricSamplesDeleted.toLocaleString()} samples, ${lastPrune.rollup5MDeleted.toLocaleString()} 5-min, ${lastPrune.rollup1HDeleted.toLocaleString()} 1-hour and ${lastPrune.rollup1DDeleted.toLocaleString()} 1-day rollups in ${(lastPrune.durationMs / 1000).toFixed(1)} s`
                : ""}
            </p>
          )}
          {!server?.lastPrunedAt && (
            <p className="text-xs text-muted-foreground">
              Pruning has not run yet.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={prune.isPending}
              onClick={() => prune.mutate()}
            >
              {prune.isPending ? "Pruning…" : "Prune now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
