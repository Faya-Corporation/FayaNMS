"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Eye,
  MoreHorizontal,
  Search,
  SearchX,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useCreateJob } from "@/hooks/api/use-jobs";
import { useDevices } from "@/hooks/api/use-devices";
import { useMeta } from "@/hooks/api/use-meta";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { FilterChip } from "@/components/domain/filter-chip";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { cn } from "@/lib/utils";
import { DEVICE_STATUS, getStatusConfig, SEVERITY } from "@/lib/domain/status";
import { useNavigationStore } from "@/stores/navigation";

const PAGE_SIZE = 10;

function healthTone(score: number): string {
  if (score >= 80) return "bg-success";
  if (score >= 50) return "bg-warning";
  return "bg-danger";
}

/**
 * Device inventory list (Phase 1 slice): server-side search/filter/pagination
 * over /api/v1/devices with backup-now action. Full detail lands in Phase 2.
 */
export function DevicesView() {
  const { toast } = useToast();
  const createJob = useCreateJob();
  const meta = useMeta();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [vendorId, setVendorId] = useState("ALL");
  const [page, setPage] = useState(1);

  const params = useNavigationStore((state) => state.params);

  // Debounce the search box into the actual query param.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const devices = useDevices({
    search: search || undefined,
    status: status === "ALL" ? undefined : status,
    vendorId: vendorId === "ALL" ? undefined : vendorId,
    sort: "hostname",
    dir: "asc",
    page,
    pageSize: PAGE_SIZE,
  });

  const rows = devices.data?.data ?? [];
  const metaInfo = devices.data?.meta;
  const hasFilters = Boolean(search) || status !== "ALL" || vendorId !== "ALL";

  // Command palette can route here with a selected device.
  useEffect(() => {
    const selectedId = params?.selectedId;
    if (selectedId) {
      toast({
        title: "Device detail arrives with Phase 2",
        description: "The full device record will open here in Phase 2.",
      });
    }
  }, [params?.selectedId, toast]);

  const vendorName = useMemo(() => {
    if (vendorId === "ALL") return null;
    return meta.data?.vendors.find((vendor) => vendor.id === vendorId)?.name ?? null;
  }, [vendorId, meta.data]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Multi-vendor device inventory with health, backups and actions"
        primaryAction={
          <Button
            onClick={() =>
              toast({
                title: "Add Device arrives with Phase 2",
                description: "Discovery scan and CSV import ship with the inventory module.",
              })
            }
          >
            Add Device
          </Button>
        }
        title="Devices"
      />

      {/* Filter bar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search devices"
              className="pl-8"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search hostname, IP…"
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
            <SelectTrigger aria-label="Filter by status" className="h-9 sm:w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {Object.values(DEVICE_STATUS).map((config) => (
                <SelectItem key={config.key} value={config.key}>
                  {config.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setVendorId(value);
              setPage(1);
            }}
            value={vendorId}
          >
            <SelectTrigger aria-label="Filter by vendor" className="h-9 sm:w-44">
              <SelectValue placeholder="Vendor" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All vendors</SelectItem>
              {(meta.data?.vendors ?? []).map((vendor) => (
                <SelectItem key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {hasFilters && (
          <div className="flex flex-wrap items-center gap-2">
            {search && (
              <FilterChip
                label="Search"
                onRemove={() => setSearchInput("")}
                value={search}
              />
            )}
            {status !== "ALL" && (
              <FilterChip
                label="Status"
                onRemove={() => setStatus("ALL")}
                value={getStatusConfig(DEVICE_STATUS, status).label}
              />
            )}
            {vendorName && (
              <FilterChip
                label="Vendor"
                onRemove={() => setVendorId("ALL")}
                value={vendorName}
              />
            )}
            <Button
              onClick={() => {
                setSearchInput("");
                setStatus("ALL");
                setVendorId("ALL");
                setPage(1);
              }}
              size="sm"
              variant="ghost"
            >
              Reset
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <SectionCard contentClassName="p-0" title="Inventory">
        {devices.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void devices.refetch()}
              reason={devices.error.message}
              title="Devices could not be loaded"
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
              description="Adjust the filters above, or add devices in Phase 2 via discovery and CSV import."
              icon={SearchX}
              title="No devices match the current filters"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Management IP</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="hidden md:table-cell">Model</TableHead>
                  <TableHead className="hidden lg:table-cell">Site</TableHead>
                  <TableHead>Criticality</TableHead>
                  <TableHead>Last Backup</TableHead>
                  <TableHead className="hidden sm:table-cell">Health</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((device) => (
                  <TableRow
                    className={cn(
                      device.id === params?.selectedId && "bg-primary/5"
                    )}
                    key={device.id}
                  >
                    <TableCell>
                      <DeviceStatusBadge value={device.status} />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col leading-tight">
                        <span className="font-medium">{device.hostname}</span>
                        {device.displayName && device.displayName !== device.hostname && (
                          <span className="text-xs text-muted-foreground">
                            {device.displayName}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="font-tech ltr-technical">
                      {device.mgmtIp}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {device.vendor?.name ?? "—"}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                      {device.model ?? "—"}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap lg:table-cell">
                      {device.site ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-muted-foreground">{device.site.name}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        config={getStatusConfig(SEVERITY, device.criticality)}
                        withIcon={false}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1 leading-tight">
                        <span className="whitespace-nowrap text-xs tabular-nums">
                          {device.lastBackupAt
                            ? formatDistanceToNow(new Date(device.lastBackupAt), {
                                addSuffix: true,
                              })
                            : "never"}
                        </span>
                        <BackupComplianceBadge
                          className="w-fit"
                          value={device.backupCompliance}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"
                        >
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              healthTone(device.healthScore)
                            )}
                            style={{ width: `${device.healthScore}%` }}
                          />
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {device.healthScore}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button aria-label={`Actions for ${device.hostname}`} size="icon" variant="ghost">
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel className="truncate">
                            {device.hostname}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={device.status === "UNMANAGED" || createJob.isPending}
                            onClick={() =>
                              createJob.mutate(
                                { type: "CONFIG_BACKUP", deviceId: device.id },
                                { onSuccess: undefined }
                              )
                            }
                          >
                            <CloudUpload aria-hidden="true" />
                            Backup now
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              toast({
                                title: "Device detail arrives with Phase 2",
                                description: `${device.hostname} — tabs for interfaces, configs, backups and more.`,
                              })
                            }
                          >
                            <Eye aria-hidden="true" />
                            View details
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {metaInfo && metaInfo.total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {metaInfo.total} device{metaInfo.total === 1 ? "" : "s"} · page{" "}
              {metaInfo.page} of {metaInfo.totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                aria-label="Previous page"
                disabled={metaInfo.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                size="sm"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" />
                Prev
              </Button>
              <Button
                aria-label="Next page"
                disabled={metaInfo.page >= metaInfo.totalPages}
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
    </div>
  );
}
