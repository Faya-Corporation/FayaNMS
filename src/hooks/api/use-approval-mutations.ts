"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type ApprovalDecisionPayload,
  type ApprovalDecisionResult,
} from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";

function invalidateApprovalGraph(queryClient: ReturnType<typeof useQueryClient>) {
  // Queue ↔ change lists/detail ↔ dashboard KPIs move together on a decision.
  void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  void queryClient.invalidateQueries({ queryKey: ["changes"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/**
 * Record an approval decision (APPROVED/REJECTED) for one level of a change.
 * The server enforces the state machine and the separation-of-duties rule —
 * a 403 SOD_VIOLATION surfaces verbatim in the toast.
 */
export function useDecideApproval() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.approvals");

  return useMutation({
    mutationFn: ({
      changeId,
      payload,
    }: {
      changeId: string;
      payload: ApprovalDecisionPayload;
    }) =>
      apiFetch<ApprovalDecisionResult>(`/api/v1/changes/${changeId}/approvals`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateApprovalGraph(queryClient);
      // result.message is server copy — kept verbatim inside both variants.
      toast({
        title:
          result.audit.action === "CHANGE_APPROVED"
            ? t("approvedTitle", { number: result.change.number })
            : t("rejectedTitle", { number: result.change.number }),
        description:
          result.change.status === "APPROVED"
            ? t("descriptionApproved", {
                message: result.message,
                correlation: result.audit.correlationId,
              })
            : t("descriptionOther", {
                message: result.message,
                correlation: result.audit.correlationId,
              }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("failedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
