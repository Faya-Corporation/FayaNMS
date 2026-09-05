"use client";

import { useState } from "react";
import { format } from "date-fns";
import { GitPullRequest } from "lucide-react";

import { useChanges } from "@/hooks/api/use-changes";
import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { lookupStatusConfig, CHANGE_STATUS_UI } from "./status-extras";

interface StatusChip {
  key: string;
  label: string;
  /** Comma-separated status list sent to the API. */
  values?: string;
}

const STATUS_CHIPS: StatusChip[] = [
  { key: "ALL", label: "All" },
  { key: "AWAITING_APPROVAL", label: "Awaiting Approval", values: "AWAITING_APPROVAL" },
  { key: "UPCOMING", label: "Upcoming", values: "APPROVED,SCHEDULED,PRE_CHECK" },
  { key: "EXECUTION", label: "In Execution", values: "EXECUTING,VALIDATING" },
  { key: "CLOSED", label: "Closed", values: "CLOSED,SUCCESSFUL,PARTIAL_SUCCESS" },
  { key: "FAILED", label: "Failed & Rollback", values: "FAILED,ROLLBACK,ROLLBACK_FAILED" },
];

/**
 * Change requests (Phase 1 slice): status chips + table over /api/v1/changes.
 * Wizard, approvals and execution engine land in Phase 4.
 */
export function ChangesView() {
  const [chip, setChip] = useState<string>("ALL");
  const activeChip = STATUS_CHIPS.find((entry) => entry.key === chip) ?? STATUS_CHIPS[0];

  const changes = useChanges({
    status: activeChip.values,
    pageSize: 25,
  });

  const rows = changes.data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Change requests across the lifecycle"
        title="Changes"
      />

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_CHIPS.map((entry) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              chip === entry.key
                ? "border-primary/30 bg-primary/10 text-primary"
                : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
            key={entry.key}
            onClick={() => setChip(entry.key)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <SectionCard contentClassName="p-0" title="Change Requests">
        {changes.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void changes.refetch()}
              reason={changes.error.message}
              title="Changes could not be loaded"
            />
          </div>
        ) : changes.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No change requests match the current filter."
              icon={GitPullRequest}
              title="No changes to show"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Requester</TableHead>
                  <TableHead>Scheduled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((change) => (
                  <TableRow key={change.id}>
                    <TableCell className="whitespace-nowrap font-tech ltr-technical">
                      {change.number}
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-[320px] truncate" title={change.title}>
                        {change.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {change._count.devices} device{change._count.devices === 1 ? "" : "s"} ·{" "}
                        {change._count.steps} step{change._count.steps === 1 ? "" : "s"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{change.type}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <ChangeRiskBadge value={change.riskLevel} />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {change.riskScore}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        config={lookupStatusConfig(CHANGE_STATUS_UI, change.status)}
                      />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">
                      {change.requester?.name ?? change.requester?.email ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      {change.scheduledStart
                        ? format(new Date(change.scheduledStart), "MMM d, HH:mm")
                        : "unscheduled"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
