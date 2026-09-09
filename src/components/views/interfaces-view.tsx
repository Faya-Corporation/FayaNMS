"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import {
  CircleCheck,
  CircleMinus,
  CircleOff,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Network,
  Search,
  SearchX,
  Zap,
} from "lucide-react";

import { useMeta } from "@/hooks/api/use-meta";
import {
  useInterfaces,
  type InterfaceAdminStatus,
  type InterfaceOperStatus,
  type InterfaceRow as InterfaceRowData,
} from "@/hooks/api/use-interfaces";
import { useStatusLabel } from "@/hooks/use-status-label";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DEVICE_STATUS,
  INTERFACE_ADMIN_STATUS,
  INTERFACE_OPER_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import { useNavigationStore } from "@/stores/navigation";

const ALL = "ALL";
const PAGE_SIZE = 25;

/** 1000 -> "1 Gbps", 100 -> "100 Mbps", null -> "—". */
function fmtSpeed(speedMbps: number | null): string {
  if (speedMbps === null || speedMbps === undefined) return "—";
  if (speedMbps >= 1000) return `${speedMbps / 1000} Gbps`;
  return `${speedMbps} Mbps`;
}

/** null -> "—", otherwise one-decimal percent. */
function fmtPct(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function utilBarClass(pct: number): string {
  if (pct > 80) return "bg-danger";
  if (pct > 60) return "bg-warning";
  return "bg-primary";
}

/** Small in/out-peak utilization bar (mirrors perf-interfaces-view). */
function UtilBar({ pct, srLabel }: { pct: number; srLabel: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="relative flex min-w-[96px] items-center gap-2">
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
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}

interface RowProps {
  onOpen: (deviceId: string) => void;
  row: InterfaceRowData;
  openAria: string;
  openTitle: string;
  utilSrLabel: string;
}

/**
 * One inventory row. Navigation mirrors devices-view: the entry point calls
 * setActiveView("network.device-detail", { deviceId }); the row-level click
 * is a convenience alias of the same call, while the nested (focusable)
 * button carries the accessible name and the keyboard path.
 */
function InterfaceRowView({ onOpen, row, openAria, openTitle, utilSrLabel }: RowProps) {
  const resolveStatusLabel = useStatusLabel();
  const adminConfig = getStatusConfig(INTERFACE_ADMIN_STATUS, row.adminStatus);
  const operConfig = getStatusConfig(INTERFACE_OPER_STATUS, row.operStatus);
  const deviceConfig = getStatusConfig(DEVICE_STATUS, row.deviceStatus);

  return (
    <tr
      className="cursor-pointer border-b transition-colors last:border-0 hover:bg-accent/50"
      onClick={() => onOpen(row.deviceId)}
    >
      <td className="px-4 py-2">
        <button
          aria-label={openAria}
          className="flex max-w-[220px] flex-col items-start gap-0.5 text-start"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row.deviceId);
          }}
          title={openTitle}
          type="button"
        >
          <span className="flex max-w-full items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", deviceConfig.dotClass)}
            />
            <span className="truncate font-tech text-sm font-medium ltr-technical">
              {row.deviceHostname}
            </span>
          </span>
          <span className="flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground">
            <span className="font-tech ltr-technical">
              {row.siteCode ?? "—"}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{row.vendorName}</span>
          </span>
        </button>
        <span className="sr-only"> — {openTitle}</span>
      </td>
      <td className="px-4 py-2 font-tech text-sm ltr-technical">{row.name}</td>
      <td className="px-4 py-2">
        <StatusBadge config={adminConfig} withIcon={false} />
      </td>
      <td className="px-4 py-2">
        <StatusBadge config={operConfig} withIcon={false} />
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-end font-tech text-xs tabular-nums text-muted-foreground">
        {fmtSpeed(row.speedMbps)}
      </td>
      <td className="px-4 py-2 text-end text-xs tabular-nums">
        {row.vlan ?? "—"}
      </td>
      <td className="px-4 py-2">
        {row.utilizationPct === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <UtilBar pct={row.utilizationPct} srLabel={utilSrLabel} />
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2 font-tech text-xs ltr-technical text-muted-foreground">
        {row.macAddress ?? "—"}
      </td>
      <td
        className="max-w-[20ch] truncate px-4 py-2 text-xs text-muted-foreground"
        title={row.description ?? undefined}
      >
        {row.description ?? "—"}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
        {row.lastFlapAt
          ? formatDistanceToNow(new Date(row.lastFlapAt), { addSuffix: true })
          : "—"}
      </td>
    </tr>
  );
}

