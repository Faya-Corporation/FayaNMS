"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Network, Search, SearchX } from "lucide-react";

import {
  useDeviceInterfaces,
} from "@/hooks/api/use-device-detail";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  INTERFACE_ADMIN_STATUS,
  INTERFACE_OPER_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";

/** 1000 -> "1 Gbps", 100 -> "100 Mbps", null -> "—". */
function formatSpeed(speedMbps: number | null): string {
  if (speedMbps === null || speedMbps === undefined) return "—";
  if (speedMbps >= 1000) return `${speedMbps / 1000} Gbps`;
  return `${speedMbps} Mbps`;
}

/** BigInt bps counters arrive as strings; render as Mbps. */
function formatBps(value: string | null): string {
  if (value === null) return "—";
  const bps = Number(value);
  if (!Number.isFinite(bps)) return "—";
  const mbps = bps / 1_000_000;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)} Gbps`;
  return `${mbps.toFixed(1)} Mbps`;
}

/**
 * Interfaces tab: per-device interface inventory with search. BigInt
 * counters are stringified by the API and formatted here.
 */
export function DeviceInterfacesTab({ deviceId }: { deviceId: string }) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const interfaces = useDeviceInterfaces(deviceId, query ? { q: query } : {});
  const rows = interfaces.data?.data ?? [];
  const metaInfo = interfaces.data?.meta;

  return (
    <SectionCard
      contentClassName="p-0"
      description={
        metaInfo
          ? `${metaInfo.total} interface${metaInfo.total === 1 ? "" : "s"} discovered on this device`
          : "Interface inventory with admin/oper states and counters"
      }
      title="Interfaces"
      actions={
        <div className="relative w-48 sm:w-56">
          <Search
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search interfaces"
            className="h-8 ps-8"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Filter by name…"
            value={searchInput}
          />
        </div>
      }
    >
      {interfaces.isError ? (
        <div className="p-4">
          <ErrorState
            onRetry={() => void interfaces.refetch()}
            reason={interfaces.error.message}
            title="Interfaces could not be loaded"
          />
        </div>
      ) : interfaces.isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            description={
              query
                ? "No interface matches that filter — clear the search to see the full inventory."
                : "No interfaces have been discovered on this device yet."
            }
            icon={query ? SearchX : Network}
            title={query ? "No matching interfaces" : "No interfaces discovered"}
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Name</TableHead>
                <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Admin</TableHead>
                <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Oper</TableHead>
                <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                  Speed
                </TableHead>
                <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                  VLAN
                </TableHead>
                <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                  MAC
                </TableHead>
                <TableHead className="h-(--density-row-h) px-(--density-cell-x)">In</TableHead>
                <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Out</TableHead>
                <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">
                  MTU
                </TableHead>
                <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">
                  Description
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech ltr-technical">
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium">{row.name}</span>
                      {row.lastFlapAt && (
                        <span className="text-[11px] text-muted-foreground">
                          flapped {format(new Date(row.lastFlapAt), "MMM d, HH:mm")}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                    <StatusBadge
                      config={getStatusConfig(INTERFACE_ADMIN_STATUS, row.adminStatus)}
                      withIcon={false}
                    />
                  </TableCell>
                  <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                    <StatusBadge
                      config={getStatusConfig(INTERFACE_OPER_STATUS, row.operStatus)}
                      withIcon={false}
                    />
                  </TableCell>
                  <TableCell className="hidden h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) font-tech tabular-nums md:table-cell">
                    {formatSpeed(row.speedMbps)}
                  </TableCell>
                  <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums lg:table-cell">
                    {row.vlan ?? "—"}
                  </TableCell>
                  <TableCell className="hidden h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) font-tech ltr-technical lg:table-cell">
                    {row.macAddress ?? "—"}
                  </TableCell>
                  <TableCell className="h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) font-tech tabular-nums">
                    {formatBps(row.countersInBps)}
                  </TableCell>
                  <TableCell className="h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) font-tech tabular-nums">
                    {formatBps(row.countersOutBps)}
                  </TableCell>
                  <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums xl:table-cell">
                    {row.mtu ?? "—"}
                  </TableCell>
                  <TableCell className="hidden h-(--density-row-h) max-w-[22ch] truncate px-(--density-cell-x) text-muted-foreground xl:table-cell">
                    {row.description ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}
