"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
  Wand2,
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
import { ChangeAiDraftDialog } from "@/components/change/change-ai-draft-dialog";
import type { AiChangeDraftPrefill } from "@/lib/api-client";
import { lookupStatusConfig, CHANGE_STATUS_UI, CHANGE_TYPE_UI } from "./status-extras";

interface StatusChip {
  key: string;
  /** Comma-separated status list sent to the API. */
  values?: string;
}

const STATUS_CHIPS: StatusChip[] = [
  { key: "ALL" },
  { key: "AWAITING_APPROVAL", values: "AWAITING_APPROVAL" },
  { key: "UPCOMING", values: "APPROVED,SCHEDULED,PRE_CHECK" },
  { key: "EXECUTION", values: "EXECUTING,VALIDATING" },
  { key: "CLOSED", values: "CLOSED,SUCCESSFUL,PARTIAL_SUCCESS" },
  { key: "FAILED", values: "FAILED,ROLLBACK,ROLLBACK_FAILED" },
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
  const t = useTranslations("changesView");
  const tRoot = useTranslations();
  const tAi = useTranslations("ai.changeDraft");

  const [chip, setChip] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [riskLevel, setRiskLevel] = useState("ALL");
  const [page, setPage] = useState(1);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  /** Reviewed AI draft handed to the wizard (null = plain new change). */
  const [aiPrefill, setAiPrefill] = useState<AiChangeDraftPrefill | null>(null);

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
      <div data-tour="changes-header">
        <PageHeader
          description={
            mine
              ? t("page.mineDescription")
              : t("page.description")
          }
          primaryAction={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => setAiDialogOpen(true)}
                variant="outline"
              >
                <Wand2 aria-hidden="true" />
                {tAi("button")}
              </Button>
              <Button
                onClick={() => {
                  setAiPrefill(null);
                  setWizardOpen(true);
                }}
              >
                <Plus aria-hidden="true" />
                {t("actions.newChange")}
              </Button>
            </div>
          }
          title={mine ? t("page.mineTitle") : t("page.title")}
        />
      </div>

      {/* KPI mini-row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          description={t("kpi.pendingDescription")}
          icon={ShieldAlert}
          label={t("kpi.pendingLabel")}
          loading={!summary && changes.isLoading}
          value={summary?.awaitingApproval ?? 0}
        />
        <KpiCard
          description={t("kpi.executingDescription")}
          icon={Timer}
          label={t("kpi.executingLabel")}
          loading={!summary && changes.isLoading}
          value={summary?.executingNow ?? 0}
        />
        <KpiCard
          description={t("kpi.successDescription", {
            count: summary?.closedChanges30d ?? 0,
          })}
          icon={TrendingUp}
          label={t("kpi.successLabel")}
          loading={!summary && changes.isLoading}
          value={
            summary?.successRate30d != null ? `${summary.successRate30d}%` : "—"
          }
        />
        <KpiCard
          description={t("kpi.matchingDescription", {
            page: listMeta?.page ?? 1,
            totalPages: listMeta?.totalPages ?? 1,
          })}
          icon={GitPullRequest}
          label={t("kpi.matchingLabel")}
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
                ? "border-primary/30 bg-primary/10 text-primary-ink"
                : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
            key={entry.key}
            onClick={() => {
              setChip(entry.key);
              resetPage();
            }}
            type="button"
          >
            {t(`statusChip.${entry.key}`)}
          </button>
        ))}
      </div>

      <SectionCard contentClassName="p-0" title={t("section.title")}>
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={t("filter.searchAria")}
              className="ps-8"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("filter.searchPlaceholder")}
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
            <SelectTrigger aria-label={t("filter.riskAria")} className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("filter.anyRisk")}</SelectItem>
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((level) => (
                <SelectItem key={level} value={level}>
                  {tRoot(`status.risk.${level}`)}
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
              {t("actions.reset")}
            </Button>
          )}
        </div>

        {changes.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void changes.refetch()}
              reason={changes.error.message}
              title={t("error.title")}
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
              description={t("empty.description")}
              icon={GitPullRequest}
              title={t("empty.title")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("table.aria")} className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.number")}</TableHead>
                  <TableHead>{t("table.title")}</TableHead>
                  <TableHead>{t("table.type")}</TableHead>
                  <TableHead>{t("table.risk")}</TableHead>
                  <TableHead>{t("table.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("table.requester")}</TableHead>
                  <TableHead>{t("table.approvals")}</TableHead>
                  <TableHead>{t("table.scheduled")}</TableHead>
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
                        {t("row.devices", { count: change._count.devices })} ·{" "}
                        {t("row.steps", { count: change._count.steps })}
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
                      {change.requester?.name ?? change.requester?.email ?? t("row.emptyValue")}
                    </TableCell>
                    <TableCell className="px-(--density-cell-x)">
                      {change.pendingApprovals ? (
                        <Badge variant="outline">
                          {t("row.pending", { count: change.pendingApprovals })}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("row.emptyValue")}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-(--density-cell-x) text-xs tabular-nums text-muted-foreground">
                      {change.scheduledStart
                        ? format(new Date(change.scheduledStart), "MMM d, HH:mm")
                        : t("row.unscheduled")}
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
              {t("pagination.previous")}
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
              {t("pagination.next")}
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        )}
      </SectionCard>

      <ChangeAiDraftDialog
        onOpenChange={setAiDialogOpen}
        onUseDraft={(prefill) => {
          setAiPrefill(prefill);
          setAiDialogOpen(false);
          setWizardOpen(true);
        }}
        open={aiDialogOpen}
      />
      <ChangeWizard
        aiDraft={aiPrefill}
        onOpenChange={(nextOpen) => {
          setWizardOpen(nextOpen);
          if (!nextOpen) setAiPrefill(null);
        }}
        open={wizardOpen}
      />
    </div>
  );
}
