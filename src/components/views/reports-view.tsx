"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import {
  CircleCheck,
  CircleX,
  Clock,
  FileJson,
  FileSpreadsheet,
  FileType2,
  History,
} from "lucide-react";

import {
  reportRunDownloadUrl,
  useReportRuns,
  type ReportTypeKey,
} from "@/hooks/api/use-reports";
import { useStatusLabel } from "@/hooks/use-status-label";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { JobStatusBadge } from "@/components/domain/job-status-badge";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Button } from "@/components/ui/button";
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
import { getStatusConfig, JOB_STATUS } from "@/lib/domain/status";

/**
 * Reports (runs history) — Task 9-a "reports.reports".
 *
 * The history is the REPORT_RUN JobExecution stream: KPI row, status
 * filter, 7 s live polling (runs appear here within seconds of a run-now)
 * and CSV/JSON downloads that unlock when a run SUCCEEDED. Tables carry
 * aria-labels + scope="col" (a11y conventions) and live in
 * overflow-x-auto wrappers (375 px safe).
 */

const STATUS_FILTERS = ["ALL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;

const REPORT_TYPE_KEYS: readonly ReportTypeKey[] = [
  "AVAILABILITY",
  "BACKUP_COMPLIANCE",
  "CHANGE_SUMMARY",
  "INCIDENT_SUMMARY",
  "CAPACITY",
];

const RANGE_KEYS = [
  "LAST_24_HOURS",
  "LAST_7_DAYS",
  "LAST_30_DAYS",
  "CURRENT_SNAPSHOT",
] as const;

function isReportType(value: string | null): value is ReportTypeKey {
  return value !== null && (REPORT_TYPE_KEYS as readonly string[]).includes(value);
}

function isRangeKey(value: string | null): boolean {
  return value !== null && (RANGE_KEYS as readonly string[]).includes(value);
}

function fmtAbsolute(iso: string): string {
  return format(new Date(iso), "MMM d, HH:mm");
}

function fmtRelative(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export function ReportsView() {
  const t = useTranslations("reports.runs");
  const tRoot = useTranslations("reports");
  // Status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();

  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);

  const runs = useReportRuns(
    {
      status: statusFilter === "ALL" ? undefined : statusFilter,
      page,
      pageSize: 20,
    },
    { refetchInterval: 7000 }
  );

  const rows = runs.data?.data ?? [];
  const meta = runs.data?.meta;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader description={t("description")} title={t("title")} />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={t("kpiTotalHint")}
          icon={History}
          label={t("kpiTotal")}
          loading={runs.isLoading}
          value={meta?.total ?? "—"}
        />
        <KpiCard
          description={t("kpiSucceededHint")}
          icon={CircleCheck}
          label={t("kpiSucceeded")}
          loading={runs.isLoading}
          value={meta?.succeeded ?? "—"}
        />
        <KpiCard
          description={t("kpiFailedHint")}
          icon={CircleX}
          label={t("kpiFailed")}
          loading={runs.isLoading}
          value={meta?.failed ?? "—"}
        />
        <KpiCard
          description={t("kpiLastRunHint")}
          icon={Clock}
          label={t("kpiLastRun")}
          loading={runs.isLoading}
          value={meta?.lastRunAt ? fmtRelative(meta.lastRunAt) : "—"}
        />
      </div>

      {/* Status filter */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
          value={statusFilter}
        >
          <SelectTrigger
            aria-label={t("filterStatusAria")}
            className="w-[190px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filterAll")}</SelectItem>
            {STATUS_FILTERS.filter((status) => status !== "ALL").map(
              (status) => (
                <SelectItem key={status} value={status}>
                  {resolveStatusLabel(getStatusConfig(JOB_STATUS, status))}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{t("autoRefresh")}</span>
      </div>

      <SectionCard
        contentClassName="p-0"
        title={`${t("title")}${meta ? ` — ${meta.total}` : ""}`}
      >
        {runs.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void runs.refetch()}
              reason={
                runs.error instanceof Error ? runs.error.message : undefined
              }
              title={t("errorTitle")}
            />
          </div>
        ) : runs.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-11 animate-pulse rounded-md bg-muted/60"
              />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("emptyDescription")}
              icon={History}
              title={t("emptyTitle")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("tableAria")} className="min-w-[860px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colCreated")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colSchedule")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colType")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colRange")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colStatus")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colDuration")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x) text-end"
                    scope="col"
                  >
                    {t("colDownloads")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((run) => {
                  const succeeded = run.status === "SUCCEEDED";
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col">
                          <span className="font-tech text-xs ltr-technical tabular-nums">
                            {fmtAbsolute(run.createdAt)}
                          </span>
                          <span className="font-tech text-[11px] ltr-technical text-muted-foreground">
                            {run.correlationId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) max-w-[24ch] px-(--density-cell-x)">
                        {run.schedule ? (
                          <span
                            className="block truncate text-sm font-medium"
                            title={run.schedule.name}
                          >
                            {run.schedule.name}
                          </span>
                        ) : (
                          <span
                            className="text-sm text-muted-foreground"
                            title={t("noScheduleHint")}
                          >
                            {t("noSchedule")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col">
                          <span className="text-sm">
                            {isReportType(run.reportType)
                              ? tRoot(`types.${run.reportType}`)
                              : (run.reportType ?? "—")}
                          </span>
                          {run.format && (
                            <span className="font-tech text-[11px] ltr-technical text-muted-foreground">
                              {run.format}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <span className="font-tech text-xs ltr-technical">
                          {run.range
                            ? isRangeKey(run.range)
                              ? tRoot(`ranges.${run.range}`)
                              : run.range
                            : "—"}
                        </span>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col items-start gap-1">
                          <JobStatusBadge value={run.status} />
                          {run.status === "FAILED" && run.error && (
                            <span
                              className="max-w-[22ch] truncate text-[11px] text-danger"
                              title={run.error}
                            >
                              {t("errorTitleRun")}: {run.error}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x) tabular-nums">
                        {run.durationMs !== null
                          ? t("durationSeconds", {
                              seconds: (run.durationMs / 1000).toFixed(1),
                            })
                          : "—"}
                        {succeeded && run.rowCount !== null && (
                          <span className="block text-[11px] text-muted-foreground">
                            {t("rowsSuffix", { count: run.rowCount })}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex items-center justify-end gap-1">
                          {/* Downloads are plain anchor navigations when the
                              artifact exists (browser streams the attachment
                              with cookies); inert icons otherwise. */}
                          {succeeded ? (
                            <>
                              <Button
                                asChild
                                size="icon"
                                title={t("downloadCsv")}
                                variant="ghost"
                              >
                                <a
                                  aria-label={t("downloadCsv")}
                                  href={reportRunDownloadUrl(run.id, "CSV")}
                                >
                                  <FileSpreadsheet aria-hidden="true" />
                                </a>
                              </Button>
                              <Button
                                asChild
                                size="icon"
                                title={t("downloadJson")}
                                variant="ghost"
                              >
                                <a
                                  aria-label={t("downloadJson")}
                                  href={reportRunDownloadUrl(run.id, "JSON")}
                                >
                                  <FileJson aria-hidden="true" />
                                </a>
                              </Button>
                              {/* GA-5: PDF/XLSX are REAL binary downloads now —
                                  the bytes are rendered at delivery from the
                                  stored artifact (no more tagged-JSON gap). */}
                              <Button
                                asChild
                                size="icon"
                                title={t("downloadPdf")}
                                variant="ghost"
                              >
                                <a
                                  aria-label={t("downloadPdf")}
                                  href={reportRunDownloadUrl(run.id, "PDF")}
                                >
                                  <FileType2 aria-hidden="true" />
                                </a>
                              </Button>
                              <Button
                                asChild
                                size="icon"
                                title={t("downloadXlsx")}
                                variant="ghost"
                              >
                                <a
                                  aria-label={t("downloadXlsx")}
                                  href={reportRunDownloadUrl(run.id, "XLSX")}
                                >
                                  <FileSpreadsheet aria-hidden="true" />
                                </a>
                              </Button>
                            </>
                          ) : (
                            <>
                              {/* RT-038 (F-054): aria-disabled instead of disabled so
                                  the hint stays reachable by keyboard/screen-reader;
                                  activation is impossible (guarded onClick, no anchor). */}
                              <Button
                                aria-disabled
                                aria-label={t("downloadLockedHint")}
                                onClick={(e) => e.preventDefault()}
                                size="icon"
                                title={t("downloadLockedHint")}
                                variant="ghost"
                              >
                                <FileSpreadsheet aria-hidden="true" />
                                <span className="sr-only">{t("downloadLockedHint")}</span>
                              </Button>
                              <Button
                                aria-disabled
                                aria-label={t("downloadLockedHint")}
                                onClick={(e) => e.preventDefault()}
                                size="icon"
                                title={t("downloadLockedHint")}
                                variant="ghost"
                              >
                                <FileJson aria-hidden="true" />
                                <span className="sr-only">{t("downloadLockedHint")}</span>
                              </Button>
                              <Button
                                aria-disabled
                                aria-label={t("downloadLockedHint")}
                                onClick={(e) => e.preventDefault()}
                                size="icon"
                                title={t("downloadLockedHint")}
                                variant="ghost"
                              >
                                <FileType2 aria-hidden="true" />
                                <span className="sr-only">{t("downloadLockedHint")}</span>
                              </Button>
                              <Button
                                aria-disabled
                                aria-label={t("downloadLockedHint")}
                                onClick={(e) => e.preventDefault()}
                                size="icon"
                                title={t("downloadLockedHint")}
                                variant="ghost"
                              >
                                <FileSpreadsheet aria-hidden="true" />
                                <span className="sr-only">{t("downloadLockedHint")}</span>
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {meta.page} / {meta.totalPages} · {meta.total}
            </span>
            <div className="flex gap-2">
              <Button
                disabled={meta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                ‹
              </Button>
              <Button
                disabled={meta.page >= meta.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                ›
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
