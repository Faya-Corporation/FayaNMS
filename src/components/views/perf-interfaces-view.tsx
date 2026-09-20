"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Activity, Search } from "lucide-react";

import { usePerformanceInterfaces } from "@/hooks/api/use-performance";
import { useMeta } from "@/hooks/api/use-meta";
import { useStatusLabel } from "@/hooks/use-status-label";
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
import { INTERFACE_OPER_STATUS, getStatusConfig } from "@/lib/domain/status";
import type { PerfInterfaceRow, PerfRange } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { PerfRangeChips, fmtPct, perfRangeLabel } from "./perf-overview-view";

// Chip labels are i18n keys resolved at render (t(`sort.${labelKey}`)) —
// the same dynamic-key shape as admin-system's group.${prefix} block.
const SORT_CHIPS: {
  value: "UTIL" | "PACKET_LOSS";
  labelKey: "utilization" | "packetLoss";
}[] = [
  { value: "UTIL", labelKey: "utilization" },
  { value: "PACKET_LOSS", labelKey: "packetLoss" },
];

function fmtSpeed(speedMbps: number): string {
  if (!Number.isFinite(speedMbps) || speedMbps <= 0) return "—";
  return speedMbps >= 1000
    ? `${Number((speedMbps / 1000).toFixed(1))} Gb/s`
    : `${speedMbps} Mb/s`;
}

function utilBarClass(pct: number): string {
  if (pct > 80) return "bg-danger";
  if (pct > 60) return "bg-warning";
  return "bg-primary";
}

/**
 * Interface Utilization (Task 6-b): dual in/out utilization bars per
 * interface with oper-status dots, peaks and packet loss, sorted by
 * utilization or packet loss.
 */
