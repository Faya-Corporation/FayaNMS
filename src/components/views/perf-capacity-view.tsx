"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import {
  ChevronRight,
  CircleCheck,
  LineChart,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import { usePerformanceCapacity } from "@/hooks/api/use-performance";
import { ChartSummary } from "@/components/domain/chart-summary";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { useTokenColors } from "@/components/dashboard/use-token-colors";
import { cn } from "@/lib/utils";
import type {
  CapacityForecastPoint,
  CapacityRiskRow,
  PerfRange,
} from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { PerfRangeChips, fmtPct, perfRangeLabel } from "./perf-overview-view";

const HORIZON_PCT = 80;
const HORIZON_DAYS = 90;

function metricLabel(metric: string): string {
  switch (metric) {
    case "CPU":
      return "CPU";
    case "MEMORY":
      return "Memory";
    case "LATENCY_MS":
      return "Latency";
    case "PACKET_LOSS":
      return "Packet loss";
    case "UTILIZATION_IN":
      return "Utilization (in)";
    case "UTILIZATION_OUT":
      return "Utilization (out)";
    default:
      return metric;
  }
}

function riskKey(risk: CapacityRiskRow): string {
  return `${risk.deviceId}:${risk.metric}`;
}

function fmtSlope(metric: string, slope: number): string {
  const sign = slope > 0 ? "+" : "";
  return metric === "LATENCY_MS"
    ? `${sign}${slope.toFixed(2)} ms/d`
    : `${sign}${slope.toFixed(2)}%/d`;
}

function fmtCurrent(metric: string, value: number): string {
  return metric === "LATENCY_MS" ? `${Math.round(value)} ms` : fmtPct(value);
}

/**
 * Capacity (Task 6-b / upgraded Phase 13-c): forecast v2 = least-squares
 * linear trend + weekly-seasonality factor + residual confidence band over
 * 1D rollups. Risk list (days-to-threshold ascending, semantics unchanged)
 * + selectable forecast chart with the shaded 80% band and horizon line.
 */