/**
 * Interfaces inventory (network.interfaces) against /api/v1/interfaces:
 * fleet-wide interface KPIs, site/oper/admin filters with debounced search,
 * and a scrollable inventory table whose rows drill down into the device
 * detail view. Mirrors devices-view / perf-interfaces-view conventions.
 */
export function InterfacesView() {
  const t = useTranslations("netif");
  const tCommon = useTranslations("common");
  const resolveStatusLabel = useStatusLabel();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [site, setSite] = useState<string>(ALL);
  const [operStatus, setOperStatus] = useState<string>(ALL);
  const [adminStatus, setAdminStatus] = useState<string>(ALL);
  const [page, setPage] = useState(1);

  // Debounce the search box into the committed query (devices-view pattern).
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const meta = useMeta();
  const sites = meta.data?.sites ?? [];

  const interfaces = useInterfaces({
    adminStatus:
      adminStatus !== ALL ? (adminStatus as InterfaceAdminStatus) : undefined,
    operStatus:
      operStatus !== ALL ? (operStatus as InterfaceOperStatus) : undefined,
    page,
    pageSize: PAGE_SIZE,
    q: q || undefined,
    site: site !== ALL ? site : undefined,
  });

  const summary = interfaces.data?.summary;
  const rows = interfaces.data?.rows ?? [];
  const pageInfo = interfaces.data?.page;

  const hasFilters =
    site !== ALL || operStatus !== ALL || adminStatus !== ALL || q !== "";

  const clearFilters = () => {
    setSite(ALL);
    setOperStatus(ALL);
    setAdminStatus(ALL);
    setSearchInput("");
    setQ("");
    setPage(1);
  };

  const openDevice = (deviceId: string) =>
    setActiveView("network.device-detail", { deviceId });

  const kpiLoading = interfaces.isLoading;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        actions={
          <Badge
            aria-label={t("kpi.total")}
            className="gap-1.5 px-2.5 py-1 text-xs"
            variant="outline"
          >
            <Network aria-hidden="true" className="size-3.5" />
            {t("kpi.total")}
            <span className="font-semibold tabular-nums">
              {summary ? summary.total : "—"}
            </span>
          </Badge>
        }
        description={t("description")}
        title={t("title")}
      />

      {/* ── KPI cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          description={t("kpi.totalHint")}
          icon={Network}
          label={t("kpi.total")}
          loading={kpiLoading}
          value={summary ? summary.total : "—"}
        />
        <KpiCard
          description={t("kpi.upHint")}
          icon={CircleCheck}
          label={t("kpi.up")}
          loading={kpiLoading}
          status={
            summary
              ? {
                  label: resolveStatusLabel(
                    getStatusConfig(INTERFACE_OPER_STATUS, "UP")
                  ),
                  token: "success",
                }
              : undefined
          }
          value={summary ? summary.up : "—"}
        />
        <KpiCard
          description={t("kpi.downHint")}
          icon={CircleOff}
          label={t("kpi.down")}
          loading={kpiLoading}
          status={
            summary
              ? {
                  label: resolveStatusLabel(
                    getStatusConfig(INTERFACE_OPER_STATUS, "DOWN")
                  ),
                  token: "danger",
                }
              : undefined
          }
          value={summary ? summary.down : "—"}
        />
        <KpiCard
          description={t("kpi.adminDownHint")}
          icon={CircleMinus}
          label={t("kpi.adminDown")}
          loading={kpiLoading}
          status={
            summary
              ? { label: t("kpi.adminDownStatus"), token: "neutral" }
              : undefined
          }
          value={summary ? summary.adminDown : "—"}
        />
        <KpiCard
          className={cn(
            summary && summary.flapping24h > 0 && "border-warning/40"
          )}
          description={t("kpi.flappingHint")}
          icon={Zap}
          label={t("kpi.flapping")}
          loading={kpiLoading}
          status={
            summary
              ? { label: t("kpi.flappingStatus"), token: "warning" }
              : undefined
          }
          value={summary ? summary.flapping24h : "—"}
        />
      </div>

      {/* ── Filter bar ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t("filters.searchAria")}
            className="h-9 pl-8"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("filters.searchPlaceholder")}
            value={searchInput}
          />
        </div>
        <Select
          onValueChange={(value) => {
            setSite(value);
            setPage(1);
          }}
          value={site}
        >
          <SelectTrigger
            aria-label={t("filters.siteAria")}
            className="h-9 w-full sm:w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filters.allSites")}</SelectItem>
            {sites.map((option) => (
              <SelectItem key={option.id} value={option.code}>
                {option.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setOperStatus(value);
            setPage(1);
          }}
          value={operStatus}
        >
          <SelectTrigger
            aria-label={t("filters.operAria")}
            className="h-9 w-full sm:w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filters.allOper")}</SelectItem>
            {Object.values(INTERFACE_OPER_STATUS).map((config) => (
              <SelectItem key={config.key} value={config.key}>
                {resolveStatusLabel(config)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setAdminStatus(value);
            setPage(1);
          }}
          value={adminStatus}
        >
          <SelectTrigger
            aria-label={t("filters.adminAria")}
            className="h-9 w-full sm:w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filters.allAdmin")}</SelectItem>
            {Object.values(INTERFACE_ADMIN_STATUS).map((config) => (
              <SelectItem key={config.key} value={config.key}>
                {resolveStatusLabel(config)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button onClick={clearFilters} size="sm" variant="ghost">
            <Eraser aria-hidden="true" />
            {tCommon("clear")}
          </Button>
        )}
      </div>

      {/* ── Inventory table ───────────────────────────────────────────── */}
      <SectionCard
        contentClassName="p-0"
        description={t("table.description")}
        title={t("table.title")}
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
              <div
                className="h-11 animate-pulse rounded-md bg-muted/60"
                key={index}
              />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={
                hasFilters
                  ? t("table.emptyFilteredDescription")
                  : t("table.emptyDescription")
              }
              icon={hasFilters ? SearchX : Network}
              title={t("table.emptyTitle")}
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-auto">
            <table
              aria-label={t("table.ariaLabel")}
              className="w-full min-w-[1080px] text-sm"
            >
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.device")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.interface")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.admin")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.oper")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium" scope="col">
                    {t("table.speed")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium" scope="col">
                    {t("table.vlan")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.utilization")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.mac")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.description")}
                  </th>
                  <th className="px-4 py-2 text-start font-medium" scope="col">
                    {t("table.lastFlap")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <InterfaceRowView
                    key={row.id}
                    onOpen={openDevice}
                    openAria={t("table.openRowAria", {
                      device: row.deviceHostname,
                      name: row.name,
                    })}
                    openTitle={t("table.openDevice")}
                    row={row}
                    utilSrLabel={t("table.utilSrOnly", {
                      pct: fmtPct(row.utilizationPct),
                    })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination (prev/next + page x of y) ──────────────────── */}
        {pageInfo && pageInfo.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t("pagination.summary", { count: pageInfo.total })} ·{" "}
              {t("pagination.pageOf", {
                page: pageInfo.page,
                totalPages: pageInfo.totalPages,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                aria-label={t("pagination.prevAria")}
                disabled={pageInfo.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" />
                {t("pagination.prev")}
              </Button>
              <Button
                aria-label={t("pagination.nextAria")}
                disabled={pageInfo.page >= pageInfo.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                {t("pagination.next")}
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
