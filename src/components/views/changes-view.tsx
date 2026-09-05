"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  Plus,
  Search,
  ShieldAlert,
  Timer,
  TrendingUp,
} from "lucide-react";

import { useChanges } from "@/hooks/api/use-changes";
import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
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
import { useNavigationStore } from "@/stores/navigation";
import { ChangeWizard } from "@/components/change/change-wizard";
import { lookupStatusConfig, CHANGE_STATUS_UI, CHANGE_TYPE_UI } from "./status-extras";

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

const PAGE_SIZE = 25;

/**
 * Change requests (upgraded in Task 4-a): KPI mini-row, status chips, search,
 * risk filter, wizard entry point and row-click navigation into the hidden
 * change-detail view. `mine` scopes the list to the demo identity (seeded
 * admin) for the changes.mine view.
 */
export function ChangesView({ mine = false }: { mine?: boolean }) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [chip, setChip] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [riskLevel, setRiskLevel] = useState("ALL");
  const [page, setPage] = useState(1);
  const [wizardOpen, setWizardOpen] = useState(false);

  const activeChip = STATUS_CHIPS.find((entry) => entry.key === chip) ?? STATUS_CHIPS[0];

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const changes = useChanges({
    status: activeChip.values,
    riskLevel: riskLevel !== "ALL" ? riskLevel : undefined,
    q: q || undefined,
    requesterId: mine ? "me" : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const rows = changes.data?.data ?? [];
  const listMeta = changes.data?.meta;
  const summary = listMeta?.summary;

  const resetPage = () => setPage(1);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={
          mine
            ? "Changes you requested — demo identity: admin"
            : "Change requests across the lifecycle"
        }
        primaryAction={
          <Button onClick={() => setWizardOpen(true)}>
            <Plus aria-hidden="true" />
            New change
          </Button>
        }
        title={mine ? "My Changes" : "Changes"}
      />

      {/* KPI mini-row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          description="Changes waiting for a decision"
          icon={ShieldAlert}
          label="Pending approvals"
          loading={!summary && changes.isLoading}
          value={summary?.awaitingApproval ?? 0}
        />
        <KpiCard
          description="Pre-check, executing or validating right now"
          icon={Timer}
          label="Executing now"
          loading={!summary && changes.isLoading}
          value={summary?.executingNow ?? 0}
        />
        <KpiCard
          description={`Across ${summary?.closedChanges30d ?? 0} closed-out changes`}
          icon={TrendingUp}
          label="Success rate (30d)"
          loading={!summary && changes.isLoading}
          value={
            summary?.successRate30d != null ? `${summary.successRate30d}%` : "—"
          }
        />
        <KpiCard
          description={`Page ${listMeta?.page ?? 1} of ${listMeta?.totalPages ?? 1}`}
          icon={GitPullRequest}
          label="Matching changes"
          loading={changes.isLoading}
          value={listMeta?.total ?? 0}
        />
      </div>

      {/* Status chips (kept from the Phase 1 slice) */}
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
            onClick={() => {
              setChip(entry.key);
              resetPage();
            }}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <SectionCard contentClassName="p-0" title="Change Requests">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search changes"
              className="ps-8"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search number or title…"
              value={searchInput}
            />
          </div>
          <Select
            onValueChange={(value) => {
              setRiskLevel(value);
              resetPage();
            }}
            value={riskLevel}
          >
            <SelectTrigger aria-label="Risk level" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any risk</SelectItem>
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(q || riskLevel !== "ALL") && (
            <Button
              onClick={() => {
                setSearchInput("");
                setQ("");
                setRiskLevel("ALL");
                resetPage();
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Reset
            </Button>
          )}
        </div>

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
              description="No change requests match the current filter. Create one with “New change”."
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
                  <TableHead>Approvals</TableHead>
                  <TableHead>Scheduled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((change) => (
                  <TableRow
                    className="h-(--density-row-h) cursor-pointer"
                    key={change.id}
                    onClick={() =>
                      setActiveView("changes.change-detail", { changeId: change.id })
                    }
                  >
                    <TableCell className="whitespace-nowrap px-(--density-cell-x) font-tech ltr-technical">
                      {change.number}
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      <span className="block max-w-[320px] truncate" title={change.title}>
                        {change.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {change._count.devices} device{change._count.devices === 1 ? "" : "s"} ·{" "}
                        {change._count.steps} step{change._count.steps === 1 ? "" : "s"}
                      </span>
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      <StatusBadge
                        config={lookupStatusConfig(CHANGE_TYPE_UI, change.type)}
                      />
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      <span className="flex items-center gap-2">
                        <ChangeRiskBadge value={change.riskLevel} />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {change.riskScore}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      <StatusBadge
                        config={lookupStatusConfig(CHANGE_STATUS_UI, change.status)}
                      />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap px-(--density-cell-x) md:table-cell">
                      {change.requester?.name ?? change.requester?.email ?? "—"}
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      {change.pendingApprovals ? (
                        <Badge variant="outline">
                          {change.pendingApprovals} pending
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-(--density-cell-x) text-xs tabular-nums text-muted-foreground">
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

        {/* Pagination */}
        {listMeta && listMeta.totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t p-3 text-xs text-muted-foreground">
            <Button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              <ChevronLeft aria-hidden="true" />
              Prev
            </Button>
            <span className="tabular-nums">
              {listMeta.page}/{listMeta.totalPages}
            </span>
            <Button
              disabled={page >= listMeta.totalPages}
              onClick={() => setPage((p) => p + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        )}
      </SectionCard>

      <ChangeWizard onOpenChange={setWizardOpen} open={wizardOpen} />
    </div>
  );
}
