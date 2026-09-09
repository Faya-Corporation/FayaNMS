"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type DriftActionResult,
  type DriftCheckPayload,
  type DriftCheckResult,
  type DriftListMeta,
  type DriftRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Drift (Task 3-c): records + summary meta from GET /api/v1/drift. Params
 * (status/deviceId) are part of the query key so triage filters refetch.
 * meta is DriftListMeta (page fields + KPI summary).
 */
export function useDrift(params: ListParams = {}) {
  return useQuery({
    queryKey: queryKeys.drift(params),
    queryFn: async (): Promise<{ data: DriftRow[]; meta: DriftListMeta }> => {
      const envelope = await apiRequest<DriftRow[]>(
        `/api/v1/drift${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as DriftListMeta;
      return { data: envelope.data, meta };
    },
  });
}

function invalidateDriftGraph(queryClient: ReturnType<typeof useQueryClient>) {
  // Drift state shows up in the drift view, device facets and dashboards;
  // check runs also surface as jobs.
  void queryClient.invalidateQueries({ queryKey: ["drift"] });
  void queryClient.invalidateQueries({ queryKey: ["baselines"] });
  void queryClient.invalidateQueries({ queryKey: ["devices"] });
  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Queue DRIFT_CHECK jobs — one device (deviceId) or the whole fleet. */
export function useRunDriftCheck() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: DriftCheckPayload) =>
      apiFetch<DriftCheckResult>("/api/v1/drift/check", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDriftGraph(queryClient);
      toast({
        title:
          result.enqueued === 1
            ? "Drift check queued"
            : `Drift check queued for ${result.enqueued} devices`,
        description:
          result.enqueued === 0
            ? "All covered devices already have a check in flight."
            : "The worker evaluates baseline vs running config and updates drift records.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not queue the drift check",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/** Triage a drift record: ACCEPT (intentional deviation) or RESOLVE. */
export function useTriageDrift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "ACCEPT" | "RESOLVE" }) =>
      apiFetch<DriftActionResult>(`/api/v1/drift/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      }),
    onSuccess: (result, variables) => {
      invalidateDriftGraph(queryClient);
      toast({
        title:
          variables.action === "ACCEPT"
            ? "Drift accepted"
            : "Drift resolved",
        description: `Record marked ${result.record.status.toLowerCase()} — audit ${result.audit.correlationId}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update the drift record",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
