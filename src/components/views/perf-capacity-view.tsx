"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
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
} from "recharts";

import { usePerformanceCapacity } from "@/hooks/api/use-performance";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { useTokenColors } from "@/components/dashboard/use-token-colors";
import { cn } from "@/lib/utils";
import type {
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
 * Capacity (Task 6-b): linear least-squares forecast over 1D rollups.
 * Risk list (days-to-threshold ascending) + selectable forecast chart with
 * the horizon reference line.
 */
export function PerfCapacityView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);
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
        description={`Growth forecast — LINEAR model over ${perfRangeLabel(range)} of 1D rollups · horizon ${HORIZON_PCT}% within ${HORIZON_DAYS} days`}
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
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-start font-medium">Device / Metric</th>
                      <th className="px-4 py-2 text-end font-medium">Current</th>
                      <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">Slope</th>
                      <th className="px-4 py-2 text-end font-medium">Horizon</th>
                      <th className="hidden px-4 py-2 text-end font-medium md:table-cell">Confidence</th>
                      <th className="w-10 px-2 py-2">
                        <span className="sr-only">Inspect forecast</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {risks.map((risk) => (
                      <tr
                        className={cn(
                          "border-b transition-colors last:border-0 hover:bg-accent/50",
                          selectedKey === riskKey(risk) && "bg-accent/60"
                        )}
                        key={riskKey(risk)}
                        onClick={() => setSelectedKey(riskKey(risk))}
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
                description="Pick a device + metric from the risk table to see its history, linear projection and the 80% horizon."
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

function ForecastChart({
  horizonPct,
  risk,
}: {
  horizonPct: number;
  risk: CapacityRiskRow;
}) {
  const colors = useTokenColors();

  // Merge the 1D history with the linear projection: the projection line
  // starts at the last history point and ends at the threshold crossing
  // (daysToThreshold days later, at horizonPct). Nulls keep the two
  // series independent on the shared category axis.
  const chartData = useMemo(() => {
    const history = risk.series.map((point) => ({
      ts: point.ts,
      value: point.value as number | null,
      projection: null as number | null,
    }));
    const last = history[history.length - 1];
    if (last && risk.daysToThreshold !== null) {
      last.projection = last.value;
      const endTs = new Date(
        new Date(last.ts).getTime() + risk.daysToThreshold * 86_400_000
      ).toISOString();
      history.push({ ts: endTs, value: null, projection: horizonPct });
    }
    return history;
  }, [risk, horizonPct]);

  const r2 = risk.r2.toFixed(2);

  return (
    <div className="flex flex-col gap-3">
      <div
        aria-label={`Forecast chart for ${risk.hostname} ${metricLabel(risk.metric)}. Currently ${fmtCurrent(risk.metric, risk.current)}, ${risk.daysToThreshold === null ? "no crossing forecast" : `crossing the ${horizonPct} percent horizon in ${Math.round(risk.daysToThreshold)} days`}.`}
        role="img"
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
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--popover-foreground)",
              }}
              formatter={(value: number | string, name: string) =>
                name === "projection"
                  ? [fmtCurrent(risk.metric, Number(value)), "Projection"]
                  : [fmtCurrent(risk.metric, Number(value)), metricLabel(risk.metric)]
              }
              labelFormatter={(ts: string) => format(new Date(ts), "EEE, MMM d, HH:mm")}
            />
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
              dataKey="projection"
              dot={false}
              name="projection"
              stroke={colors.danger}
              strokeDasharray="6 4"
              strokeWidth={2}
              type="monotone"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
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
            style={{
              backgroundColor: colors.danger,
              backgroundImage: `repeating-linear-gradient(90deg, ${colors.danger} 0 4px, transparent 4px 8px)`,
            }}
          />
          Linear projection
        </span>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Linear least-squares forecast over 1D rollups · confidence{" "}
        <span className="font-medium text-foreground">{risk.confidence}</span> (R²{" "}
        <span className="font-tech ltr-technical">{r2}</span>)
      </p>
    </div>
  );
}
