"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type IncidentActionResult,
  type IncidentLifecycleActionPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Incident lifecycle mutations (Task 5-b). All actions POST to
 * /api/v1/incidents/[id]/[action]; every mutation invalidates the whole
 * "incidents" tree (list + detail + stats) plus dashboard and notifications
 * so every surface moves together.
 */

function useInvalidateIncidentSurfaces() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["incidents"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };
}

const ACTION_TITLE_KEYS: Record<string, string> = {
  acknowledge: "actions.acknowledge",
  assign: "actions.assign",
  investigate: "actions.investigate",
  mitigate: "actions.mitigate",
  monitor: "actions.monitor",
  resolve: "actions.resolve",
  review: "actions.review",
  close: "actions.close",
  "save-pir": "actions.savePir",
  "link-change": "actions.linkChange",
  "unlink-change": "actions.unlinkChange",
};

export function useIncidentAction(action: string) {
  const invalidate = useInvalidateIncidentSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.incidents");
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: IncidentLifecycleActionPayload;
    }) =>
      apiFetch<IncidentActionResult>(`/api/v1/incidents/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidate();
      // Unmapped actions fall back to the generic "action applied" title.
      const actionKey = ACTION_TITLE_KEYS[action];
      const base = actionKey ? t(actionKey) : t("actionFallback");
      const suffix = result.changeNumber ? ` — ${result.changeNumber}` : "";
      // {status} stays the raw lowercased enum token (technical value).
      toast({
        title: `${base}${suffix}`,
        description: t("actionDescription", {
          number: result.incident.number,
          status: result.incident.status.replace(/_/g, " ").toLowerCase(),
        }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("actionFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}
