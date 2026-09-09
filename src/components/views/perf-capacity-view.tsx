"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import {
  ChevronRight,
  CircleCheck,
  Info,
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
import {
  fitCapacityModel,
  forecast as forecastWithModel,
  type RidgeModel,
} from "@/lib/capacity/regression";
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
  CapacityModel,
  CapacityModelFeatureWeights,
  CapacityModelSkipReason,
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
 * Capacity (Task 6-b / upgraded Phase 13-c / ML tier Phase 15-c): the point
 * forecast is now the deterministic ridge-v3 regression (standardized
 * trend + weekly sin/cos + weekend features) when the API reports a model;
 * the shaded 80% band keeps v2's residual-σ derivation (±1.28σ, floored at
 * 0.5% of the mean level) recomputed around the v3 points, and shorter
 * series fall back to the pure v2 (linear trend × weekly season factor)
 * path. Risk list (days-to-threshold ascending, semantics unchanged) +
 * selectable forecast chart with the band and horizon line, plus a Model
 * quality card (backtest metrics, feature-weight bars, backtest window).
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
                : t("forecast.selectPrompt")
            }
            title={t("forecast.title")}
          >
            {!selected ? (
              <EmptyState
                className="border-none bg-transparent py-10"
                description={t("forecast.pickHint")}
                icon={LineChart}
                title={t("forecast.emptyTitle")}
              />
            ) : (
              <ForecastChart horizonPct={data?.horizonPct ?? HORIZON_PCT} risk={selected} />
            )}
          </SectionCard>
        </div>
      )}

      {/* Model quality (Phase 15-c, ridge-v3) */}
      <SectionCard
        contentClassName="p-4"
        description={
          selected
            ? `${selected.hostname} · ${metricLabel(selected.metric)}`
            : t("model.selectHint")
        }
        title={t("model.title")}
      >
        {!selected ? (
          <EmptyState
            className="border-none bg-transparent py-8"
            description={t("model.selectHint")}
            icon={LineChart}
            title={t("model.title")}
          />
        ) : selected.model ? (
          <ModelQualityDetails metric={selected.metric} model={selected.model} />
        ) : (
          <EmptyState
            className="border-none bg-transparent py-8"
            description={
              selected.modelSkipReason?.code === "TOO_SHORT"
                ? t("model.skipTooShort", {
                    points: selected.modelSkipReason.points,
                    required: selected.modelSkipReason.required,
                  })
                : undefined
            }
            icon={Info}
            title={t("model.unavailable")}
          />
        )}
      </SectionCard>
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
  /** Which engine produced the points — the band is always v2-derived. */
  engine: "ridge-v3" | "v2-fallback";
}

/**
 * Forecast blend (Phase 13-c v2 → Phase 15-c v3) — dependency-free, computed
 * from the 1D history:
 *
 *   1. Point forecast: when the API reports a ridge-v3 model for the series
 *      (≥ 10 points), the caller passes the full-window refit (`fit`) and
 *      every forecast day is predicted by the deterministic ridge regression
 *      (standardized trend + weekly sin/cos + weekend). Otherwise the v2
 *      path applies: least-squares linear trend × weekly seasonality factor.
 *   2. Weekly seasonality (v2 fallback only): mean ratio actual/trend per
 *      weekday bucket (Date.getUTCDay, 0–6), normalized to mean 1, active
 *      only when the history spans ≥ 14 days.
 *   3. Residual σ (v2's derivation, recomputed around whichever fitted
 *      values are plotted): population standard deviation of (actual −
 *      fitted), floored at 0.5% of the mean level so smooth series still
 *      render a visible band.
 *   4. Confidence band: ±1.28σ ≈ 80% interval around each forecast day.
 *
 * The crossing-day semantics of the frozen linear model are preserved:
 * the forecast line still terminates at (lastTs + daysToThreshold,
 * horizonPct); intermediate days wiggle with the v3/v2 engine.
 */