export function PerfCapacityView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const t = useTranslations("capacity");
  const [range, setRange] = useState<PerfRange>("30D");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const capacity = usePerformanceCapacity({
    range,
    horizonPct: HORIZON_PCT,
    horizonDays: HORIZON_DAYS,
  });
  const data = capacity.data?.data;
  const risks = data?.risks ?? [];
  const summary = data?.summary;

  const selected = useMemo(
    () => risks.find((risk) => riskKey(risk) === selectedKey) ?? null,
    [risks, selectedKey]
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={t("methodNote")}
        primaryAction={<PerfRangeChips onChange={(next) => { setRange(next); setSelectedKey(null); }} value={range} />}
        title="Capacity"
      />

      {/* Summary chips */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          className={cn(summary && summary.atRisk30d > 0 && "border-danger/40")}
          description="Cross the 80% horizon within a month"
          icon={ShieldAlert}
          label="At risk ≤ 30 days"
          loading={!data}
          status={
            summary === undefined
              ? undefined
              : summary.atRisk30d > 0
                ? { label: "action needed", token: "danger" }
                : { label: "clear", token: "success" }
          }
          value={summary?.atRisk30d ?? "—"}
        />
        <KpiCard
          description="Cross the 80% horizon within a quarter"
          icon={TriangleAlert}
          label="At risk ≤ 90 days"
          loading={!data}
          status={
            summary === undefined
              ? undefined
              : summary.atRisk90d > 0
                ? { label: "watch", token: "warning" }
                : { label: "clear", token: "success" }
          }
          value={summary?.atRisk90d ?? "—"}
        />
        <KpiCard
          description="No threshold crossing forecast in 90 days"
          icon={CircleCheck}
          label="Healthy"
          loading={!data}
          value={summary?.noRisk ?? "—"}
        />
      </div>

      {capacity.isError ? (
        <ErrorState
          onRetry={() => void capacity.refetch()}
          reason={capacity.error.message}
          title="Capacity forecast could not be loaded"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* Risk table */}
          <SectionCard
            className="xl:col-span-7"
            contentClassName="p-0"
            description={`Sorted by days-to-threshold ascending — ${risks.length} tracked series`}
            title="Capacity Risks"
          >
            {capacity.isLoading ? (
              <div className="p-4">
                <WidgetSkeleton rows={6} />
              </div>
            ) : risks.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  className="border-none bg-transparent py-8"
                  description="No tracked series is forecast to cross the 80% horizon within 90 days."
                  icon={CircleCheck}
                  title="No capacity risks"
                />
              </div>
            ) : (
              <div className="max-h-[560px] overflow-auto">
                <table
                  aria-label={`Capacity risks — days to cross the ${HORIZON_PCT} percent horizon, ${risks.length} tracked series`}
                  className="w-full min-w-[640px] text-sm"
                >
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-start font-medium" scope="col">Device / Metric</th>
                      <th className="px-4 py-2 text-end font-medium" scope="col">Current</th>
                      <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">Slope</th>
                      <th className="px-4 py-2 text-end font-medium" scope="col">Horizon</th>
                      <th className="hidden px-4 py-2 text-end font-medium md:table-cell" scope="col">Confidence</th>
                      <th className="w-10 px-2 py-2">
                        <span className="sr-only">Inspect forecast</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {risks.map((risk) => (
                      <tr
                        aria-selected={selectedKey === riskKey(risk)}
                        className={cn(
                          "border-b transition-colors last:border-0 hover:bg-accent/50",
                          selectedKey === riskKey(risk) && "bg-accent/60"
                        )}
                        key={riskKey(risk)}
                        onClick={() => setSelectedKey(riskKey(risk))}
                        onKeyDown={(event) => {
                          // Keyboard parity for the click-to-inspect row
                          // (the chevron button below is the labeled path).
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedKey(riskKey(risk));
                          }
                        }}
                        tabIndex={0}
                      >
                        <td className="px-4 py-2">
                          <button
                            className="flex flex-col items-start gap-0.5 text-start"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveView("network.device-detail", {
                                deviceId: risk.deviceId,
                              });
                            }}
                            type="button"
                          >
                            <span
                              className="max-w-[220px] truncate font-tech text-sm text-primary hover:underline ltr-technical"
                              title={risk.hostname}
                            >
                              {risk.hostname}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {risk.siteCode} · {metricLabel(risk.metric)}
                            </span>
                          </button>
                          <span className="sr-only"> — open device detail</span>
                        </td>
                        <td className="px-4 py-2 text-end font-medium tabular-nums">
                          {fmtCurrent(risk.metric, risk.current)}
                        </td>
                        <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
                          {fmtSlope(risk.metric, risk.slopePerDay)}
                        </td>
                        <td className="px-4 py-2 text-end">
                          <DaysToThresholdChip days={risk.daysToThreshold} />
                        </td>
                        <td className="hidden px-4 py-2 text-end md:table-cell">
                          <ConfidenceBadge confidence={risk.confidence} />
                        </td>
                        <td className="px-2 py-2 text-end">
                          <button
                            aria-label={`Inspect forecast for ${risk.hostname} ${metricLabel(risk.metric)}`}
                            className={cn(
                              "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                              selectedKey === riskKey(risk) && "text-primary"
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedKey(riskKey(risk));
                            }}
                            type="button"
                          >
                            <ChevronRight aria-hidden="true" className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {/* Forecast chart */}
          <SectionCard
            className="xl:col-span-5"
            contentClassName="pt-4"
            description={
              selected
                ? `${selected.hostname} · ${metricLabel(selected.metric)}`
                : "Select a risk row to inspect its forecast"
            }
            title="Forecast"
          >
            {!selected ? (
              <EmptyState
                className="border-none bg-transparent py-10"
                description="Pick a device + metric from the risk table to see its history, the v2 forecast (trend + weekly seasonality) with an 80% confidence band and the 80% horizon."
                icon={LineChart}
                title="No series selected"
              />
            ) : (
              <ForecastChart horizonPct={data?.horizonPct ?? HORIZON_PCT} risk={selected} />
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function DaysToThresholdChip({ days }: { days: number | null }) {
  if (days === null) {
    return (
      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        stable
      </span>
    );
  }
  const rounded = Math.max(0, Math.round(days));
  const tone =
    rounded < 30
      ? "bg-danger-subtle text-danger"
      : rounded < 90
        ? "bg-warning-subtle text-warning"
        : "bg-success-subtle text-success";
  return (
    <span
      className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums", tone)}
    >
      {rounded} d
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone =
    confidence === "HIGH"
      ? "bg-success-subtle text-success"
      : confidence === "MEDIUM"
        ? "bg-warning-subtle text-warning"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}
    >
      {confidence}
    </span>
  );
}

/* ───────────────────── Forecast v2 model (Phase 13-c) ───────────────────── */

interface ForecastChartRow {
  ts: string;
  value: number | null;
  forecast: number | null;
  /** Stacked-area band trick: lower bound, then upper−lower as the span. */
  bandBase: number | null;
  bandSpan: number | null;
}

interface ForecastV2 {
  rows: ForecastChartRow[];
  sigma: number;
  seasonalityActive: boolean;
}

/**
 * Forecast v2 — dependency-free, computed from the 1D history:
 *
 *   1. Linear trend: least-squares slope/intercept of value vs time (days).
 *   2. Weekly seasonality: mean ratio actual/trend per weekday bucket
 *      (Date.getUTCDay, 0–6), normalized to mean 1. Activated only when
 *      the history spans ≥ 14 days (every weekday observed more than once)
 *      — shorter histories would treat noise as seasonality.
 *   3. Residual σ: population standard deviation of (actual − fitted)
 *      where fitted = trend × season, floored at 0.5% of the mean level.
 *   4. Confidence band: ±1.28σ ≈ 80% interval around each forecast day.
 *
 * The crossing-day semantics of the frozen linear model are preserved:
 * the forecast line still terminates at (lastTs + daysToThreshold,
 * horizonPct); intermediate days wiggle with the seasonal factor.
 */
function computeForecastV2(
  series: CapacityForecastPoint[],
  daysToThreshold: number | null,
  horizonPct: number
): ForecastV2 | null {
  const n = series.length;
  if (n < 4 || daysToThreshold === null) return null;

  const dayMs = 86_400_000;
  const t0 = Date.parse(series[0].ts);
  const xs = series.map((p) => (Date.parse(p.ts) - t0) / dayMs);
  const ys = series.map((p) => p.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const trendAt = (x: number) => Math.max(0, intercept + slope * x);

  // Weekly seasonality: mean actual/trend ratio per weekday bucket.
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  for (let i = 0; i < n; i += 1) {
    const base = trendAt(xs[i]);
    if (base > 0) {
      const wd = new Date(series[i].ts).getUTCDay();
      buckets[wd].sum += ys[i] / base;
      buckets[wd].count += 1;
    }
  }
  const seasonalityActive = n >= 14;
  let season = [1, 1, 1, 1, 1, 1, 1];
  if (seasonalityActive) {
    const raw = buckets.map((b) => (b.count > 0 ? b.sum / b.count : 1));
    const rawMean = raw.reduce((a, b) => a + b, 0) / 7;
    if (rawMean > 0) season = raw.map((r) => r / rawMean);
  }

  // Residual σ around the v2 fitted values, floored so smooth series
  // still render a visible (thin) band instead of a zero-width sliver.
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const wd = new Date(series[i].ts).getUTCDay();
    const fitted = trendAt(xs[i]) * season[wd];
    sse += (ys[i] - fitted) ** 2;
  }
  const sigma = Math.max(Math.sqrt(sse / n), meanY * 0.005, 1e-6);

  // Forecast rows: seasonal values on each whole day after the last
  // history point, then the crossing point anchored at horizonPct on the
  // exact (possibly fractional) linear-model crossing date.
  const lastTs = Date.parse(series[n - 1].ts);
  const crossingTs = lastTs + daysToThreshold * dayMs;
  const wholeDays = Math.max(0, Math.floor(daysToThreshold));
  const rows: ForecastChartRow[] = [];

  const bandFor = (value: number) => ({
    bandBase: Math.max(0, value - 1.28 * sigma),
    bandSpan: 2 * 1.28 * sigma,
  });

  for (let d = 1; d <= wholeDays; d += 1) {
    const ts = lastTs + d * dayMs;
    const wd = new Date(ts).getUTCDay();
    const x = (ts - t0) / dayMs;
    const value = Math.max(0, trendAt(x) * season[wd]);
    rows.push({
      ts: new Date(ts).toISOString(),
      value: null,
      forecast: value,
      ...bandFor(value),
    });
  }
  const crossingValue = horizonPct;
  rows.push({
    ts: new Date(crossingTs).toISOString(),
    value: null,
    forecast: crossingValue,
    ...bandFor(crossingValue),
  });

  // Connect the v2 line to the last observed value for visual continuity.
  const history: ForecastChartRow[] = series.map((p) => ({
    ts: p.ts,
    value: p.value,
    forecast: null,
    bandBase: null,
    bandSpan: null,
  }));
  const lastHistory = history[history.length - 1];
  if (lastHistory) lastHistory.forecast = lastHistory.value;
  if (rows.length > 0) history.push(...rows);

  return { rows: history, sigma, seasonalityActive };
}

/** Custom tooltip: shows history / forecast values and the band range,
 *  and hides the raw stacked band helper series from the default payload. */
function forecastTooltipContent(
  risk: CapacityRiskRow,
  labels: { forecast: string; band: string }
) {
  return function renderForecastTooltip(props: TooltipProps<number, string>) {
    const { active, payload, label } = props;
    if (!active || !payload || payload.length === 0) return null;
    const row = payload[0]?.payload as ForecastChartRow | undefined;
    if (!row) return null;
    return (
      <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-e2">
        <p className="font-medium text-foreground">
          {format(new Date(String(label)), "EEE, MMM d, HH:mm")}
        </p>
        {row.value !== null && (
          <p className="mt-1 text-muted-foreground">
            {metricLabel(risk.metric)}:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {fmtCurrent(risk.metric, row.value)}
            </span>
          </p>
        )}
        {row.forecast !== null && (
          <p className="mt-1 text-muted-foreground">
            {labels.forecast}:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {fmtCurrent(risk.metric, row.forecast)}
            </span>
          </p>
        )}
        {row.forecast !== null && row.bandBase !== null && row.bandSpan !== null && (
          <p className="mt-0.5 text-muted-foreground">
            {labels.band}:{" "}
            <span className="tabular-nums">
              {fmtCurrent(risk.metric, row.bandBase)} –{" "}
              {fmtCurrent(risk.metric, row.bandBase + row.bandSpan)}
            </span>
          </p>
        )}
      </div>
    );
  };
}

function ForecastChart({
  horizonPct,
  risk,
}: {
  horizonPct: number;
  risk: CapacityRiskRow;
}) {
  const t = useTranslations("capacity");
  const colors = useTokenColors();

  // v2: history + seasonal forecast with a stacked-area confidence band.
  // Nulls keep the history and forecast series independent on the shared
  // category axis; the band rides on its own stackId so it never mixes
  // with the data series.
  const v2 = useMemo(
    () => computeForecastV2(risk.series, risk.daysToThreshold, horizonPct),
    [risk, horizonPct]
  );
  const chartData = v2?.rows ?? [];

  const tooltipContent = useMemo(
    () =>
      forecastTooltipContent(risk, {
        forecast: t("forecastLegend"),
        band: t("bandLegend"),
      }),
    [risk, t]
  );

  const r2 = risk.r2.toFixed(2);

  return (
    <div className="flex flex-col gap-3">
      <ChartSummary
        aria-label={`Forecast chart for ${risk.hostname} ${metricLabel(risk.metric)}. Currently ${fmtCurrent(risk.metric, risk.current)}, ${risk.daysToThreshold === null ? "no crossing forecast" : `crossing the ${horizonPct} percent horizon in ${Math.round(risk.daysToThreshold)} days`}.`}
        summary={`Composed chart: ${risk.series.length} daily history points followed by a v2 forecast (linear trend + weekly seasonality) to the ${horizonPct} percent horizon, with a shaded 80 percent confidence band (${v2 ? `±${(1.28 * v2.sigma).toFixed(2)}` : "n/a"}). Model confidence ${risk.confidence} (R² ${r2}).`}
      >
        <ResponsiveContainer height={280} width="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              minTickGap={40}
              stroke={colors.mutedForeground}
              tick={{ fontSize: 11 }}
              tickFormatter={(ts: string) => format(new Date(ts), "MMM d")}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              stroke={colors.mutedForeground}
              tick={{ fontSize: 11 }}
              tickLine={false}
              width={56}
            />
            <Tooltip content={tooltipContent} />
            <ReferenceLine
              stroke={colors.danger}
              strokeDasharray="6 4"
              y={horizonPct}
              label={{
                fill: colors.danger,
                fontSize: 10,
                position: "insideTopRight",
                value: `Horizon ${horizonPct}%`,
              }}
            />
            {/* 80% confidence band: invisible lower bound + stacked span. */}
            <Area
              connectNulls={false}
              dataKey="bandBase"
              fill="none"
              legendType="none"
              stackId="band"
              stroke="none"
              tooltipType="none"
            />
            <Area
              connectNulls={false}
              dataKey="bandSpan"
              fill={colors.mutedForeground}
              fillOpacity={0.16}
              legendType="none"
              stackId="band"
              stroke="none"
              tooltipType="none"
            />
            <Area
              connectNulls
              dataKey="value"
              dot={false}
              fill={colors.primary}
              fillOpacity={0.12}
              name="value"
              stroke={colors.primary}
              strokeWidth={2}
              type="monotone"
            />
            <Line
              connectNulls
              dataKey="forecast"
              dot={false}
              name="forecast"
              stroke={colors.accent}
              strokeWidth={2}
              type="monotone"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartSummary>
      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: colors.primary }}
          />
          History (1D rollups)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: colors.accent }}
          />
          {t("forecastLegend")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-4 rounded-sm"
            style={{ backgroundColor: colors.mutedForeground, opacity: 0.25 }}
          />
          {t("bandLegend")}
        </span>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {t("methodNote")} · confidence{" "}
        <span className="font-medium text-foreground">{risk.confidence}</span> (R²{" "}
        <span className="font-tech ltr-technical">{r2}</span>)
        {v2 && !v2.seasonalityActive && (
          <> · {t("seasonalityOff")}</>
        )}
      </p>
    </div>
  );
}
