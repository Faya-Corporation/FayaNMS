"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("toast.changes");

  return useMutation({
    mutationFn: (payload: WizardPayload) =>
      apiFetch<ChangeCreateResult>("/api/v1/changes", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      toast({
        title: t("createdTitle", { number: result.change.number }),
        description: result.message,
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("createFailedTitle"),
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
  const t = useTranslations("toast.changes");

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
            ? t("updateCancelledTitle")
            : result.audit.action === "CHANGE_SUBMITTED"
              ? t("updateSubmittedTitle")
              : result.audit.action === "CHANGE_CLOSED"
                ? t("updateClosedTitle")
                : t("updateUpdatedTitle"),
        // result.message is server copy — kept verbatim.
        description: t("updateDescription", {
          message: result.message,
          correlation: result.audit.correlationId,
        }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("updateFailedTitle"),
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
  const t = useTranslations("toast.changes");

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ExecuteChangePayload }) =>
      apiFetch<ExecuteChangeResult>(`/api/v1/changes/${id}/execute`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateChangeGraph(queryClient);
      toast({
        title: t("executeTitle", { number: result.change.number }),
        description: t("executeDescription", {
          message: result.message,
          correlation: result.job.correlationId,
        }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("executeFailedTitle"),
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
  const t = useTranslations("toast.changes");

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
        title: t("incidentCreatedTitle", { number: result.incident.number }),
        description: t("incidentCreatedDescription", {
          message: result.message,
          severity: result.incident.severity,
        }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("incidentFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
