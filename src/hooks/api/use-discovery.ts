"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  type DiscoveryJobSummary,
  type ImportCandidatesPayload,
  type ImportResult,
  type StartScanPayload,
  type StartScanResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Discovery client data layer (2-c).
 *
 * useDiscoveryJobs polls every 2 s while any job is QUEUED/RUNNING so the
 * scan history shows live progress; the interval collapses to `false` once
 * the queue is idle.
 */
export function useDiscoveryJobs() {
  return useQuery({
    queryKey: queryKeys.discovery(),
    queryFn: () => apiFetch<DiscoveryJobSummary[]>("/api/v1/discovery"),
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      const active = jobs.some(
        (job) => job.status === "RUNNING" || job.status === "QUEUED"
      );
      return active ? 2000 : false;
    },
  });
}

/** Queue a discovery scan (New Scan dialog). */
export function useStartScan() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: StartScanPayload) =>
      apiFetch<StartScanResult>("/api/v1/discovery", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["discovery"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({
        title: "Scan queued",
        description: `Correlation ${result.correlationId} — the worker picks it up within seconds.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not queue scan",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/** Import selected candidates as devices. Invalidates devices + dashboard + discovery. */
export function useImportCandidates() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: ImportCandidatesPayload) =>
      apiFetch<ImportResult>("/api/v1/discovery/import", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["discovery"] });
      const skippedNote =
        result.skipped.length > 0
          ? ` ${result.skipped.length} skipped.`
          : "";
      toast({
        title: `Imported ${result.created} device${result.created === 1 ? "" : "s"}`,
        description: `The inventory now includes the imported candidates.${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Import failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
