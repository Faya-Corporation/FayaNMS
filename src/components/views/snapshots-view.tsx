"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  History,
  LoaderCircle,
  Search,
} from "lucide-react";

import { useSnapshots } from "@/hooks/api/use-snapshots";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  SNAPSHOT_SOURCE,
  SNAPSHOT_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import type { FleetSnapshotRow } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import { ConfigDiff } from "@/components/device/config-diff";

/**
 * Fleet Snapshots view (Task 3-b): server-paginated configuration version
 * browser over GET /api/v1/snapshots (metadata only). Compare entry point:
 * pick exactly two rows of the SAME device, then diff them in a dialog.
 * Download/backup history lives in the Backups view (3-a) — this view is
 * the version browser with compare focus.
 */

const ALL = "ALL";
const PAGE_SIZE = 25;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function SnapshotsView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  // Filters (server-side)
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [page, setPage] = useState(1);

  // Debounced device search.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const snapshots = useSnapshots({
    page,
    pageSize: PAGE_SIZE,
    q: q || undefined,
    status: status !== ALL ? status : undefined,
    source: source !== ALL ? source : undefined,
  });

  const rows = snapshots.data?.data ?? [];
  const meta = snapshots.data?.meta;

  // Compare selection: at most two rows, same device. Selection is
  // transient — cleared whenever the query signature changes via the
  // render-time adjustment pattern (no effect-driven resets).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);

  const queryKey = `${q}|${status}|${source}|${page}`;
  const [prevQueryKey, setPrevQueryKey] = useState(queryKey);
  if (prevQueryKey !== queryKey) {
    setPrevQueryKey(queryKey);
    setSelectedIds([]);
  }

  const selectedRows = useMemo(
    () =>
      selectedIds
        .map((id) => rows.find((row) => row.id === id))
        .filter((row): row is FleetSnapshotRow => Boolean(row)),
    [selectedIds, rows]
  );

  const lockedDeviceId = selectedRows[0]?.deviceId ?? null;
  const lockedHostname = selectedRows[0]?.hostname ?? "";
  const selectionFull = selectedRows.length >= 2;
  const selectionValid =
    selectedRows.length === 2 && selectedRows[0].deviceId === selectedRows[1].deviceId;

  const toggleRow = (row: FleetSnapshotRow) => {
    setSelectedIds((current) => {
      if (current.includes(row.id)) {
        return current.filter((id) => id !== row.id);
      }
      if (current.length >= 2) return current;
      return [...current, row.id];
    });
  };

  const [pair, target] = selectedRows;
  const fromVersion = pair && target
    ? Math.min(pair.version, target.version)
    : 0;
  const toVersion = pair && target
    ? Math.max(pair.version, target.version)
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Configuration version history across the fleet — select two versions of the same device to compare"
        title="Snapshots"
      />

      <SectionCard
        contentClassName="p-0"
        description="Every version captured fleet-wide · raw downloads remain audited in the Backups view"
        title="Version browser"
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search by device hostname or IP"
              className="h-8 ps-8 text-xs"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search device…"
              value={searchInput}
            />
          </div>
          <Select
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            value={status}
          >
            <SelectTrigger aria-label="Filter by snapshot status" className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {Object.values(SNAPSHOT_STATUS).map((config) => (
                <SelectItem key={config.key} value={config.key}>
                  {config.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setSource(value);
              setPage(1);
            }}
            value={source}
          >
            <SelectTrigger aria-label="Filter by capture source" className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {Object.values(SNAPSHOT_SOURCE).map((config) => (
                <SelectItem key={config.key} value={config.key}>
                  {config.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              setStatus(ALL);
              setSource(ALL);
              setSearchInput("");
              setPage(1);
            }}
            size="sm"
            variant="ghost"
          >
            Reset
          </Button>

          <div className="ms-auto flex items-center gap-2">
            <Button
              disabled={!selectionValid}
              onClick={() => setDiffOpen(true)}
              size="sm"
            >
              {diffOpen ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <GitCompareArrows aria-hidden="true" />
              )}
              Compare selected
            </Button>
          </div>
        </div>

        {/* Selection hint / lock reason */}
        <div aria-live="polite" className="border-b bg-surface-subtle px-4 py-1.5">
          {selectedRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Tick two versions of one device, then press “Compare selected”.
            </p>
          ) : !selectionFull ? (
            <p className="text-xs text-muted-foreground">
              Comparisons are per-device — first selected:{" "}
              <span className="font-medium text-foreground">{lockedHostname}</span>. Pick a
              second version of it.
            </p>
          ) : selectionValid ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-tech ltr-technical">
                v{fromVersion} → v{toVersion}
              </span>{" "}
              of <span className="font-medium text-foreground">{lockedHostname}</span> ready to
              compare.
            </p>
          ) : (
            <p className="text-xs text-warning">
              Comparisons are per-device — first selected: {lockedHostname}.
            </p>
          )}
        </div>

        {snapshots.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void snapshots.refetch()}
              reason={snapshots.error.message}
              title="Snapshot history could not be loaded"
            />
          </div>
        ) : snapshots.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Trigger “Backup now” from a device, or let a schedule run — captured configurations appear here."
              icon={History}
              title="No snapshots found"
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            <div className="min-w-[1020px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-(--density-row-h) w-10 px-(--density-cell-x)">
                      <span className="sr-only">Select for comparison</span>
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Time</TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Device</TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                      Site
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Version</TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                      Source
                    </TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                      Size
                    </TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                      SHA-256
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Status</TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                      Correlation
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const isSelected = selectedIds.includes(row.id);
                    const checkboxDisabled =
                      (!isSelected && selectionFull) ||
                      (!isSelected &&
                        Boolean(lockedDeviceId) &&
                        row.deviceId !== lockedDeviceId);
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(isSelected && "bg-brand-accent/10")}
                      >
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                          <Checkbox
                            aria-label={`Select ${row.hostname} v${row.version} for comparison`}
                            checked={isSelected}
                            disabled={checkboxDisabled}
                            onCheckedChange={() => toggleRow(row)}
                          />
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground tabular-nums">
                          {format(new Date(row.createdAt), "MMM d, HH:mm")}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                          <button
                            aria-label={`Open ${row.hostname} device detail`}
                            className="text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                            onClick={() =>
                              setActiveView("network.device-detail", { deviceId: row.deviceId })
                            }
                            type="button"
                          >
                            {row.hostname}
                          </button>
                        </TableCell>
                        <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground md:table-cell">
                          {row.siteCode ?? "—"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-sm ltr-technical">
                          v{row.version}
                        </TableCell>
                        <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                          <StatusBadge
                            config={getStatusConfig(SNAPSHOT_SOURCE, row.source)}
                            withIcon={false}
                          />
                        </TableCell>
                        <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs tabular-nums sm:table-cell">
                          {formatSize(row.sizeBytes)}
                        </TableCell>
                        <TableCell
                          className="hidden h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical text-muted-foreground lg:table-cell"
                          title={row.sha256}
                        >
                          {row.sha256.slice(0, 10)}…
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                          <StatusBadge
                            config={getStatusConfig(SNAPSHOT_STATUS, row.status)}
                            withIcon={false}
                          />
                        </TableCell>
                        <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical text-muted-foreground lg:table-cell">
                          {row.correlationId ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Pagination footer */}
        {meta && rows.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {meta.total} snapshot{meta.total === 1 ? "" : "s"} · page{" "}
              {meta.page} of {meta.totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                aria-label="Previous page"
                disabled={meta.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                size="sm"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" />
                Prev
              </Button>
              <Button
                aria-label="Next page"
                disabled={meta.page >= meta.totalPages}
                onClick={() => setPage((p) => p + 1)}
                size="sm"
                variant="outline"
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Compare dialog */}
      <Dialog onOpenChange={setDiffOpen} open={diffOpen}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-[min(95vw,1100px)]">
          <DialogHeader className="border-b">
            <DialogTitle className="font-tech ltr-technical">
              Config diff — {lockedHostname} v{fromVersion} → v{toVersion}
            </DialogTitle>
            <DialogDescription>
              Secrets are masked; switch to raw mode to see the untouched text.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selectionValid && pair && target && (
              <ConfigDiff
                deviceId={pair.deviceId}
                from={fromVersion}
                hostname={pair.hostname}
                maxHeightClass="max-h-[calc(90vh-12rem)]"
                to={toVersion}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
