"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
import { ChartSummary } from "@/components/domain/chart-summary";
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

/**
 * Structural translator type for the shared keyed helpers (R81
 * metricLabel precedent). Callers pass their `useTranslations()
 * ("perfOverview")` translator; sibling views keep a `tRange` hook for
 * exactly this purpose.
 */
type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

// Chip labels are locale-neutral technical range tokens (1H/24H/7D/30D
// — the v{version} precedent); the localized long forms live under
// perfOverview.range.* via perfRangeLabel below.
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
  const t = useTranslations("perfOverview");
  return (
    <div
      aria-label={t("chips.ariaLabel")}
      className={cn("flex items-center gap-1 rounded-lg border bg-card p-1", className)}
      role="group"
    >
      {PERF_RANGES.map((range) => (
        <button
          aria-pressed={value === range.value}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === range.value
              ? "bg-primary/10 text-primary-ink"
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

/** Percent formatting with a trailing % and stable decimals.
 * Survivors: the % unit and the em-dash empty placeholder are
 * locale-neutral technical tokens (fmtSpeed/fmtMetric precedent). */
export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** Millisecond formatting. */
export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value)} ms`;
}

/** Human label for the rollup granularity reported in meta (keyed R85). */
export function granularityLabel(granularity: string | undefined, t: TranslateFn): string {
  switch (granularity) {
    case "5M":
      return t("granularity.5M");
    case "1H":
      return t("granularity.1H");
    case "1D":
      return t("granularity.1D");
    case "RAW":
      return t("granularity.RAW");
    default:
      return granularity
        ? t("granularity.buckets", { unit: granularity.toLowerCase() })
        : t("granularity.fallback");
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
  const t = useTranslations("perfOverview");
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
            {t("updated")}{" "}
            {overview.dataUpdatedAt
              ? format(overview.dataUpdatedAt, "HH:mm:ss")
              : "—"}
          </span>
        }
        description={t("description")}
        primaryAction={
          <PerfRangeChips onChange={setRange} value={range} />
        }
        title={t("title")}
      />

      {overview.isError ? (
        <ErrorState
          onRetry={() => void overview.refetch()}
          reason={overview.error.message}
          title={t("error.title")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              description={t("kpi.availability.description", {
                granularity: meta
                  ? granularityLabel(meta.granularity, t)
                  : t("granularity.fallback"),
              })}
              icon={HeartPulse}
              label={t("kpi.availability.label")}
              loading={!data}
              status={
                kpis === undefined
                  ? undefined
                  : kpis.avgAvailabilityPct >= 99.9
                    ? { label: t("kpi.status.onTarget"), token: "success" }
                    : kpis.avgAvailabilityPct >= 99
                      ? { label: t("kpi.status.watch"), token: "warning" }
                      : { label: t("kpi.status.below"), token: "danger" }
              }
              value={fmtPct(kpis?.avgAvailabilityPct)}
            />
            <KpiCard
              description={t("kpi.latency.description")}
              icon={Timer}
              label={t("kpi.latency.label")}
              loading={!data}
              value={fmtMs(kpis?.p95LatencyMs)}
            />
            <KpiCard
              description={t("kpi.cpu.description")}
              icon={Cpu}
              label={t("kpi.cpu.label")}
              loading={!data}
              value={fmtPct(kpis?.avgCpuPct)}
            />
            <KpiCard
              description={t("kpi.memory.description")}
              icon={MemoryStick}
              label={t("kpi.memory.label")}
              loading={!data}
              value={fmtPct(kpis?.avgMemoryPct)}
            />
            <KpiCard
              description={t("kpi.utilization.description")}
              icon={Activity}
              label={t("kpi.utilization.label")}
              loading={!data}
              value={fmtPct(kpis?.avgUtilizationPct)}
            />
            <KpiCard
              description={t("kpi.packetLoss.description")}
              icon={ArrowDownUp}
              label={t("kpi.packetLoss.label")}
              loading={!data}
              value={fmtPct(kpis?.packetLossPct, 2)}
            />
          </div>

          {/* Charts row */}
          <div
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            data-tour="perf-charts"
          >
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
  const t = useTranslations("perfOverview");
  const colors = useTokenColors();
  const points = series.filter((p) => p.availabilityPct !== undefined);
  const values = points.map((p) => p.availabilityPct as number);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const domainMin = Math.max(0, Math.floor(min) - 2);
  // Chart stats are computed once; the defensive "—" empty fallback stays
  // a code-side locale-neutral token (fmtPct precedent) — this branch only
  // renders when points.length > 0.
  const avg =
    values.length > 0
      ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)
      : "—";
  const lowest = values.length > 0 ? Math.min(...values).toFixed(2) : "—";
  const highest = values.length > 0 ? Math.max(...values).toFixed(2) : "—";
  const rangeLabel = perfRangeLabel(range, t);

  return (
    <SectionCard
      contentClassName="pt-4"
      title={t("availability.title")}
      description={t("availability.description", { range: rangeLabel })}
    >
      {loading ? (
        <WidgetSkeleton className="h-[260px]" rows={6} />
      ) : points.length === 0 ? (
        <ChartEmpty range={range} />
      ) : (
        <ChartSummary
          aria-label={t("availability.chartAria", { avg, range: rangeLabel })}
          summary={t("availability.chartSummary", {
            count: points.length,
            range: rangeLabel,
            lowest,
            highest,
          })}
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
                formatter={(value: number | string) => [`${Number(value).toFixed(2)}%`, t("availability.tooltip")]}
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
        </ChartSummary>
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
  const t = useTranslations("perfOverview");
  const colors = useTokenColors();
  const points = series.filter((p) => p.latencyP95 !== undefined);
  const values = points.map((p) => p.latencyP95 as number);
  const peak = values.length > 0 ? Math.round(Math.max(...values)) : 0;
  const highest = values.length > 0 ? Math.round(Math.max(...values)) : 0;
  const rangeLabel = perfRangeLabel(range, t);

  return (
    <SectionCard
      contentClassName="pt-4"
      title={t("latency.title")}
      description={t("latency.description", { range: rangeLabel })}
    >
      {loading ? (
        <WidgetSkeleton className="h-[260px]" rows={6} />
      ) : points.length === 0 ? (
        <ChartEmpty range={range} />
      ) : (
        <ChartSummary
          aria-label={t("latency.chartAria", { peak, range: rangeLabel })}
          summary={t("latency.chartSummary", {
            count: points.length,
            range: rangeLabel,
            highest,
          })}
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
                formatter={(value: number | string) => [`${Math.round(Number(value))} ms`, t("latency.tooltip")]}
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
        </ChartSummary>
      )}
    </SectionCard>
  );
}

function ChartEmpty({ range }: { range: PerfRange }) {
  const t = useTranslations("perfOverview");
  return (
    <EmptyState
      className="border-none bg-transparent py-8"
      description={range === "1H" ? t("empty.raw") : t("empty.rollups")}
      icon={Gauge}
      title={t("empty.title", { range: perfRangeLabel(range, t) })}
    />
  );
}

export function perfRangeLabel(range: PerfRange, t: TranslateFn): string {
  switch (range) {
    case "1H":
      return t("range.1H");
    case "24H":
      return t("range.24H");
    case "7D":
      return t("range.7D");
    case "30D":
      return t("range.30D");
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
  const t = useTranslations("perfOverview");

  return (
    <SectionCard
      className={className}
      contentClassName="p-0"
      description={t("utilizers.description")}
      title={t("utilizers.title")}
    >
      {loading ? (
        <div className="p-4">
          <WidgetSkeleton rows={5} />
        </div>
      ) : utilizers.length === 0 ? (
        <div className="p-4">
          <EmptyState
            className="border-none bg-transparent py-8"
            description={t("utilizers.emptyDescription")}
            icon={Activity}
            title={t("utilizers.emptyTitle")}
          />
        </div>
      ) : (
        <ul tabIndex={0} className="max-h-96 overflow-y-auto">
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

// Tier keys double as dictionary keys (R81 GROUPS dynamic-key precedent):
// labels/hints resolve via t(`retention.tier.${key}.label|.hint`) at render.
const TIER_KEYS: RetentionTierKey[] = ["raw", "rollup5M", "rollup1H", "rollup1D"];

function RetentionPanel() {
  const t = useTranslations("perfOverview");
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
    TIER_KEYS.some((key) => {
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
      description={t("retention.description")}
      title={t("retention.title")}
      actions={
        <>
          {dirty && (
            <Button
              onClick={() => setOverrides({})}
              size="sm"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" />
              {t("retention.reset")}
            </Button>
          )}
          <Button
            disabled={!server || !dirty || save.isPending}
            onClick={handleSave}
            size="sm"
          >
            <Save aria-hidden="true" />
            {save.isPending ? t("retention.saving") : t("retention.save")}
          </Button>
          <Button
            onClick={() => setPruneOpen(true)}
            size="sm"
            variant="outline"
          >
            <Trash2 aria-hidden="true" />
            {t("retention.pruneNow")}
          </Button>
        </>
      }
    >
      {retention.isError ? (
        <div className="p-4">
          <ErrorState
            onRetry={() => void retention.refetch()}
            reason={retention.error.message}
            title={t("retention.error.title")}
          />
        </div>
      ) : retention.isLoading || !server ? (
        <div className="flex flex-col gap-2 p-4">
          {TIER_KEYS.map((key) => (
            <div
              className="h-11 animate-pulse rounded-md bg-muted/60"
              key={key}
            />
          ))}
        </div>
      ) : (
        <div tabIndex={0} className="max-h-96 overflow-y-auto">
          <ul role="list">
            {TIER_KEYS.map((key) => {
              const value = getValue(key);
              const tierLabel = t(`retention.tier.${key}.label`);
              return (
                <li
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-0"
                  key={key}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{tierLabel}</p>
                    <p className="text-xs text-muted-foreground">{t(`retention.tier.${key}.hint`)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label
                      className="sr-only"
                      htmlFor={`retention-days-${key}`}
                    >
                      {t("retention.daysAria", { tier: tierLabel })}
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
                    <span className="text-xs text-muted-foreground">{t("retention.daysUnit")}</span>
                  </div>
                  <div className="flex w-28 items-center justify-end gap-2">
                    <Switch
                      aria-label={t("retention.switchAria", {
                        tier: tierLabel,
                        state: value.enabled
                          ? t("retention.state.enabled")
                          : t("retention.state.disabled"),
                      })}
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
                      {value.enabled ? t("retention.active") : t("retention.paused")}
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
            <AlertDialogTitle>{t("retention.pruneTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("retention.pruneDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {server?.lastPrunedAt && (
            <p className="text-xs text-muted-foreground">
              {t("retention.lastRan")}{" "}
              <span className="font-medium text-foreground">
                {/* date-fns English relative time — no ar locale wired anywhere
                    (device-config-tab / R83 / R84 precedent, documented survivor). */}
                {formatDistanceToNow(new Date(server.lastPrunedAt), {
                  addSuffix: true,
                })}
              </span>
              {lastPrune
                ? t("retention.lastRunStats", {
                    samples: lastPrune.metricSamplesDeleted.toLocaleString(),
                    m5: lastPrune.rollup5MDeleted.toLocaleString(),
                    h1: lastPrune.rollup1HDeleted.toLocaleString(),
                    d1: lastPrune.rollup1DDeleted.toLocaleString(),
                    seconds: (lastPrune.durationMs / 1000).toFixed(1),
                  })
                : ""}
            </p>
          )}
          {!server?.lastPrunedAt && (
            <p className="text-xs text-muted-foreground">
              {t("retention.neverRan")}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("retention.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={prune.isPending}
              onClick={() => prune.mutate()}
            >
              {prune.isPending ? t("retention.pruning") : t("retention.pruneNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
