"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  ApiError,
  pruneMetricsRetention,
  updateMetricsRetention,
  fetchMetricsRetention,
  type MetricsPruneResult,
  type MetricsRetentionUpdatePayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Metrics retention hooks (Task 6-b). GET returns the tier config plus the
 * last prune bookkeeping; PUT saves tier changes; POST /prune triggers a
 * manual pruning run. The backend guards re-runs within 60 s with a 429 —
 * surfaced here as the "Prune already ran recently" toast.
 */
export function useMetricsRetention() {
  return useQuery({
    queryKey: queryKeys.metricsRetention,
    queryFn: fetchMetricsRetention,
    staleTime: 60_000,
  });
}

export function useSaveMetricsRetention() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.retention");
  return useMutation({
    mutationFn: (payload: MetricsRetentionUpdatePayload) =>
      updateMetricsRetention(payload),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["metrics", "retention"] });
      const tiers = [
        saved.raw?.days,
        saved.rollup5M?.days,
        saved.rollup1H?.days,
        saved.rollup1D?.days,
      ];
      const tier = (days: number | undefined) => (days === undefined ? "—" : String(days));
      toast({
        title: t("savedTitle"),
        description: t("savedDescription", {
          raw: tier(tiers[0]),
          m5: tier(tiers[1]),
          h1: tier(tiers[2]),
          d1: tier(tiers[3]),
        }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("saveFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}

export function usePruneMetricsRetention() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.retention");
  return useMutation({
    mutationFn: () => pruneMetricsRetention(),
    onSuccess: (result: MetricsPruneResult) => {
      // Pruning shrinks what the performance views read.
      void queryClient.invalidateQueries({ queryKey: ["metrics", "retention"] });
      void queryClient.invalidateQueries({ queryKey: ["performance"] });
      const total =
        result.metricSamplesDeleted +
        result.rollup5MDeleted +
        result.rollup1HDeleted +
        result.rollup1DDeleted;
      // toLocaleString() stays runtime-formatted (pre-existing behavior).
      toast({
        title: t("pruneCompletedTitle"),
        description: t("pruneCompletedDescription", {
          rows: total.toLocaleString(),
          seconds: (result.durationMs / 1000).toFixed(1),
        }),
      });
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 429) {
        toast({
          title: t("pruneRateLimitedTitle"),
          description: t("pruneRateLimitedDescription"),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: t("pruneFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
