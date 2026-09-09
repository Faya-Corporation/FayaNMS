"use client";

import { useState } from "react";
import { format } from "date-fns";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Cpu as CpuIcon } from "lucide-react";

import {
  useDeviceMetrics,
  type DeviceMetricWindow,
} from "@/hooks/api/use-device-detail";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
import {
  TimeRangeSelect,
  type TimeRangeValue,
} from "@/components/domain/time-range-select";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { useTokenColors } from "@/components/dashboard/use-token-colors";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

function toTimeRange(window: DeviceMetricWindow): TimeRangeValue {
  return window;
}

function fromTimeRange(value: TimeRangeValue): DeviceMetricWindow {
  // The metric endpoint serves 6h/24h from raw samples and 7d from rollups;
  // other presets clamp to the nearest supported window.
  if (value === "6h") return "6h";
  if (value === "24h" || value === "15m" || value === "1h") return "24h";
  return "7d";
}

interface DeviceHealthTabProps {
  deviceId: string;
  healthScore: number;
  status: string;
}

/**
 * Health tab: CPU/memory + interface utilization series for the selected
 * window (raw samples for 6h/24h, rollups for 7d — see the metrics route).
 */
export function DeviceHealthTab({
  deviceId,
  healthScore,
  status,
}: DeviceHealthTabProps) {
  const [window, setWindow] = useState<DeviceMetricWindow>("24h");
  const metrics = useDeviceMetrics(deviceId, window);
  const colors = useTokenColors();

  const series = metrics.data?.series ?? [];
  const source = (metrics.data?.meta as { source?: string } | undefined)?.source;

  const isWide = window === "7d";
  const tickFormatter = (ts: string) =>
    format(new Date(ts), isWide ? "EEE HH:mm" : "HH:mm");

  const avg = (values: (number | null)[]) => {
    const nums = values.filter((value): value is number => value !== null);
    return nums.length > 0
      ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
      : 0;
  };
  const peak = (values: (number | null)[]) => {
    const nums = values.filter((value): value is number => value !== null);
    return nums.length > 0 ? Math.max(...nums) : 0;
  };

  const cpuValues = series.map((point) => point.cpu);
  const memoryValues = series.map((point) => point.memory);
  const inValues = series.map((point) => point.utilizationIn);
  const outValues = series.map((point) => point.utilizationOut);

  const healthTone =
    healthScore >= 80
      ? "text-success"
      : healthScore >= 50
        ? "text-warning"
        : "text-danger";

  return (
    <div className="flex flex-col gap-4 pt-2">
      <SectionCard
        contentClassName="p-0"
        description="Device status and rolling health score"
        title="Status"
        actions={
          <TimeRangeSelect
            onChange={(value) => setWindow(fromTimeRange(value))}
            value={toTimeRange(window)}
          />
        }
      >
        <div className="grid grid-cols-1 gap-4 p-card sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">State</p>
            <DeviceStatusBadge className="w-fit" value={status} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Health score</p>
            <div className="flex items-center gap-2">
              <Progress aria-label={`Health score ${healthScore} percent`} value={healthScore} />
              <span className={cn("w-10 text-end text-sm font-semibold tabular-nums", healthTone)}>
                {healthScore}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Data source</p>
            <p className="text-sm text-muted-foreground">
              {source === "samples"
                ? "Raw collector samples"
                : source === "rollups-1H"
                  ? "Hourly rollups (1H)"
                  : source === "rollups-1D"
                    ? "Daily rollups (1D)"
                    : "—"}
            </p>
          </div>
        </div>
      </SectionCard>

      {metrics.isError ? (
        <ErrorState
          onRetry={() => void metrics.refetch()}
          reason={metrics.error.message}
          title="Metric samples could not be loaded"
        />
      ) : metrics.isLoading ? (
        <WidgetSkeleton className="h-[280px]" rows={6} />
      ) : series.length === 0 ? (
        <EmptyState
          description="No collector samples fall inside this window. Queue a backup or poll job to refresh the data."
          icon={CpuIcon}
          title={`No metrics for the last ${window === "6h" ? "6 hours" : window === "24h" ? "24 hours" : "7 days"}`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SectionCard
            contentClassName="pt-4"
            description={`CPU and memory (%), last ${isWide ? "7 days" : window === "6h" ? "6 hours" : "24 hours"}`}
            title="CPU & Memory"
          >
            <div
              aria-label={`CPU and memory chart. CPU averaged ${avg(cpuValues)} percent, peaking at ${peak(cpuValues)} percent. Memory averaged ${avg(memoryValues)} percent, peaking at ${peak(memoryValues)} percent.`}
              role="img"
            >
              <ResponsiveContainer height={240} width="100%">
                <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    minTickGap={40}
                    stroke={colors.mutedForeground}
                    tick={{ fontSize: 11 }}
                    tickFormatter={tickFormatter}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    stroke={colors.mutedForeground}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value: number) => `${value}%`}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "var(--popover-foreground)",
                    }}
                    formatter={(value: number | string, name: string) => [
                      `${value}%`,
                      name === "cpu" ? "CPU" : "Memory",
                    ]}
                    labelFormatter={(ts: string) =>
                      format(new Date(ts), "EEE, MMM d — HH:mm")
                    }
                  />
                  <Line
                    dataKey="cpu"
                    dot={false}
                    name="cpu"
                    stroke={colors.primary}
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    dataKey="memory"
                    dot={false}
                    name="memory"
                    stroke={colors.accent}
                    strokeWidth={2}
                    type="monotone"
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="mt-2 flex items-center justify-center gap-5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ backgroundColor: colors.primary }}
                  />
                  CPU %
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ backgroundColor: colors.accent }}
                  />
                  Memory %
                </span>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            contentClassName="pt-4"
            description={`Interface utilization (%), last ${isWide ? "7 days" : window === "6h" ? "6 hours" : "24 hours"}`}
            title="Utilization In / Out"
          >
            <div
              aria-label={`Utilization chart. Inbound averaged ${avg(inValues)} percent, outbound averaged ${avg(outValues)} percent.`}
              role="img"
            >
              <ResponsiveContainer height={240} width="100%">
                <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    minTickGap={40}
                    stroke={colors.mutedForeground}
                    tick={{ fontSize: 11 }}
                    tickFormatter={tickFormatter}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    stroke={colors.mutedForeground}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value: number) => `${value}%`}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "var(--popover-foreground)",
                    }}
                    formatter={(value: number | string, name: string) => [
                      `${value}%`,
                      name === "utilizationIn" ? "Inbound" : "Outbound",
                    ]}
                    labelFormatter={(ts: string) =>
                      format(new Date(ts), "EEE, MMM d — HH:mm")
                    }
                  />
                  <Line
                    dataKey="utilizationIn"
                    dot={false}
                    name="utilizationIn"
                    stroke={colors.primary}
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    dataKey="utilizationOut"
                    dot={false}
                    name="utilizationOut"
                    stroke={colors.warning}
                    strokeWidth={2}
                    type="monotone"
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="mt-2 flex items-center justify-center gap-5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ backgroundColor: colors.primary }}
                  />
                  In %
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-4 rounded-full"
                    style={{ backgroundColor: colors.warning }}
                  />
                  Out %
                </span>
              </div>
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
