"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type CreateJobPayload,
  type CreateJobResult,
  type JobRow,
  type PagedResult,
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
 * Queue a CONFIG_BACKUP job. Invalidates job + dashboard caches so the
 * Job Center and sidebar badge counts reflect the new queue entry.
 */
export function useCreateJob() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: CreateJobPayload) =>
      apiFetch<CreateJobResult>("/api/v1/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({
        title: "Backup job queued",
        description: `Correlation ${result.job.correlationId} — view progress in the Job Center.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not queue backup job",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
