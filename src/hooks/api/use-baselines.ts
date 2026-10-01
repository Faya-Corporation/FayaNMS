"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  apiRequest,
  type ApproveBaselinePayload,
  type BaselineMutationResult,
  type BaselineRow,
  type BaselinesMeta,
  type RevokeBaselineResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Baselines (Task 3-c): the latest approved ConfigBaseline per device.
 * Approvals happen from the device Config tab (3-c actions); this hook
 * powers the fleet Baselines view and invalidates everything that displays
 * baseline-dependent state.
 */
export function useBaselines() {
  return useQuery({
    queryKey: queryKeys.baselines(),
    queryFn: async (): Promise<{ rows: BaselineRow[]; meta: BaselinesMeta }> => {
      const envelope = await apiRequest<BaselineRow[]>("/api/v1/baselines");
      const meta = envelope.meta as unknown as BaselinesMeta;
      return { rows: envelope.data, meta };
    },
  });
}

function invalidateBaselineGraph(queryClient: ReturnType<typeof useQueryClient>) {
  // Baselines feed the drift engine, snapshot statuses (BASELINE flag in
  // version lists) and KPI cards — refresh them all.
  void queryClient.invalidateQueries({ queryKey: ["baselines"] });
  void queryClient.invalidateQueries({ queryKey: ["drift"] });
  void queryClient.invalidateQueries({ queryKey: ["devices"] });
  void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Approve a snapshot as the device's golden baseline. */
export function useApproveBaseline() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.baselines");

  return useMutation({
    mutationFn: (payload: ApproveBaselinePayload) =>
      apiFetch<BaselineMutationResult>("/api/v1/baselines", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateBaselineGraph(queryClient);
      // {status} stays the raw lowercased enum token (technical value).
      toast({
        title: t("approvedTitle", { version: result.version }),
        description: t("approvedDescription", {
          status: result.snapshotStatus.toLowerCase(),
          correlation: result.audit.correlationId,
        }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("approveFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/** Revoke a baseline approval (snapshot demoted to Historical). */
export function useRevokeBaseline() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.baselines");

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RevokeBaselineResult>(`/api/v1/baselines/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateBaselineGraph(queryClient);
      toast({
        title: t("revokedTitle"),
        description: t("revokedDescription"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("revokeFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
