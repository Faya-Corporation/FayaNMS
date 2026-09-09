"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

/**
 * Reports (Task 9-a) — schedules CRUD + runs history.
 *
 * Toasts are intentionally NOT baked into these hooks: every UI string is
 * wired through next-intl (Phase 8 convention), so the views own the
 * localized success/error notifications and pass them as mutate()
 * callbacks. The hooks always run the cache invalidation — the "reports"
 * tree, the Job Center list (run-now creates a REPORT_RUN JobExecution)
 * and the audit-event stream (every schedule action is audited REPORT_*).
 */

/* ───────────────────────────── types ───────────────────────────── */

export type ReportTypeKey =
  | "AVAILABILITY"
  | "BACKUP_COMPLIANCE"
  | "CHANGE_SUMMARY"
  | "INCIDENT_SUMMARY"
  | "CAPACITY";
export type ReportFrequencyKey = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY";
export type ReportFormatKey = "PDF" | "XLSX" | "CSV" | "JSON";

export interface ReportScheduleRow {
  id: string;
  name: string;
  reportType: ReportTypeKey;
  frequency: ReportFrequencyKey;
  format: ReportFormatKey;
  recipients: string[];
  isActive: boolean;
  lastRunAt: string | null;
  createdAt: string;
  expectedRange: string;
  nextEstimatedRunAt: string | null;
}

export interface ReportSchedulesMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  activeSchedules: number;
  runsLast7d: number;
  successRate7d: number | null;
  finished7d: number;
  nextEstimatedRunAt: string | null;
  [key: string]: unknown;
}

export interface ReportRunRow {
  id: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  range: string | null;
  rowCount: number | null;
  reportType: string | null;
  format: string | null;
  schedule: {
    id: string;
    name: string;
    reportType: ReportTypeKey;
    frequency: ReportFrequencyKey;
    format: ReportFormatKey;
  } | null;
}

export interface ReportRunsMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  succeeded: number;
  failed: number;
  lastRunAt: string | null;
  [key: string]: unknown;
}

export interface ReportSchedulePayload {
  name: string;
  reportType: ReportTypeKey;
  frequency: ReportFrequencyKey;
  format: ReportFormatKey;
  recipients: string[];
  isActive: boolean;
}

export interface UpdateReportSchedulePayload {
  name?: string;
  reportType?: ReportTypeKey;
  frequency?: ReportFrequencyKey;
  format?: ReportFormatKey;
  recipients?: string[];
  isActive?: boolean;
}

export interface ReportScheduleMutationResult {
  schedule: ReportScheduleRow;
  audit: { correlationId: string };
}

export interface DeleteReportScheduleResult {
  deleted: boolean;
  audit: { correlationId: string };
}

export interface RunReportNowResult {
  job: {
    id: string;
    type: string;
    status: string;
    correlationId: string;
    createdAt: string;
  };
  schedule: { id: string; name: string };
  audit: { correlationId: string };
}

/* ───────────────────────────── queries ───────────────────────────── */

export interface ReportSchedulesParams extends ListParams {
  reportType?: ReportTypeKey;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}

export function useReportSchedules(params: ReportSchedulesParams = {}) {
  return useQuery({
    queryKey: queryKeys.reportSchedules(params),
    queryFn: async (): Promise<
      PagedResult<ReportScheduleRow, ReportSchedulesMeta>
    > => {
      const envelope = await apiRequest<ReportScheduleRow[]>(
        `/api/v1/reports/schedules${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as ReportSchedulesMeta;
      return { data: envelope.data, meta };
    },
  });
}

export interface ReportRunsParams extends ListParams {
  status?: string;
  scheduleId?: string;
  page?: number;
  pageSize?: number;
}

export function useReportRuns(
  params: ReportRunsParams = {},
  options: { refetchInterval?: number | false } = {}
) {
  return useQuery({
    queryKey: queryKeys.reportRuns(params),
    queryFn: async (): Promise<PagedResult<ReportRunRow, ReportRunsMeta>> => {
      const envelope = await apiRequest<ReportRunRow[]>(
        `/api/v1/reports/runs${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as ReportRunsMeta;
      return { data: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval ?? false,
  });
}

/* ──────────────────────────── mutations ──────────────────────────── */

function invalidateReportSurfaces(
  queryClient: ReturnType<typeof useQueryClient>
) {
  void queryClient.invalidateQueries({ queryKey: ["reports"] });
  // Run-now creates a REPORT_RUN JobExecution + audited events.
  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
}

/** Create a schedule (audited REPORT_SCHEDULE_CREATED). */
export function useCreateReportSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: ReportSchedulePayload) =>
      apiFetch<ReportScheduleMutationResult>("/api/v1/reports/schedules", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => invalidateReportSurfaces(queryClient),
  });
}

/** Partial update / isActive toggle (audited REPORT_SCHEDULE_UPDATED). */
export function useUpdateReportSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateReportSchedulePayload;
    }) =>
      apiFetch<ReportScheduleMutationResult>(
        `/api/v1/reports/schedules/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify(data),
        }
      ),
    onSuccess: (result) => invalidateReportSurfaces(queryClient),
  });
}

/** Delete a schedule (audited REPORT_SCHEDULE_DELETED). */
export function useDeleteReportSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteReportScheduleResult>(`/api/v1/reports/schedules/${id}`, {
        method: "DELETE",
      }),
    onSuccess: (result) => invalidateReportSurfaces(queryClient),
  });
}

/**
 * Run-now (audited REPORT_SCHEDULE_RUN_QUEUED). Returns the job id +
 * shared REP-XXXXXX correlation id; the view toasts it and the runs
 * history (7 s poll) picks the execution up within seconds.
 */
export function useRunReportNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RunReportNowResult>(`/api/v1/reports/schedules/${id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => invalidateReportSurfaces(queryClient),
  });
}

/**
 * Attachment URL for a SUCCEEDED run — used as a plain anchor href so the
 * browser streams the download (cookies flow, direction-independent).
 */
export function reportRunDownloadUrl(runId: string, format: "CSV" | "JSON") {
  return `/api/v1/reports/runs/${runId}/download?format=${format}`;
}
