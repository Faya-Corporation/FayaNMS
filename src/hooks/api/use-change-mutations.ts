"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  type ChangeCreateResult,
  type ChangeMutationResult,
  type ExecuteChangePayload,
  type ExecuteChangeResult,
  type IncidentFromChangePayload,
  type IncidentFromChangeResult,
  type WizardPayload,
} from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";

function invalidateChangeGraph(queryClient: ReturnType<typeof useQueryClient>) {
  // Lists, detail, conflicts, approvals, dashboard KPIs (upcoming changes,
  // approvals) and the Job Center all move together across Task 4-b flows.
  void queryClient.invalidateQueries({ queryKey: ["changes"] });
  void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Create a change request (wizard). submit=true also creates PENDING approvals. */
export function useCreateChange() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: WizardPayload) =>
      apiFetch<ChangeCreateResult>("/api/v1/changes", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      toast({
        title: `Change ${result.change.number} created`,
        description: result.message,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not create the change",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * PATCH a change: field edit (DRAFT only), { action: "SUBMIT" },
 * { action: "CANCEL" } or { action: "CLOSE" } (SUCCESSFUL only) — the
 * server enforces the state machine.
 */
export function useUpdateChange() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<WizardPayload> & { action?: "SUBMIT" | "CANCEL" | "CLOSE" };
    }) =>
      apiFetch<ChangeMutationResult>(`/api/v1/changes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      toast({
        title:
          result.audit.action === "CHANGE_CANCELLED"
            ? "Change cancelled"
            : result.audit.action === "CHANGE_SUBMITTED"
              ? "Change submitted for approval"
              : result.audit.action === "CHANGE_CLOSED"
                ? "Change closed"
                : "Change updated",
        description: `${result.message} Audit ${result.audit.correlationId}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update the change",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Queue a change execution (Task 4-b). The worker picks the CHANGE_EXECUTE
 * job up within seconds; the change detail page then live-polls the steps.
 */
export function useExecuteChange() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ExecuteChangePayload }) =>
      apiFetch<ExecuteChangeResult>(`/api/v1/changes/${id}/execute`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      toast({
        title: `Execution queued — ${result.change.number}`,
        description: `${result.message} Correlation ${result.job.correlationId}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not queue the execution",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Create an incident from a FAILED change (Task 4-b outcome banner).
 * 409 INCIDENT_EXISTS surfaces verbatim (the incident chip already exists).
 */
export function useCreateIncidentFromChange() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: IncidentFromChangePayload) =>
      apiFetch<IncidentFromChangeResult>("/api/v1/incidents/from-change", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      toast({
        title: `Incident ${result.incident.number} created`,
        description: `${result.message} Severity ${result.incident.severity}, SLA due in 4 h.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not create the incident",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
