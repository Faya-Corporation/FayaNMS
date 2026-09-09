"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

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

const ACTION_LABELS: Record<string, string> = {
  acknowledge: "Incident acknowledged",
  assign: "Incident assigned",
  investigate: "Investigation started",
  mitigate: "Mitigation started",
  monitor: "Monitoring started",
  resolve: "Incident resolved",
  review: "Post-incident review opened",
  close: "Incident closed",
  "save-pir": "Post-incident review saved",
  "link-change": "Change linked",
  "unlink-change": "Change unlinked",
};

export function useIncidentAction(action: string) {
  const invalidate = useInvalidateIncidentSurfaces();
  const { toast } = useToast();
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
      const base = ACTION_LABELS[action] ?? "Action applied";
      const suffix = result.changeNumber ? ` — ${result.changeNumber}` : "";
      toast({ title: `${base}${suffix}`, description: `${result.incident.number} · ${result.incident.status.replace(/_/g, " ").toLowerCase()}` });
    },
    onError: (error: Error) =>
      toast({
        title: "Action failed",
        description: error.message,
        variant: "destructive",
      }),
  });
}
