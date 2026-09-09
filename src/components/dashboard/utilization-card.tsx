"use client";

import { useTranslations } from "next-intl";
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

import { SectionCard } from "@/components/domain/section-card";
import {
  TimeRangeSelect,
  type TimeRangeValue,
} from "@/components/domain/time-range-select";
import { WidgetSkeleton } from "./widget-skeleton";
import { useTokenColors } from "./use-token-colors";
import type { UtilizationPoint } from "@/lib/api-client";

interface UtilizationCardProps {
  data: UtilizationPoint[];
  loading: boolean;
  range: string;
  onRangeChange: (range: TimeRangeValue) => void;
}

/**
 * Fleet-average CPU + memory trend from 1H/1D MetricRollups.
 * Units (%) on both axes and the tooltip; brand color for CPU, brand
 * accent for memory.
 */
export function UtilizationCard({
  data,
  loading,
  range,
  onRangeChange,
}: UtilizationCardProps) {
  const t = useTranslations("dashboard");
  const colors = useTokenColors();
  const isWide = range === "7d";
  const tickFormatter = (period: string) =>
    format(new Date(period), isWide ? "EEE HH:mm" : "HH:mm");

  const cpuValues = data.map((point) => point.cpu);
  const memoryValues = data.map((point) => point.memory);
  const avg = (values: number[]) =>
    values.length > 0
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
      : 0;
  const peak = (values: number[]) =>
    values.length > 0 ? Math.max(...values) : 0;

  return (
    <SectionCard
      className="md:col-span-2 xl:col-span-8"
      contentClassName="pt-4"
      title={t("utilization.title")}
      description={
        isWide ? t("utilization.description7d") : t("utilization.description24h")
      }
      actions={
        <TimeRangeSelect onChange={onRangeChange} value={range} />
      }
    >
      {loading ? (
        <WidgetSkeleton className="h-[280px]" rows={6} />
      ) : data.length === 0 ? (
        <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
          {t("utilization.empty")}
        </div>
      ) : (
        <div
          aria-label={t("utilization.aria", {
            cpu: avg(cpuValues),
            cpuPeak: peak(cpuValues),
            memory: avg(memoryValues),
            memoryPeak: peak(memoryValues),
          })}
          dir="ltr"
          role="img"
        >
          <ResponsiveContainer height={280} width="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid
                stroke={colors.border}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="period"
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
                labelFormatter={(period: string) =>
                  format(new Date(period), "EEE, MMM d — HH:mm")
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
              {t("utilization.legendCpu")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 rounded-full"
                style={{ backgroundColor: colors.accent }}
              />
              {t("utilization.legendMemory")}
            </span>
          </div>
          <p className="sr-only">
            {t("utilization.srOnly", {
              cpu: avg(cpuValues),
              cpuPeak: peak(cpuValues),
              memory: avg(memoryValues),
              memoryPeak: peak(memoryValues),
            })}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
