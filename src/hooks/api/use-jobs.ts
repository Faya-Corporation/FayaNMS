"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type CancelJobResult,
  type CreateJobPayload,
  type CreateJobResult,
  type JobRow,
  type PagedResult,
  type RetryJobResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

export interface JobListParams extends ListParams {
  status?: string;
  deviceId?: string;
  page?: number;
  pageSize?: number;
}

export function useJobs(
  params: JobListParams = {},
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.jobs(params),
    queryFn: async (): Promise<PagedResult<JobRow>> => {
      const envelope = await apiRequest<JobRow[]>(
        `/api/v1/jobs${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<JobRow>["meta"];
      return { data: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval,
  });
}

/**
 * Cache sweep shared by every job mutation (Phase 9-b): the queue lists,
 * the dashboard KPIs (active jobs) and the audit-event stream all move
 * when a job is queued, cancelled or retried.
 */
function invalidateJobSurfaces(
  queryClient: ReturnType<typeof useQueryClient>
) {
  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/**
 * Queue a CONFIG_BACKUP job. Invalidates job + dashboard caches so the
 * Job Center and sidebar badge counts reflect the new queue entry.
 */
export function useCreateJob() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.jobs");

  return useMutation({
    mutationFn: (payload: CreateJobPayload) =>
      apiFetch<CreateJobResult>("/api/v1/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateJobSurfaces(queryClient);
      toast({
        title: t("backupQueuedTitle"),
        description: t("backupQueuedDescription", { correlation: result.job.correlationId }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("backupFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Cancel a QUEUED/RUNNING job (Phase 9-b) — status becomes CANCELLED with
 * a finishedAt timestamp; audited JOB_CANCELLED under the job's own
 * correlation id so the event stream stays traceable.
 */
export function useCancelJob() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.jobs");

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CancelJobResult>(`/api/v1/jobs/${id}/cancel`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      invalidateJobSurfaces(queryClient);
      toast({
        title: t("cancelledTitle"),
        description: t("cancelledDescription", { correlation: result.job.correlationId }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("cancelFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Retry any existing job (Phase 9-b) — queues a fresh clone with attempts
 * reset and a RETRY_OF link to the source correlation id (payload + audit).
 */
export function useRetryJob() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.jobs");

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RetryJobResult>(`/api/v1/jobs/${id}/retry`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      invalidateJobSurfaces(queryClient);
      toast({
        title: t("retryQueuedTitle"),
        description: t("retryQueuedDescription", { correlation: result.job.correlationId }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("retryFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
