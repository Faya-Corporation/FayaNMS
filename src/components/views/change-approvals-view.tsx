"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  ClipboardCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import { useApprovals, useActingUser } from "@/hooks/api/use-approvals";
import { useDecideApproval } from "@/hooks/api/use-approval-mutations";
import { usePreferencesStore } from "@/stores/preferences";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import {
  lookupStatusConfig,
  CHANGE_APPROVAL_LEVEL_UI,
  CHANGE_APPROVAL_STATUS_UI,
  CHANGE_STATUS_UI,
  CHANGE_TYPE_UI,
} from "./status-extras";
import type { ApprovalQueueRow } from "@/lib/api-client";

/**
 * Approvals queue (Task 4-b): one row per change with a status chip per
 * approval level, per-level Approve/Reject actions for the acting user and
 * the separation-of-duties pre-check (requester self-approval blocked on
 * HIGH/CRITICAL — the server enforces the same rule with 403 SOD_VIOLATION).
 * The "Act as" Select drives the demo identity for every decision.
 */

const STATUS_FILTERS = [
  { key: "PENDING", label: "Pending", values: "PENDING" },
  { key: "DECIDED", label: "Decided", values: "APPROVED,REJECTED" },
  { key: "ALL", label: "All", values: "PENDING,APPROVED,REJECTED,NOT_REQUIRED" },
];

/** Risk levels gated by the SoD rule (mirrors the server guard). */
const SOD_GATED_RISK_LEVELS = ["HIGH", "CRITICAL"];

interface DecisionTarget {
  changeId: string;
  changeNumber: string;
  level: string;
  decision: "APPROVED" | "REJECTED";
  riskLevel: string;
}

