"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type AlertRuleMutationResult,
  type AlertRulePayload,
  type AlertRuleRow,
  type DeleteAlertRuleResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/** Alert rules (Task 5-a, Rules tab) — list + create/update/delete. */

export function useAlertRules() {
  return useQuery({
    queryKey: queryKeys.alertRules(),
    queryFn: () => apiFetch<AlertRuleRow[]>("/api/v1/alerts/rules"),
    staleTime: 15_000,
  });
}

function invalidateRules(queryClient: ReturnType<typeof useQueryClient>) {
  // Rules drive the evaluator; open alerts may change on the next tick.
  void queryClient.invalidateQueries({ queryKey: ["alertRules"] });
}

export function useCreateAlertRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.alertRules");
  return useMutation({
    mutationFn: (payload: AlertRulePayload) =>
      apiFetch<AlertRuleMutationResult>("/api/v1/alerts/rules", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateRules(queryClient);
      toast({
        title: t("createdTitle"),
        description: t("createdDescription", { name: result.rule.name }),
      });
    },
    onError: (error: Error) =>
      toast({ title: t("createFailedTitle"), description: error.message, variant: "destructive" }),
  });
}

export function useUpdateAlertRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.alertRules");
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<AlertRulePayload> }) =>
      apiFetch<AlertRuleMutationResult>(`/api/v1/alerts/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (result, variables) => {
      invalidateRules(queryClient);
      if (variables.data.isActive !== undefined) {
        toast({
          title: variables.data.isActive ? t("enabledTitle") : t("pausedTitle"),
          description: variables.data.isActive
            ? t("enabledDescription", { name: result.rule.name })
            : t("pausedDescription", { name: result.rule.name }),
        });
      }
    },
    onError: (error: Error) =>
      toast({ title: t("updateFailedTitle"), description: error.message, variant: "destructive" }),
  });
}

export function useDeleteAlertRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.alertRules");
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteAlertRuleResult>(`/api/v1/alerts/rules/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateRules(queryClient);
      toast({ title: t("deletedTitle"), description: t("deletedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("deleteFailedTitle"), description: error.message, variant: "destructive" }),
  });
}
