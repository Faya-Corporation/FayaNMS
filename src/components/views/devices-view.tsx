"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CloudUpload,
  Columns3,
  Download,
  Eye,
  FileUp,
  MoreHorizontal,
  PlugZap,
  Plus,
  Search,
  SearchX,
  Wrench,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { DeviceVendorIcon, NetworkDeviceIcon } from "@/components/icons";
import {
  useBulkDeviceAction,
  useDevices,
  useTestConnection,
  useUpdateDevice,
  type DeviceListParams,
  type DeviceSortField,
} from "@/hooks/api/use-devices";
import { useCreateJob } from "@/hooks/api/use-jobs";
import { useMeta } from "@/hooks/api/use-meta";
import { useStatusLabel } from "@/hooks/use-status-label";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { FilterChip } from "@/components/domain/filter-chip";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  apiRequest,
  buildQueryString,
  type DeviceRow as DeviceRowType,
  type UpdateDevicePayload,
} from "@/lib/api-client";
import {
  BACKUP_COMPLIANCE,
  DEVICE_STATUS,
  SEVERITY,
  getStatusConfig,
} from "@/lib/domain/status";
import { useNavigationStore } from "@/stores/navigation";
import {
  DEVICE_COLUMN_LABELS,
  filtersMatch,
  hasActiveFilters,
  useDeviceViewsStore,
  type DeviceColumnKey,
} from "@/stores/device-views";
import { AddDeviceSheet } from "@/components/device/device-form-sheet";
import { CsvImportDialog } from "@/components/device/csv-import-dialog";

const ALL = "ALL";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const EXPORT_CAP = 500;
const EXPORT_PAGE_SIZE = 100;