function computeForecastV2(
  series: CapacityForecastPoint[],
  daysToThreshold: number | null,
  horizonPct: number,
  fit: RidgeModel | null
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

  // Fitted values over the history — ridge-v3 when available (full-window
  // refit), otherwise the v2 trend × season fit. The band's σ is derived
  // from these residuals with v2's exact derivation either way.
  const engine: ForecastV2["engine"] = fit ? "ridge-v3" : "v2-fallback";
  const historyTs = series.map((p) => Date.parse(p.ts));
  const fitted = fit
    ? forecastWithModel(fit, historyTs).map((v) => Math.max(0, v))
    : series.map((p, i) => {
        const wd = new Date(p.ts).getUTCDay();
        return trendAt(xs[i]) * season[wd];
      });

  // Residual σ around the fitted values, floored so smooth series
  // still render a visible (thin) band instead of a zero-width sliver.
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    sse += (ys[i] - fitted[i]) ** 2;
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
    const value = fit
      ? Math.max(0, forecastWithModel(fit, [ts])[0])
      : Math.max(0, trendAt(x) * season[wd]);
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

  return { rows: history, sigma, seasonalityActive, engine };
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

  // ridge-v3 point-forecast engine: refit on the FULL published series when
  // the API reports a model (identical input → identical fit, so the chart
  // never flickers under polling); null ⇒ pure v2 fallback below.
  const fit = useMemo(
    () =>
      risk.model
        ? fitCapacityModel(
            risk.series.map((p) => ({ ts: Date.parse(p.ts), value: p.value }))
          )
        : null,
    [risk]
  );

  // v2/blended: history + forecast with a stacked-area confidence band.
  // Nulls keep the history and forecast series independent on the shared
  // category axis; the band rides on its own stackId so it never mixes
  // with the data series.
  const v2 = useMemo(
    () => computeForecastV2(risk.series, risk.daysToThreshold, horizonPct, fit),
    [risk, horizonPct, fit]
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
        aria-label={t("forecast.chartLabel", {
          hostname: risk.hostname,
          metric: metricLabel(risk.metric),
          current: fmtCurrent(risk.metric, risk.current),
          crossing:
            risk.daysToThreshold === null
              ? t("forecast.noCrossing")
              : t("forecast.crossing", {
                  horizon: horizonPct,
                  days: Math.round(risk.daysToThreshold),
                }),
        })}
        summary={t("forecast.chartSummary", {
          points: risk.series.length,
          engine:
            v2?.engine === "ridge-v3"
              ? t("forecast.engineRidge")
              : t("forecast.engineV2"),
          horizon: horizonPct,
          band: v2 ? `±${(1.28 * v2.sigma).toFixed(2)}` : "n/a",
          confidence: risk.confidence,
          r2,
        })}
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
        {v2?.engine === "ridge-v3" && (
          <span
            className="inline-flex items-center rounded-full border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            title={t("model.engineTag")}
          >
            <span aria-hidden="true" className="me-1 size-1.5 rounded-full bg-primary" />
            {t("model.engineTag")}
          </span>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {t("forecast.confidenceNote", { confidence: risk.confidence, r2 })}
        {v2 && v2.engine === "v2-fallback" && !v2.seasonalityActive && (
          <> · {t("seasonalityOff")}</>
        )}
      </p>
    </div>
  );
}

/* ─────────────────── Model quality card (Phase 15-c) ─────────────────── */

/**
 * Model quality details for the selected series. Everything renders from
 * the API's deterministic ridge-v3 report — identical data in, identical
 * numbers out, so the card never flickers under polling.
 */
function ModelQualityDetails({
  metric,
  model,
}: {
  metric: string;
  model: CapacityModel;
}) {
  const t = useTranslations("capacity");
  const { metrics, featureWeights } = model;

  const facts: Array<{ label: string; value: string }> = [
    { label: t("model.trainPoints"), value: String(metrics.trainPoints) },
    { label: t("model.validationPoints"), value: String(metrics.validationPoints) },
    {
      label: t("model.backtest"),
      value: t("model.backtestRange", {
        from: format(new Date(model.backtestWindow.from), "MMM d"),
        to: format(new Date(model.backtestWindow.to), "MMM d"),
      }),
    },
    { label: t("model.trendPerDay"), value: fmtSlope(metric, model.trendPerDay) },
  ];

  const metricRows: Array<{
    key: "mae" | "rmse" | "mape" | "r2";
    label: string;
    full: string;
    value: string;
  }> = [
    {
      key: "mae",
      label: t("model.mae"),
      full: t("model.maeFull"),
      value: fmtCurrent(metric, metrics.mae),
    },
    {
      key: "rmse",
      label: t("model.rmse"),
      full: t("model.rmseFull"),
      value: fmtCurrent(metric, metrics.rmse),
    },
    {
      key: "mape",
      label: t("model.mape"),
      full: t("model.mapeFull"),
      value: `${metrics.mape.toFixed(2)}%`,
    },
    {
      key: "r2",
      label: t("model.r2"),
      full: t("model.r2Full"),
      value: metrics.r2.toFixed(4),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {/* Engine + split facts */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            <span className="font-tech ltr-technical">{model.engine}</span>
          </span>
          <span className="text-xs text-muted-foreground">{t("model.engine")}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                <span className="ltr-technical">{fact.value}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Backtest metrics table */}
      <div>
        <table className="w-full text-sm">
          <caption className="sr-only">{t("model.metricsTitle")}</caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="pb-1.5 text-start font-medium" scope="col">
                {t("model.metricsTitle")}
              </th>
              <th className="pb-1.5 text-end font-medium" scope="col">
                {t("model.valueHeader")}
              </th>
            </tr>
          </thead>
          <tbody>
            {metricRows.map((row) => (
              <tr className="border-b last:border-0" key={row.key}>
                <th
                  className="py-1.5 text-start font-normal text-muted-foreground"
                  scope="row"
                  title={row.full}
                >
                  {row.label}
                </th>
                <td className="py-1.5 text-end font-tech tabular-nums ltr-technical">
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Feature weight bars */}
      <div className="md:col-span-2 xl:col-span-1">
        <p className="mb-2 text-sm font-medium">{t("model.weightsTitle")}</p>
        <WeightBars weights={featureWeights} />
      </div>
    </div>
  );
}

/**
 * Signed, normalized bars for the standardized ridge weights: bar length is
 * |w| / max|w| of the four features, positive grows forward from the zero
 * line (primary), negative grows backward (neutral gray). Deterministic —
 * pure arithmetic over the model report.
 */
function WeightBars({ weights }: { weights: CapacityModelFeatureWeights }) {
  const t = useTranslations("capacity");

  const entries: Array<{ name: string; label: string; value: number }> = [
    { name: "trend", label: t("model.weightTrend"), value: weights.trend },
    { name: "weeklySin", label: t("model.weightWeeklySin"), value: weights.weeklySin },
    { name: "weeklyCos", label: t("model.weightWeeklyCos"), value: weights.weeklyCos },
    { name: "weekend", label: t("model.weightWeekend"), value: weights.weekend },
  ];
  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.value)), 1e-9);

  return (
    <div className="flex flex-col gap-2.5">
      {entries.map((entry) => {
        const positive = entry.value >= 0;
        const widthPct = (Math.abs(entry.value) / maxAbs) * 50;
        const valueText = `${positive ? "+" : "-"}${Math.abs(entry.value).toFixed(3)}`;
        return (
          <div className="flex items-center gap-3 text-xs" key={entry.name}>
            <span
              className="w-28 shrink-0 truncate text-muted-foreground"
              title={entry.label}
            >
              {entry.label}
            </span>
            <div
              aria-label={`${entry.label}: ${valueText}`}
              className="relative h-2 flex-1 rounded-full bg-muted"
              role="img"
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 start-1/2 w-px bg-border"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 rounded-full",
                  positive ? "start-1/2 bg-primary" : "end-1/2 bg-muted-foreground/70"
                )}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-end font-tech tabular-nums ltr-technical">
              {valueText}
            </span>
          </div>
        );
      })}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t("model.weightsHint")}
      </p>
    </div>
  );
}