export function ChangeApprovalsView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const actAsUserId = usePreferencesStore((state) => state.actAsUserId);
  const setActAsUserId = usePreferencesStore((state) => state.setActAsUserId);
  const { users, actingUser } = useActingUser(actAsUserId);

  const [statusKey, setStatusKey] = useState("PENDING");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [decision, setDecision] = useState<DecisionTarget | null>(null);
  const [comment, setComment] = useState("");

  const activeFilter =
    STATUS_FILTERS.find((entry) => entry.key === statusKey) ?? STATUS_FILTERS[0];

  useEffect(() => {
    const timer = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const approvals = useApprovals(
    {
      status: activeFilter.values,
      actAsUserId: actAsUserId || undefined,
      q: q || undefined,
    },
    { refetchInterval: 15_000 }
  );
  const decide = useDecideApproval();

  const rows = approvals.data?.rows ?? [];
  const meta = approvals.data?.meta;

  /** Group per-approval rows into one queue row per change. */
  const changeRows = useMemo(() => {
    const byChange = new Map<string, ApprovalQueueRow>();
    for (const row of rows) {
      if (!byChange.has(row.changeId)) byChange.set(row.changeId, row);
    }
    return [...byChange.values()].map((row) => ({
      change: row.change,
      pendingLevels: row.change.levels
        .filter((entry) => entry.status === "PENDING")
        .map((entry) => entry.level),
    }));
  }, [rows]);

  const isSodBlocked = (row: (typeof changeRows)[number]) =>
    Boolean(
      actingUser &&
        row.change.requesterId === actingUser.id &&
        SOD_GATED_RISK_LEVELS.includes(row.change.riskLevel)
    );

  const openDecision = (
    row: (typeof changeRows)[number],
    level: string,
    target: "APPROVED" | "REJECTED"
  ) => {
    setComment("");
    setDecision({
      changeId: row.change.id,
      changeNumber: row.change.number,
      level,
      decision: target,
      riskLevel: row.change.riskLevel,
    });
  };

  const submitDecision = () => {
    if (!decision) return;
    const trimmed = comment.trim();
    if (decision.decision === "REJECTED" && trimmed.length < 4) return;
    decide.mutate(
      {
        changeId: decision.changeId,
        payload: {
          level: decision.level,
          decision: decision.decision,
          comment: trimmed || undefined,
          actAsUserId: actAsUserId || undefined,
        },
      },
      { onSuccess: () => setDecision(null) }
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Approval queue across changes — separation of duties enforced"
        primaryAction={
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground" htmlFor="act-as-select">
              Act as
            </Label>
            <Select
              onValueChange={(value) => setActAsUserId(value)}
              value={actAsUserId}
            >
              <SelectTrigger
                aria-label="Acting user (demo identity)"
                className="w-[230px]"
                id="act-as-select"
              >
                <SelectValue placeholder="Acting user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.username}>
                    {user.name} · {user.roleLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        title="Approvals"
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          description="Levels waiting for a decision"
          icon={ClipboardCheck}
          label="Pending approvals"
          loading={!meta && approvals.isLoading}
          value={meta?.pending ?? 0}
        />
        <KpiCard
          description="SoD-aware — decisions you may legally record"
          icon={ShieldAlert}
          label="Awaiting my decision"
          loading={!meta && approvals.isLoading}
          value={meta?.mine ?? "—"}
        />
        <KpiCard
          description="Approvals recorded today"
          icon={CheckCircle2}
          label="Approved today"
          loading={!meta && approvals.isLoading}
          value={meta?.approvedToday ?? 0}
        />
        <KpiCard
          description="Rejections recorded today"
          icon={XCircle}
          label="Rejected today"
          loading={!meta && approvals.isLoading}
          value={meta?.rejectedToday ?? 0}
        />
      </div>

      <SectionCard
        actions={
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(value) => setStatusKey(value)}
              value={statusKey}
            >
              <SelectTrigger aria-label="Approval status filter" className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              aria-label="Refresh approvals"
              onClick={() => void approvals.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className={cn(approvals.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
        contentClassName="p-0"
        description={`Acting as: ${actingUser?.name ?? actAsUserId} — demo identity`}
        title="Approval queue"
      >
        {/* Search */}
        <div className="border-b p-3">
          <div className="relative max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search approvals"
              className="ps-8"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search number or title…"
              value={searchInput}
            />
          </div>
        </div>

        {approvals.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void approvals.refetch()}
              reason={approvals.error.message}
              title="Approvals could not be loaded"
            />
          </div>
        ) : approvals.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-14 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : changeRows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No approval rows match the current filter — changes appear here once submitted for approval."
              icon={ClipboardCheck}
              title="Queue is clear"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="Approval queue — pending technical, security and manager approvals per change request" className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead className="hidden md:table-cell">Requester</TableHead>
                  <TableHead className="hidden lg:table-cell">Requested</TableHead>
                  <TableHead>Approval levels</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changeRows.map((row) => {
                  const sodBlocked = isSodBlocked(row);
                  return (
                    <TableRow
                      className="h-(--density-row-h) cursor-pointer"
                      key={row.change.id}
                      onClick={() =>
                        setActiveView("changes.change-detail", { changeId: row.change.id })
                      }
                    >
                      <TableCell className="whitespace-nowrap px-(--density-cell-x) font-tech ltr-technical">
                        {row.change.number}
                      </TableCell>
                      <TableCell className="px-(--density-cell-x)">
                        <span className="block max-w-[280px] truncate" title={row.change.title}>
                          {row.change.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <StatusBadge
                            config={lookupStatusConfig(CHANGE_TYPE_UI, row.change.type)}
                          />
                          <StatusBadge
                            config={lookupStatusConfig(CHANGE_STATUS_UI, row.change.status)}
                          />
                        </span>
                      </TableCell>
                      <TableCell className="px-(--density-cell-x)">
                        <span className="flex items-center gap-2">
                          <ChangeRiskBadge value={row.change.riskLevel} />
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {row.change.riskScore}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap px-(--density-cell-x) md:table-cell">
                        {row.change.requesterName ?? "—"}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap px-(--density-cell-x) text-xs tabular-nums text-muted-foreground lg:table-cell">
                        {formatDistanceToNow(new Date(row.change.createdAt), {
                          addSuffix: true,
                        })}
                      </TableCell>
                      <TableCell className="px-(--density-cell-x)">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {row.change.levels.map((entry) => {
                            const levelConfig = lookupStatusConfig(
                              CHANGE_APPROVAL_LEVEL_UI,
                              entry.level
                            );
                            const statusConfig = lookupStatusConfig(
                              CHANGE_APPROVAL_STATUS_UI,
                              entry.status
                            );
                            return (
                              <Badge
                                className="gap-1 font-tech"
                                key={`${row.change.id}-${entry.level}`}
                                variant="outline"
                              >
                                <span
                                  aria-hidden="true"
                                  className={`size-1.5 rounded-full ${statusConfig.dotClass}`}
                                />
                                {levelConfig.label}
                                <span className="sr-only">— {statusConfig.label}</span>
                              </Badge>
                            );
                          })}
                        </span>
                      </TableCell>
                      <TableCell
                        className="px-(--density-cell-x)"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {row.pendingLevels.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col items-end gap-1.5">
                            {row.pendingLevels.map((level) => {
                              const levelConfig = lookupStatusConfig(
                                CHANGE_APPROVAL_LEVEL_UI,
                                level
                              );
                              const buttons = (
                                <div className="flex items-center gap-1.5">
                                  <span className="hidden font-tech text-[10px] uppercase text-muted-foreground xl:inline">
                                    {levelConfig.label}
                                  </span>
                                  <Button
                                    aria-label={`Approve ${levelConfig.label} for ${row.change.number}`}
                                    disabled={decide.isPending || sodBlocked}
                                    onClick={() => openDecision(row, level, "APPROVED")}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    aria-label={`Reject ${levelConfig.label} for ${row.change.number}`}
                                    disabled={decide.isPending || sodBlocked}
                                    onClick={() => openDecision(row, level, "REJECTED")}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    <XCircle aria-hidden="true" className="text-danger" />
                                    Reject
                                  </Button>
                                </div>
                              );
                              return sodBlocked ? (
                                <Tooltip key={`${row.change.id}-${level}`}>
                                  <TooltipTrigger asChild>
                                    <span className="inline-block cursor-not-allowed opacity-50">
                                      {buttons}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Blocked by separation of duties — the requester cannot
                                    approve a {row.change.riskLevel} change
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <div key={`${row.change.id}-${level}`}>{buttons}</div>
                              );
                            })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Approve (optional comment) / Reject (comment required) dialog */}
      <Dialog
        onOpenChange={(open) => !open && setDecision(null)}
        open={decision !== null}
      >
        <DialogContent className="sm:max-w-md">
          {decision && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {decision.decision === "APPROVED" ? "Approve" : "Reject"}{" "}
                  <span className="font-tech ltr-technical">{decision.changeNumber}</span> —{" "}
                  {lookupStatusConfig(CHANGE_APPROVAL_LEVEL_UI, decision.level).label}
                </DialogTitle>
                <DialogDescription>
                  {decision.decision === "APPROVED"
                    ? "Recording your approval as the acting user — a comment is optional."
                    : "Rejections require a short reason (min 4 characters) for the audit trail."}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="approval-comment">
                  Comment {decision.decision === "APPROVED" ? "(optional)" : "(required)"}
                </Label>
                <Textarea
                  aria-label="Decision comment"
                  id="approval-comment"
                  onChange={(event) => setComment(event.target.value)}
                  placeholder={
                    decision.decision === "APPROVED"
                      ? "e.g. reviewed against the plan — looks good"
                      : "e.g. rollback plan incomplete for this window"
                  }
                  rows={3}
                  value={comment}
                />
                {decision.decision === "REJECTED" &&
                  comment.trim().length > 0 &&
                  comment.trim().length < 4 && (
                    <p className="text-xs text-warning">
                      Reason must be at least 4 characters.
                    </p>
                  )}
              </div>
              <DialogFooter>
                <Button
                  onClick={() => setDecision(null)}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className={
                    decision.decision === "REJECTED"
                      ? "bg-danger text-white hover:bg-danger/90"
                      : undefined
                  }
                  disabled={
                    decide.isPending ||
                    (decision.decision === "REJECTED" && comment.trim().length < 4)
                  }
                  onClick={submitDecision}
                  type="button"
                >
                  {decision.decision === "APPROVED" ? "Approve" : "Reject change"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