/* ------------------------------------------------------------------ */
/* CSV export helpers (client-side, current filter + sort set)          */
/* ------------------------------------------------------------------ */

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Wave-9 (audit 9-b P3): CSV formula-injection neutralization — the same
  // standard the reports exporter uses (src/lib/reports/generate.ts).
  // Spreadsheet apps interpret cells BEGINNING with `=`, `+`, `-`, `@` (or
  // a tab/CR before the payload) as formulas/DDE when the exported CSV is
  // opened, so a hostile cell ("=cmd|' /C calc'!A0") would execute in the
  // analyst's spreadsheet. Such cells get the OWASP leading-' guard, which
  // forces text interpretation. Pure numbers (optionally signed/decimal)
  // are exempt: a negative number is data, never a formula, and the guard
  // would corrupt legitimate numeric exports. Clean cells are byte-identical.
  const FORMULA_PREFIX = /^[=+\-@\t\r]/;
  const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
  const neutralized =
    text !== "" && FORMULA_PREFIX.test(text) && !PLAIN_NUMBER.test(text)
      ? `'${text}`
      : text;
  return /[",\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

function buildDeviceCsv(rows: DeviceRowType[]): string {
  const header = [
    "hostname",
    "display_name",
    "mgmt_ip",
    "vendor",
    "model",
    "site",
    "status",
    "criticality",
    "health_score",
    "backup_compliance",
    "last_backup_at",
    "last_seen",
    "interfaces",
    "snapshots",
    "alerts",
  ];
  const lines = rows.map((device) =>
    [
      device.hostname,
      device.displayName,
      device.mgmtIp,
      device.vendor?.name ?? "",
      device.model,
      device.site?.name ?? "",
      device.status,
      device.criticality,
      device.healthScore,
      device.backupCompliance,
      device.lastBackupAt,
      device.lastSeen,
      device._count.interfaces,
      device._count.snapshots,
      device._count.alerts,
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Sortable header                                                      */
/* ------------------------------------------------------------------ */

function SortableHead({
  label,
  field,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  field: DeviceSortField;
  sort: DeviceSortField;
  dir: "asc" | "desc";
  onSort: (field: DeviceSortField) => void;
  className?: string;
}) {
  const active = sort === field;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  // HC-4 (R56): the sort-announcer reads the COLUMN label; the label text
  // itself is resolved by the caller from the devices columns namespace.
  const t = useTranslations("devices");
  return (
    <TableHead aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <button
        aria-label={t("table.sortAria", { field: label })}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm text-xs font-medium transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground"
        )}
        onClick={() => onSort(field)}
        type="button"
      >
        {label}
        <Icon aria-hidden="true" className="size-3" />
      </button>
    </TableHead>
  );
}

/* ------------------------------------------------------------------ */
/* Memoized device row (Phase 9-b perf pass)                            */
/* ------------------------------------------------------------------ */

interface DeviceRowProps {
  device: DeviceRowType;
  isSelected: boolean;
  highlighted: boolean;
  columns: Record<DeviceColumnKey, boolean>;
  onOpenDetail: (deviceId: string) => void;
  onSelectRow: (deviceId: string, checked: boolean) => void;
  onBackup: (deviceId: string) => void;
  onTestConnection: (deviceId: string) => void;
  onToggleMaintenance: (device: DeviceRowType) => void;
  actionsPending: boolean;
  testPending: boolean;
}

/** React.memo'd inventory row — skips re-render when the device record,
 * selection state, column set or callbacks are unchanged (typing in the
 * search box or toggling filters no longer re-renders every row). */
const DeviceRow = memo(function DeviceRow({
  device,
  isSelected,
  highlighted,
  columns,
  onOpenDetail,
  onSelectRow,
  onBackup,
  onTestConnection,
  onToggleMaintenance,
  actionsPending,
  testPending,
}: DeviceRowProps) {
  const tDevices = useTranslations("devices");
  return (
    <TableRow data-state={isSelected ? "selected" : undefined} className={cn(highlighted && "bg-primary/5")}>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <Checkbox
          aria-label={tDevices("rows.selectAria", { hostname: device.hostname })}
          checked={isSelected}
          onCheckedChange={(checked) => onSelectRow(device.id, checked === true)}
        />
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <button
          className="flex max-w-[24ch] items-start gap-2 leading-tight hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent sm:max-w-none"
          onClick={() => onOpenDetail(device.id)}
          title={tDevices("rows.openTitle", { hostname: device.hostname })}
          type="button"
        >
          {/* Device-type glyph (decorative — hostname labels the row). */}
          <NetworkDeviceIcon className="mt-0.5" deviceType={device.role} />
          <span className="flex min-w-0 flex-col items-start">
            <span className="flex items-center gap-1.5">
              <span className="font-tech truncate font-medium ltr-technical">
                {device.hostname}
              </span>
              {/* Data-plane chip (Phase 22) — LIVE devices are reached by the
                  worker over REAL SSH (exec-only, read-only). */}
              {device.dataSource === "LIVE_SSH" && (
                <span
                  className="shrink-0 rounded-full border border-brand-accent/40 bg-brand-accent/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand-accent"
                  title={tDevices("rows.liveTitle")}
                >
                  LIVE
                </span>
              )}
            </span>
            {device.displayName && device.displayName !== device.hostname && (
              <span className="max-w-[28ch] truncate text-xs text-muted-foreground">
                {device.displayName}
              </span>
            )}
          </span>
        </button>
      </TableCell>
      {columns.status && (
        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
          <DeviceStatusBadge value={device.status} />
        </TableCell>
      )}
      {columns.mgmtIp && (
        <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech ltr-technical">
          {device.mgmtIp}
        </TableCell>
      )}
      {columns.vendor && (
        <TableCell className="h-(--density-row-h) whitespace-nowrap px-(--density-cell-x)">
          <span className="flex items-center gap-1.5">
            {/* Vendor glyph (decorative — vendor name labels the cell). */}
            <DeviceVendorIcon vendor={device.vendor?.key} />
            <span>{device.vendor?.name ?? "—"}</span>
          </span>
        </TableCell>
      )}
      {columns.model && (
        <TableCell className="hidden h-(--density-row-h) max-w-[18ch] truncate whitespace-nowrap px-(--density-cell-x) text-muted-foreground md:table-cell">
          {device.model ?? "—"}
        </TableCell>
      )}
      {columns.site && (
        <TableCell className="hidden h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) lg:table-cell">
          {device.site?.name ?? "—"}
        </TableCell>
      )}
      {columns.criticality && (
        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
          <StatusBadge
            config={getStatusConfig(SEVERITY, device.criticality)}
            withIcon={false}
          />
        </TableCell>
      )}
      {columns.backup && (
        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
          <span className="flex flex-col gap-0.5 leading-tight">
            <span className="whitespace-nowrap text-xs tabular-nums">
              {device.lastBackupAt
                ? formatDistanceToNow(new Date(device.lastBackupAt), {
                    addSuffix: true,
                  })
                : tDevices("rows.never")}
            </span>
            <BackupComplianceBadge className="w-fit" value={device.backupCompliance} />
          </span>
        </TableCell>
      )}
      {columns.lastSeen && (
        <TableCell className="hidden h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) text-xs text-muted-foreground tabular-nums sm:table-cell">
          {device.lastSeen
            ? formatDistanceToNow(new Date(device.lastSeen), {
                addSuffix: true,
              })
            : "—"}
        </TableCell>
      )}
      {columns.health && (
        <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "block h-full rounded-full",
                  device.healthScore >= 80
                    ? "bg-success"
                    : device.healthScore >= 50
                      ? "bg-warning"
                      : "bg-danger"
                )}
                style={{ width: `${device.healthScore}%` }}
              />
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {device.healthScore}
            </span>
          </span>
        </TableCell>
      )}
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={tDevices("rows.actionsAria", { hostname: device.hostname })} size="icon" variant="ghost">
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="font-tech truncate ltr-technical">
              {device.hostname}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpenDetail(device.id)}>
              <Eye aria-hidden="true" />
              {tDevices("rows.openDetail")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={device.status === "UNMANAGED" || actionsPending}
              onClick={() => onBackup(device.id)}
            >
              <CloudUpload aria-hidden="true" />
              {tDevices("rows.backupNow")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={testPending} onClick={() => onTestConnection(device.id)}>
              <PlugZap aria-hidden="true" />
              {tDevices("rows.testConnection")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={actionsPending}
              onClick={() => onToggleMaintenance(device)}
            >
              <Wrench aria-hidden="true" />
              {device.status === "MAINTENANCE"
                ? tDevices("rows.exitMaintenance")
                : tDevices("rows.enterMaintenance")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

/**
 * Device inventory (Phase 2): server-side sort/filter/pagination DataTable
 * with column visibility, row selection + bulk actions, saved views and a
 * full detail drill-down. Row/cell spacing uses the density tokens so the
 * header density toggle applies end-to-end.
 */
export function DevicesView() {
  const { toast } = useToast();
  const t = useTranslations("devices");
  const tCommon = useTranslations("common");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const params = useNavigationStore((state) => state.params);
  // Status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();

  const filters = useDeviceViewsStore((state) => state.filters);
  const setFilter = useDeviceViewsStore((state) => state.setFilter);
  const resetFilters = useDeviceViewsStore((state) => state.resetFilters);
  const toggleSort = useDeviceViewsStore((state) => state.toggleSort);
  const savedViews = useDeviceViewsStore((state) => state.savedViews);
  const saveView = useDeviceViewsStore((state) => state.saveView);
  const removeView = useDeviceViewsStore((state) => state.removeView);
  const applyView = useDeviceViewsStore((state) => state.applyView);
  const columns = useDeviceViewsStore((state) => state.columns);
  const toggleColumn = useDeviceViewsStore((state) => state.toggleColumn);
  const rememberMaintenance = useDeviceViewsStore((state) => state.rememberMaintenance);
  const recallMaintenance = useDeviceViewsStore((state) => state.recallMaintenance);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const [exporting, setExporting] = useState(false);

  const meta = useMeta();
  const devices = useDevices({
    q: filters.q || undefined,
    status: filters.status !== ALL ? filters.status : undefined,
    vendorId: filters.vendorId !== ALL ? filters.vendorId : undefined,
    siteId: filters.siteId !== ALL ? filters.siteId : undefined,
    criticality: filters.criticality !== ALL ? filters.criticality : undefined,
    backupCompliance: filters.backupCompliance !== ALL ? filters.backupCompliance : undefined,
    sort: filters.sort,
    dir: filters.dir,
    page,
    pageSize,
  });

  const createJob = useCreateJob();
  const bulkAction = useBulkDeviceAction();
  const testConnection = useTestConnection();
  const updateDevice = useUpdateDevice();

  const rows = devices.data?.data ?? [];
  const metaInfo = devices.data?.meta;

  // Debounce the search box into the persisted filter set.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      if (next !== filters.q) {
        setFilter("q", next);
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Keep the search box in sync when filters change via saved views / reset.
  // Render-time adjustment (React docs: "adjusting state when props change") —
  // eslint-plugin-react-hooks v7 forbids synchronous setState inside effects.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (syncedQ !== filters.q) {
    setSyncedQ(filters.q);
    setSearchInput((current) => (current.trim() === filters.q ? current : filters.q));
  }

  // Selection is page-scoped: drop it whenever the result set changes.
  // Render-time adjustment (same pattern as above — no sync setState in effects).
  const [selEpoch, setSelEpoch] = useState({ page, pageSize, filters });
  if (
    selEpoch.page !== page ||
    selEpoch.pageSize !== pageSize ||
    selEpoch.filters !== filters
  ) {
    setSelEpoch({ page, pageSize, filters });
    setSelected(new Set());
  }

  // Command palette routes device results straight to the detail view.
  useEffect(() => {
    const selectedId = params?.selectedId;
    if (!selectedId) return;
    // Deferred navigation: no synchronous store update inside the effect body
    // (eslint-plugin-react-hooks v7 set-state-in-effect).
    const t = setTimeout(() => {
      setActiveView("network.device-detail", { deviceId: selectedId });
    }, 0);
    return () => clearTimeout(t);
  }, [params?.selectedId, setActiveView]);

  // Sites view drill-down: apply the site filter from navigation params.
  useEffect(() => {
    const siteId = params?.siteId;
    if (!siteId) return;
    // Deferred store update: no synchronous setState inside the effect body
    // (eslint-plugin-react-hooks v7 set-state-in-effect).
    const t = setTimeout(() => {
      setFilter("siteId", siteId);
      setPage(1);
    }, 0);
    return () => clearTimeout(t);
  }, [params?.siteId, setFilter]);

  const activeFilterChips = useMemo(() => {
    const chips: { label: string; value: string; clear: () => void }[] = [];
    if (filters.q) {
      chips.push({ label: t("chips.search"), value: filters.q, clear: () => setSearchInput("") });
    }
    if (filters.status !== ALL) {
      chips.push({
        label: t("chips.status"),
        value: resolveStatusLabel(getStatusConfig(DEVICE_STATUS, filters.status)),
        clear: () => {
          setFilter("status", ALL);
          setPage(1);
        },
      });
    }
    if (filters.vendorId !== ALL) {
      const vendor = meta.data?.vendors.find((entry) => entry.id === filters.vendorId);
      chips.push({
        label: t("chips.vendor"),
        value: vendor?.name ?? filters.vendorId,
        clear: () => {
          setFilter("vendorId", ALL);
          setPage(1);
        },
      });
    }
    if (filters.siteId !== ALL) {
      const site = meta.data?.sites.find((entry) => entry.id === filters.siteId);
      chips.push({
        label: t("chips.site"),
        value: site?.name ?? filters.siteId,
        clear: () => {
          setFilter("siteId", ALL);
          setPage(1);
        },
      });
    }
    if (filters.criticality !== ALL) {
      chips.push({
        label: t("chips.criticality"),
        value: resolveStatusLabel(getStatusConfig(SEVERITY, filters.criticality)),
        clear: () => {
          setFilter("criticality", ALL);
          setPage(1);
        },
      });
    }
    if (filters.backupCompliance !== ALL) {
      chips.push({
        label: t("chips.backup"),
        value: resolveStatusLabel(getStatusConfig(BACKUP_COMPLIANCE, filters.backupCompliance)),
        clear: () => {
          setFilter("backupCompliance", ALL);
          setPage(1);
        },
      });
    }
    return chips;
  }, [filters, meta.data, setFilter, resolveStatusLabel]);

  // Row callbacks are kept identity-stable (useCallback) so the memoized
  // DeviceRow skips re-renders while typing/filtering (Phase 9-b perf pass).
  const openDetail = useCallback(
    (deviceId: string) => setActiveView("network.device-detail", { deviceId }),
    [setActiveView]
  );

  const handleSort = (field: DeviceSortField) => {
    toggleSort(field);
    setPage(1);
  };

  const allOnPageSelected = rows.length > 0 && rows.every((device) => selected.has(device.id));

  const handleSelectAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) {
        rows.forEach((device) => next.delete(device.id));
      } else {
        rows.forEach((device) => next.add(device.id));
      }
      return next;
    });
  };

  const handleSelectRow = useCallback((deviceId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
  }, []);

  const handleBackupNow = useCallback(
    (deviceIds: string[]) => {
      if (deviceIds.length === 0) return;
      if (deviceIds.length === 1) {
        createJob.mutate({ type: "CONFIG_BACKUP", deviceId: deviceIds[0] });
      } else {
        bulkAction.mutate({ action: "backup_now", deviceIds });
      }
    },
    [createJob.mutate, bulkAction.mutate]
  );

  const handleTestConnection = useCallback(
    (deviceId: string) => testConnection.mutate(deviceId),
    [testConnection.mutate]
  );

  const handleBackupDevice = useCallback(
    (deviceId: string) => handleBackupNow([deviceId]),
    [handleBackupNow]
  );

  const handleToggleMaintenance = useCallback(
    (device: DeviceRowType) => {
      if (device.status === "MAINTENANCE") {
        const previous = recallMaintenance(device.id);
        const restore =
          previous && previous !== "MAINTENANCE"
            ? (previous as UpdateDevicePayload["status"])
            : ("ONLINE" as const);
        updateDevice.mutate({ id: device.id, data: { status: restore } });
      } else {
        rememberMaintenance(device.id, device.status);
        updateDevice.mutate({ id: device.id, data: { status: "MAINTENANCE" } });
      }
    },
    [recallMaintenance, rememberMaintenance, updateDevice.mutate]
  );

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const baseParams = {
        q: filters.q || undefined,
        status: filters.status !== ALL ? filters.status : undefined,
        vendorId: filters.vendorId !== ALL ? filters.vendorId : undefined,
        siteId: filters.siteId !== ALL ? filters.siteId : undefined,
        criticality: filters.criticality !== ALL ? filters.criticality : undefined,
        backupCompliance: filters.backupCompliance !== ALL ? filters.backupCompliance : undefined,
        sort: filters.sort,
        dir: filters.dir,
      };
      const first = await apiRequest<DeviceRowType[]>(
        `/api/v1/devices${buildQueryString({ ...baseParams, page: 1, pageSize: EXPORT_PAGE_SIZE })}`
      );
      const allRows = [...first.data];
      const pagesMeta = first.meta as unknown as { totalPages: number };
      const maxPages = Math.min(
        pagesMeta.totalPages,
        Math.ceil(EXPORT_CAP / EXPORT_PAGE_SIZE)
      );
      for (let nextPage = 2; nextPage <= maxPages; nextPage += 1) {
        if (allRows.length >= EXPORT_CAP) break;
        const next = await apiRequest<DeviceRowType[]>(
          `/api/v1/devices${buildQueryString({ ...baseParams, page: nextPage, pageSize: EXPORT_PAGE_SIZE })}`
        );
        allRows.push(...next.data);
      }
      const capped = allRows.slice(0, EXPORT_CAP);
      downloadCsv(
        `fayanms-devices-${format(new Date(), "yyyyMMdd-HHmm")}.csv`,
        buildDeviceCsv(capped)
      );
      toast({
        title: t("toast.exportedTitle", { count: capped.length }),
        description:
          allRows.length > EXPORT_CAP
            ? t("toast.exportCapped", { cap: EXPORT_CAP, total: allRows.length })
            : t("toast.exportBody"),
      });
    } catch (error) {
      toast({
        title: t("toast.exportFailed"),
        description: error instanceof Error ? error.message : t("toast.unknownError"),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleSaveView = () => {
    const created = saveView(saveViewName);
    if (created) {
      setSaveViewName("");
      setSaveViewOpen(false);
      toast({
        title: t("savedViews.savedTitle"),
        description: t("savedViews.savedBody", { name: created.name }),
      });
    }
  };

  const activeSavedView = savedViews.find((view) =>
    filtersMatch(view.filters, filters)
  );

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const bulkPending = createJob.isPending || bulkAction.isPending;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        actions={
          <Button onClick={() => setCsvOpen(true)} variant="outline">
            <FileUp aria-hidden="true" />
            {t("actions.importCsv")}
          </Button>
        }
        description={t("page.description")}
        primaryAction={
          <Button onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" />
            {t("actions.addDevice")}
          </Button>
        }
        title={t("page.title")}
      />

      {/* Saved views strip */}
      <div className="flex flex-wrap items-center gap-2">
        {savedViews.map((view) => (
          <span key={view.id} className="relative inline-flex items-center">
            <button
              aria-label={t("savedViews.applyAria", { name: view.name })}
              className={cn(
                "rounded-md transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent",
                activeSavedView?.id === view.id && "ring-2 ring-primary/40"
              )}
              onClick={() => {
                applyView(view.id);
                setPage(1);
              }}
              type="button"
            >
              <FilterChip label={t("savedViews.chip")} value={view.name} />
            </button>
            <button
              aria-label={t("savedViews.removeAria", { name: view.name })}
              className="absolute -end-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors after:absolute after:-inset-1 after:rounded-full after:content-[''] hover:text-danger"
              onClick={() => removeView(view.id)}
              type="button"
            >
              <span aria-hidden="true" className="text-[9px] leading-none">
                ✕
              </span>
            </button>
          </span>
        ))}
        <Popover onOpenChange={setSaveViewOpen} open={saveViewOpen}>
          <PopoverTrigger asChild>
            <Button
              disabled={!hasActiveFilters(filters)}
              size="sm"
              variant="outline"
            >
              <BookmarkPlus aria-hidden="true" />
              {t("savedViews.save")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSaveView();
              }}
            >
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="save-view-name"
              >
                {t("savedViews.nameLabel")}
              </label>
              <Input
                autoFocus
                className="mt-1.5 h-8"
                id="save-view-name"
                maxLength={40}
                onChange={(event) => setSaveViewName(event.target.value)}
                placeholder={t("savedViews.namePlaceholder")}
                value={saveViewName}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button onClick={() => setSaveViewOpen(false)} size="sm" variant="ghost" type="button">
                  {tCommon("cancel")}
                </Button>
                <Button disabled={!saveViewName.trim()} size="sm" type="submit">
                  <Check aria-hidden="true" />
                  {tCommon("save")}
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
        {!hasActiveFilters(filters) && savedViews.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {t("savedViews.tip")}
          </span>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-2" data-tour="devices-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={t("toolbar.searchAria")}
              className="h-9 ps-8"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("toolbar.searchPlaceholder")}
              value={searchInput}
            />
          </div>
          <Select
            onValueChange={(value) => {
              setFilter("status", value);
              setPage(1);
            }}
            value={filters.status}
          >
            <SelectTrigger aria-label={t("toolbar.statusAria")} className="h-9 w-full sm:w-36">
              <SelectValue placeholder={t("chips.status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("toolbar.allStatuses")}</SelectItem>
              {Object.values(DEVICE_STATUS).map((config) => (
                <SelectItem key={config.key} value={config.key}>
                  {resolveStatusLabel(config)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setFilter("vendorId", value);
              setPage(1);
            }}
            value={filters.vendorId}
          >
            <SelectTrigger aria-label={t("toolbar.vendorAria")} className="h-9 w-full sm:w-40">
              <SelectValue placeholder={t("chips.vendor")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("toolbar.allVendors")}</SelectItem>
              {(meta.data?.vendors ?? []).map((vendor) => (
                <SelectItem key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setFilter("siteId", value);
              setPage(1);
            }}
            value={filters.siteId}
          >
            <SelectTrigger aria-label={t("toolbar.siteAria")} className="h-9 w-full sm:w-40">
              <SelectValue placeholder={t("chips.site")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("toolbar.allSites")}</SelectItem>
              {(meta.data?.sites ?? []).map((site) => (
                <SelectItem key={site.id} value={site.id}>
                  {site.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setFilter("criticality", value);
              setPage(1);
            }}
            value={filters.criticality}
          >
            <SelectTrigger aria-label={t("toolbar.criticalityAria")} className="h-9 w-full sm:w-36">
              <SelectValue placeholder={t("chips.criticality")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("toolbar.allCriticality")}</SelectItem>
              {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((key) => (
                <SelectItem key={key} value={key}>
                  {resolveStatusLabel(getStatusConfig(SEVERITY, key))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setFilter("backupCompliance", value);
              setPage(1);
            }}
            value={filters.backupCompliance}
          >
            <SelectTrigger aria-label={t("toolbar.backupAria")} className="h-9 w-full sm:w-40">
              <SelectValue placeholder={t("chips.backup")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("toolbar.allBackupStates")}</SelectItem>
              {Object.values(BACKUP_COMPLIANCE).map((config) => (
                <SelectItem key={config.key} value={config.key}>
                  {resolveStatusLabel(config)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ms-auto flex items-center gap-2">
            <Button
              disabled={exporting}
              onClick={() => void handleExportCsv()}
              size="sm"
              variant="outline"
            >
              <Download aria-hidden="true" />
              {exporting ? t("toolbar.exporting") : t("toolbar.exportCsv")}
            </Button>
            {/* Column visibility (persisted) */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label={t("toolbar.columnsAria")} size="sm" variant="outline">
                  <Columns3 aria-hidden="true" />
                  {t("toolbar.columns")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>{t("toolbar.visibleColumns")}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(Object.keys(DEVICE_COLUMN_LABELS) as DeviceColumnKey[]).map((key) => (
                  <DropdownMenuCheckboxItem
                    checked={columns[key]}
                    key={key}
                    onCheckedChange={() => toggleColumn(key)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t(`columns.${key}`)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {(activeFilterChips.length > 0 || hasActiveFilters(filters)) && (
          <div className="flex flex-wrap items-center gap-2">
            {activeFilterChips.map((chip) => (
              <FilterChip
                key={chip.label}
                label={chip.label}
                onRemove={chip.clear}
                value={chip.value}
              />
            ))}
            <Button
              onClick={() => {
                resetFilters();
                setSearchInput("");
                setPage(1);
              }}
              size="sm"
              variant="ghost"
            >
              {t("toolbar.reset")}
            </Button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5"
        >
          <span className="text-sm font-medium">
            {t("bulk.selected", { count: selected.size })}
          </span>
          <Button
            disabled={bulkPending}
            onClick={() => handleBackupNow(selectedIds)}
            size="sm"
          >
            <CloudUpload aria-hidden="true" />
            {t("bulk.backupNow")}
          </Button>
          <Button
            disabled={exporting}
            onClick={() => void handleExportCsv()}
            size="sm"
            variant="outline"
          >
            <Download aria-hidden="true" />
            {t("toolbar.exportCsv")}
          </Button>
          <Button
            onClick={() => setSelected(new Set())}
            size="sm"
            variant="ghost"
          >
            {tCommon("clear")}
          </Button>
        </div>
      )}

      {/* Table */}
      <SectionCard contentClassName="p-0" title={t("table.cardTitle")}>
        {devices.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void devices.refetch()}
              reason={devices.error.message}
              title={t("table.errorTitle")}
            />
          </div>
        ) : devices.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-12 animate-pulse rounded-md bg-muted/60"
              />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("table.emptyDescription")}
              icon={SearchX}
              title={t("table.emptyTitle")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("table.aria")} className="min-w-[980px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) w-10">
                    <Checkbox
                      aria-label={t("table.selectAllAria")}
                      checked={
                        allOnPageSelected
                          ? true
                          : selected.size > 0
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={() => handleSelectAll()}
                    />
                  </TableHead>
                  <SortableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    dir={filters.dir}
                    field="hostname"
                    label={t("columns.hostname")}
                    onSort={handleSort}
                    sort={filters.sort}
                  />
                  {columns.status && (
                    <SortableHead
                      className="h-(--density-row-h) px-(--density-cell-x)"
                      dir={filters.dir}
                      field="status"
                      label={t("columns.status")}
                      onSort={handleSort}
                      sort={filters.sort}
                    />
                  )}
                  {columns.mgmtIp && (
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      {t("columns.mgmtIp")}
                    </TableHead>
                  )}
                  {columns.vendor && (
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      {t("columns.vendor")}
                    </TableHead>
                  )}
                  {columns.model && (
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                      {t("columns.model")}
                    </TableHead>
                  )}
                  {columns.site && (
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                      {t("columns.site")}
                    </TableHead>
                  )}
                  {columns.criticality && (
                    <SortableHead
                      className="h-(--density-row-h) px-(--density-cell-x)"
                      dir={filters.dir}
                      field="criticality"
                      label={t("columns.criticality")}
                      onSort={handleSort}
                      sort={filters.sort}
                    />
                  )}
                  {columns.backup && (
                    <SortableHead
                      className="h-(--density-row-h) px-(--density-cell-x)"
                      dir={filters.dir}
                      field="lastBackupAt"
                      label={t("columns.backup")}
                      onSort={handleSort}
                      sort={filters.sort}
                    />
                  )}
                  {columns.lastSeen && (
                    <SortableHead
                      className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell"
                      dir={filters.dir}
                      field="lastSeen"
                      label={t("columns.lastSeen")}
                      onSort={handleSort}
                      sort={filters.sort}
                    />
                  )}
                  {columns.health && (
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                      {t("columns.health")}
                    </TableHead>
                  )}
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) w-10" />
                </TableRow>
              </TableHeader>
              <TableBody className="table-virtualized">
                {rows.map((device) => (
                  <DeviceRow
                    actionsPending={bulkPending}
                    columns={columns}
                    device={device}
                    highlighted={device.id === params?.selectedId}
                    isSelected={selected.has(device.id)}
                    key={device.id}
                    onBackup={handleBackupDevice}
                    onOpenDetail={openDetail}
                    onSelectRow={handleSelectRow}
                    onTestConnection={handleTestConnection}
                    onToggleMaintenance={handleToggleMaintenance}
                    testPending={testConnection.isPending}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {metaInfo && metaInfo.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t("pagination.summary", {
                total: metaInfo.total,
                page: metaInfo.page,
                pages: metaInfo.totalPages,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Select
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
                value={String(pageSize)}
              >
                <SelectTrigger aria-label={t("pagination.rowsAria")} className="h-8 w-[6.5rem] text-xs" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t("pagination.perPage", { option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Button
                  aria-label={t("pagination.prevAria")}
                  disabled={metaInfo.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  size="sm"
                  variant="outline"
                >
                  <ChevronLeft aria-hidden="true" />
                  {t("pagination.prev")}
                </Button>
                <Button
                  aria-label={t("pagination.nextAria")}
                  disabled={metaInfo.page >= metaInfo.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  size="sm"
                  variant="outline"
                >
                  {t("pagination.next")}
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <AddDeviceSheet onOpenChange={setAddOpen} open={addOpen} />
      <CsvImportDialog onOpenChange={setCsvOpen} open={csvOpen} />
    </div>
  );
}
