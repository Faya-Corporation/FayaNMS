"use client";

import { useTranslations } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { SectionCard } from "@/components/domain/section-card";
import { DEVICE_STATUS, getStatusConfig } from "@/lib/domain/status";
import type { HealthSlice } from "@/lib/api-client";
import { WidgetSkeleton } from "./widget-skeleton";
import { useTokenColors } from "./use-token-colors";

interface HealthDistributionCardProps {
  data: HealthSlice[];
  loading: boolean;
  total: number;
}

/** Device status → token color for chart fills. */
function statusColor(
  status: string,
  colors: ReturnType<typeof useTokenColors>
): string {
  switch (status) {
    case "ONLINE":
      return colors.success;
    case "DEGRADED":
      return colors.warning;
    case "OFFLINE":
      return colors.danger;
    case "MAINTENANCE":
      return colors.info;
    default:
      return colors.neutral;
  }
}

/**
 * Donut of device health distribution using the exact status token colors,
 * with a text legend carrying icon + label + count (never color-only).
 */
export function HealthDistributionCard({
  data,
  loading,
  total,
}: HealthDistributionCardProps) {
  const t = useTranslations("dashboard");
  const colors = useTokenColors();
  const chartData = data.map((slice) => ({
    ...slice,
    label: getStatusConfig(DEVICE_STATUS, slice.status).label,
    fill: statusColor(slice.status, colors),
    faded: slice.status === "UNKNOWN" || slice.status === "UNMANAGED",
  }));

  return (
    <SectionCard
      className="md:col-span-2 xl:col-span-4"
      title={t("health.title")}
      description={t("health.description")}
    >
      {loading ? (
        <WidgetSkeleton className="h-[240px]" rows={5} />
      ) : chartData.length === 0 ? (
        <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
          {t("health.empty")}
        </div>
      ) : (
        <div
          aria-label={`${t("health.title")}: ${chartData
            .map((slice) => `${slice.count} ${slice.label}`)
            .join(", ")}`}
          className="flex flex-col items-center gap-3"
          role="img"
        >
          {/* dir="ltr": the donut geometry and its center overlay never
              mirror under RTL (Task 8-a chart rule). */}
          <div className="relative h-[190px] w-full max-w-[240px]" dir="ltr">
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Pie
                  cx="50%"
                  cy="50%"
                  data={chartData}
                  dataKey="count"
                  innerRadius={62}
                  nameKey="label"
                  outerRadius={88}
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                >
                  {chartData.map((slice) => (
                    <Cell
                      fill={slice.fill}
                      fillOpacity={slice.faded ? 0.5 : 1}
                      key={slice.status}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "var(--popover-foreground)",
                  }}
                  formatter={(value: number | string, _name: string, item) => [
                    t("health.deviceCount", { count: Number(value) }),
                    String(item?.payload?.label ?? ""),
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-semibold tabular-nums">{total}</span>
              <span className="text-[11px] text-muted-foreground">{t("health.devices")}</span>
            </div>
          </div>

          <ul className="grid w-full grid-cols-2 gap-x-3 gap-y-1.5">
            {chartData.map((slice) => (
              <li
                className="flex items-center gap-2 text-xs"
                key={slice.status}
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.fill, opacity: slice.faded ? 0.5 : 1 }}
                />
                <span className="truncate text-muted-foreground" title={slice.label}>
                  {slice.label}
                </span>
                <span className="ms-auto font-medium tabular-nums">{slice.count}</span>
              </li>
            ))}
          </ul>
          <p className="sr-only">
            {t("health.srOnly", {
              details: chartData
                .map((slice) => `${slice.count} ${slice.label}`)
                .join(", "),
            })}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
