"use client";

import { formatDistanceToNow, parseISO } from "date-fns";
import { Cpu, HeartPulse, RefreshCcw, Server, Zap } from "lucide-react";

import { useCollectors } from "@/hooks/api/use-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { cn } from "@/lib/utils";

/**
 * Administration → Collectors (Task 7-b).
 *
 * Live poller/collector registry: the bun worker (:3030) plus the logical
 * engines (config collector, alert engine, retention). The endpoint probes
 * worker /health on every request and upserts state; the table auto
 * refreshes every 10 s.
 */

const KIND_LABELS: Record<string, string> = {
  POLLER: "Poller",
  CONFIG_COLLECTOR: "Config collector",
  ALERT_ENGINE: "Alert engine",
  RETENTION: "Retention engine",
};

export function AdminCollectorsView() {
  const collectorsQuery = useCollectors();
  const collectors = collectorsQuery.data?.collectors ?? [];
  const workerReachable = collectorsQuery.data?.workerReachable ?? false;
  const online = collectors.filter((c) => c.status === "ONLINE").length;
  const jobsCompleted = collectors.reduce(
    (sum, c) => sum + Number(c.stats.jobsCompleted ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Collectors"
        description="Poller and collector registry — probed live from the worker service"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void collectorsQuery.refetch()}
            disabled={collectorsQuery.isFetching}
          >
            <RefreshCcw className={cn("mr-2 size-4", collectorsQuery.isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Online" value={`${online}/${collectors.length || "—"}`} icon={Server} />
        <KpiCard
          label="Worker service"
          value={workerReachable ? "reachable" : "unreachable"}
          icon={HeartPulse}
        />
        <KpiCard label="Jobs completed" value={jobsCompleted ? jobsCompleted.toLocaleString() : "—"} icon={Zap} />
      </div>

      <SectionCard title="Registry" description="Rows persist the last known state — OFFLINE keeps history">
        {collectorsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : collectorsQuery.isError ? (
          <ErrorState
            title="Could not load collectors"
            reason="Try again."
            onRetry={() => void collectorsQuery.refetch()}
          />
        ) : collectors.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title="No collectors registered"
            description="Collectors appear here once the worker service reports its first health probe."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Collector</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Jobs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collectors.map((collector) => (
                <TableRow key={collector.id}>
                  <TableCell className="font-medium">{collector.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{KIND_LABELS[collector.kind] ?? collector.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          collector.status === "ONLINE"
                            ? "animate-pulse bg-success"
                            : "bg-danger-orange"
                        )}
                        aria-hidden
                      />
                      <span
                        className={
                          collector.status === "ONLINE" ? "text-success" : "text-danger-orange"
                        }
                      >
                        {collector.status}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {collector.capabilities.map((cap) => (
                        <Badge key={cap} variant="outline" className="font-mono text-[10px]">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {collector.host ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {collector.lastSeenAt
                      ? formatDistanceToNow(parseISO(collector.lastSeenAt), { addSuffix: true })
                      : "never"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {String(collector.stats.jobsCompleted ?? "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
