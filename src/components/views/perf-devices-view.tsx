"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowDownRight, ArrowUpRight, Cpu, Minus, Search } from "lucide-react";

import { usePerformanceDevices } from "@/hooks/api/use-performance";
import { useMeta } from "@/hooks/api/use-meta";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PerfDeviceMetric,
  PerfDeviceRow,
  PerfRange,
} from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { PerfRangeChips, fmtMs, fmtPct, perfRangeLabel } from "./perf-overview-view";

const METRIC_CHIPS: { value: PerfDeviceMetric; label: string }[] = [
  { value: "CPU", label: "CPU" },
  { value: "MEMORY", label: "Memory" },
  { value: "LATENCY_MS", label: "Latency" },
  { value: "PACKET_LOSS", label: "Packet loss" },
  { value: "UTILIZATION", label: "Utilization" },
];

function fmtMetric(metric: PerfDeviceMetric, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return metric === "LATENCY_MS" ? fmtMs(value) : fmtPct(value);
}

/**
 * Device Performance (Task 6-b): per-device metric table with sparklines,
 * window deltas and worst-first insight. All five metric facets share the
 * same frozen /performance/devices contract.
 */
export function PerfDevicesView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [metric, setMetric] = useState<PerfDeviceMetric>("CPU");
  const [range, setRange] = useState<PerfRange>("24H");
  const [siteCode, setSiteCode] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const meta = useMeta();
  const sites = meta.data?.sites ?? [];

  const devices = usePerformanceDevices({
    metric,
    range,
    siteCode: siteCode === "ALL" ? undefined : siteCode,
    q: q || undefined,
    page,
    pageSize: 25,
  });

  const rows = devices.data?.data ?? [];
  const listMeta = devices.data?.meta;

  const resetFilters = () => {
    setSiteCode("ALL");
    setSearchInput("");
    setQ("");
    setPage(1);
  };
  const hasFilters = siteCode !== "ALL" || q !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={`Per-device ${METRIC_CHIPS.find((chip) => chip.value === metric)?.label.toLowerCase() ?? ""} across the fleet — ${perfRangeLabel(range)}`}
        primaryAction={<PerfRangeChips onChange={(next) => { setRange(next); setPage(1); }} value={range} />}
        title="Device Performance"
      />

      {/* Metric facet chips */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Metric">
        {METRIC_CHIPS.map((chip) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              metric === chip.value
                ? "border-primary/30 bg-primary/10 text-primary"
                : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
            key={chip.value}
            onClick={() => {
              setMetric(chip.value);
              setPage(1);
            }}
            type="button"
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search devices</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="w-full ps-8 sm:w-64"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search hostname…"
            value={searchInput}
          />
        </label>
        <Select
          onValueChange={(value) => {
            setSiteCode(value);
            setPage(1);
          }}
          value={siteCode}
        >
          <SelectTrigger aria-label="Site" className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Any site</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.code}>
                {site.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            Reset
          </Button>
        )}
      </div>

      <SectionCard
        contentClassName="p-0"
        title={`Devices${listMeta ? ` — ${listMeta.total}` : ""}`}
      >
        {devices.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void devices.refetch()}
              reason={devices.error.message}
              title="Device performance could not be loaded"
            />
          </div>
        ) : devices.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No devices match the current filters, or no samples cover this window."
              icon={Cpu}
              title="No performance rows to show"
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">Device</th>
                  <th className="px-4 py-2 text-start font-medium">Site</th>
                  <th className="px-4 py-2 text-start font-medium">Status</th>
                  <th className="px-4 py-2 text-start font-medium">Trend</th>
                  <th className="px-4 py-2 text-end font-medium">Latest</th>
                  <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">Avg</th>
                  <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">Max</th>
                  <th className="hidden px-4 py-2 text-end font-medium md:table-cell">P95</th>
                  <th className="px-4 py-2 text-end font-medium">Δ Window</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DeviceRow
                    key={row.deviceId}
                    metric={metric}
                    onOpen={(deviceId) =>
                      setActiveView("network.device-detail", { deviceId })
                    }
                    row={row}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {listMeta && listMeta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              Page {listMeta.page} of {listMeta.totalPages} · {listMeta.total} devices
            </span>
            <div className="flex gap-2">
              <Button
                disabled={listMeta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={listMeta.page >= listMeta.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function DeviceRow({
  metric,
  onOpen,
  row,
}: {
  metric: PerfDeviceMetric;
  onOpen: (deviceId: string) => void;
  row: PerfDeviceRow;
}) {
  const deltaRising = row.deltaPct > 0.05;
  const deltaFalling = row.deltaPct < -0.05;
  const DeltaIcon = deltaRising ? ArrowUpRight : deltaFalling ? ArrowDownRight : Minus;

  return (
    <tr className="border-b transition-colors last:border-0 hover:bg-accent/50">
      <td className="px-4 py-2">
        <button
          className="max-w-[220px] truncate font-tech text-sm text-primary hover:underline ltr-technical"
          onClick={() => onOpen(row.deviceId)}
          title={row.hostname}
          type="button"
        >
          {row.hostname}
        </button>
        <span className="sr-only"> — open device detail</span>
      </td>
      <td className="px-4 py-2 text-xs text-muted-foreground">{row.siteCode}</td>
      <td className="px-4 py-2">
        <DeviceStatusBadge value={row.status} />
      </td>
      <td className="px-4 py-2">
        <Sparkline
          className={
            deltaRising ? "text-danger" : deltaFalling ? "text-success" : "text-accent"
          }
          title={`${row.trend.length} buckets · oldest to newest`}
          values={row.trend}
        />
      </td>
      <td className="px-4 py-2 text-end font-medium tabular-nums" title={row.latest.ts ? formatDistanceToNow(new Date(row.latest.ts), { addSuffix: true }) : undefined}>
        {fmtMetric(metric, row.latest?.value)}
      </td>
      <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
        {fmtMetric(metric, row.avg)}
      </td>
      <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
        {fmtMetric(metric, row.max)}
      </td>
      <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums md:table-cell">
        {fmtMetric(metric, row.p95)}
      </td>
      <td className="px-4 py-2 text-end">
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
            deltaRising
              ? "bg-danger-subtle text-danger"
              : deltaFalling
                ? "bg-success-subtle text-success"
                : "bg-muted text-muted-foreground"
          )}
        >
          <DeltaIcon aria-hidden="true" className="size-3" />
          {row.deltaPct > 0 ? "+" : ""}
          {row.deltaPct.toFixed(1)}%
          <span className="sr-only">
            {deltaRising ? " worsening" : deltaFalling ? " improving" : " flat"}
          </span>
        </span>
      </td>
    </tr>
  );
}

/** Inline SVG sparkline — cheap enough for a table cell (no Recharts). */
function Sparkline({
  className,
  title,
  values,
}: {
  className?: string;
  title?: string;
  values: number[];
}) {
  const width = 88;
  const height = 24;
  const pad = 2;

  if (!values || values.length < 2) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = pad + (index / (values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      aria-hidden="true"
      className={cn("inline-block align-middle", className)}
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      {title ? <title>{title}</title> : null}
      <polyline
        fill="none"
        points={points}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