export function PerfInterfacesView() {
  const t = useTranslations("perfInterfaces");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  // Status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();
  // Shared perf chrome — PerfRangeChips and perfRangeLabel live in
  // perf-overview-view.tsx and stay English until the perf-overview tranche
  // keys them (documented cross-view dependency; its file is ledgered).

  const [range, setRange] = useState<PerfRange>("24H");
  const [sort, setSort] = useState<"UTIL" | "PACKET_LOSS">("UTIL");
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

  const interfaces = usePerformanceInterfaces({
    range,
    sort,
    siteCode: siteCode === "ALL" ? undefined : siteCode,
    q: q || undefined,
    page,
    pageSize: 25,
  });

  const rows = interfaces.data?.data ?? [];
  const listMeta = interfaces.data?.meta;
  const operStatusCounts = Object.entries(listMeta?.operStatusCounts ?? {}).sort(
    (a, b) => b[1] - a[1]
  );

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
        description={t("description", { range: perfRangeLabel(range) })}
        primaryAction={<PerfRangeChips onChange={(next) => { setRange(next); setPage(1); }} value={range} />}
        title={t("title")}
      />

      {/* Sort chips + oper-status facet counts */}
      <div className="flex flex-wrap items-center gap-2">
        <div aria-label={t("sort.groupAria")} className="flex flex-wrap items-center gap-2" role="group">
          {SORT_CHIPS.map((chip) => (
            <button
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                sort === chip.value
                  ? "border-primary/30 bg-primary/10 text-primary-ink"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              key={chip.value}
              onClick={() => {
                setSort(chip.value);
                setPage(1);
              }}
              type="button"
            >
              {t(`sort.${chip.labelKey}`)}
            </button>
          ))}
        </div>
        <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />
        {operStatusCounts.map(([status, count]) => {
          const config = getStatusConfig(INTERFACE_OPER_STATUS, status);
          return (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground"
              key={status}
            >
              <span aria-hidden="true" className={cn("size-2 rounded-full", config?.dotClass)} />
              {config ? resolveStatusLabel(config) : status}
              <span className="font-medium tabular-nums text-foreground">{count}</span>
            </span>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">{t("toolbar.searchSr")}</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="w-full ps-8 sm:w-64"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("toolbar.searchPlaceholder")}
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
          <SelectTrigger aria-label={t("toolbar.siteAria")} className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("toolbar.anySite")}</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.code}>
                {site.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            {t("toolbar.reset")}
          </Button>
        )}
      </div>

      <SectionCard
        contentClassName="p-0"
        title={
          listMeta
            ? t("table.cardTitleCounted", { total: listMeta.total })
            : t("table.cardTitle")
        }
      >
        {interfaces.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void interfaces.refetch()}
              reason={interfaces.error.message}
              title={t("error.title")}
            />
          </div>
        ) : interfaces.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("table.emptyDescription")}
              icon={Activity}
              title={t("table.emptyTitle")}
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table
              aria-label={t("table.ariaLabel", { range: perfRangeLabel(range) })}
              className="w-full min-w-[720px] text-sm"
            >
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium" scope="col">{t("table.col.interface")}</th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">{t("table.col.oper")}</th>
                  <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">{t("table.col.speed")}</th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">{t("table.col.in")}</th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">{t("table.col.out")}</th>
                  <th className="px-4 py-2 text-end font-medium" scope="col">{t("table.col.peak")}</th>
                  <th className="px-4 py-2 text-end font-medium" scope="col">{t("table.col.loss")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <InterfaceRow
                    key={row.interfaceId}
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
              {t("pagination.summary", {
                page: listMeta.page,
                totalPages: listMeta.totalPages,
                total: listMeta.total,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                disabled={listMeta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                {t("pagination.prev")}
              </Button>
              <Button
                disabled={listMeta.page >= listMeta.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                {t("pagination.next")}
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function InterfaceRow({
  onOpen,
  row,
}: {
  onOpen: (deviceId: string) => void;
  row: PerfInterfaceRow;
}) {
  const t = useTranslations("perfInterfaces");
  const operConfig = getStatusConfig(INTERFACE_OPER_STATUS, row.operStatus);
  // Oper-status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();

  return (
    <tr className="border-b transition-colors last:border-0 hover:bg-accent/50">
      <td className="px-4 py-2">
        <button
          className="flex max-w-[240px] flex-col items-start gap-0.5 text-start"
          onClick={() => onOpen(row.deviceId)}
          type="button"
        >
          <span
            className="max-w-[240px] truncate font-tech text-sm text-primary hover:underline ltr-technical"
            title={row.hostname}
          >
            {row.hostname}
          </span>
          <span className="max-w-[240px] truncate text-xs text-muted-foreground" title={row.ifName}>
            {row.ifName}
          </span>
        </button>
        <span className="sr-only"> — {t("row.openDevice")}</span>
      </td>
      <td className="px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", operConfig?.dotClass)}
          />
          {resolveStatusLabel(operConfig)}
        </span>
      </td>
      <td className="hidden px-4 py-2 text-end text-xs text-muted-foreground tabular-nums sm:table-cell">
        {fmtSpeed(row.speedMbps)}
      </td>
      <td className="px-4 py-2">
        <UtilBar pct={row.utilInPct} />
      </td>
      <td className="px-4 py-2">
        <UtilBar pct={row.utilOutPct} />
      </td>
      <td className="px-4 py-2 text-end">
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
            row.utilPeakPct > 80
              ? "bg-danger-subtle text-danger"
              : row.utilPeakPct > 60
                ? "bg-warning-subtle text-warning"
                : "bg-muted text-muted-foreground"
          )}
        >
          {fmtPct(row.utilPeakPct)}
        </span>
      </td>
      <td className="px-4 py-2 text-end text-xs text-muted-foreground tabular-nums">
        {fmtPct(row.packetLossPct, 2)}
      </td>
    </tr>
  );
}

/** Thin utilization meter with a % label; >80% red, >60% amber. */
function UtilBar({ pct }: { pct: number }) {
  const t = useTranslations("perfInterfaces");
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="flex min-w-[96px] items-center gap-2">
      <span
        aria-hidden="true"
        className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn("block h-full rounded-full", utilBarClass(pct))}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="w-12 text-end text-xs tabular-nums">{fmtPct(pct)}</span>
      <span className="sr-only">
        {t("sr.utilization", { pct: fmtPct(pct) })}
        {pct > 80 ? t("sr.critical") : pct > 60 ? t("sr.high") : ""}
      </span>
    </span>
  );
}
