"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type AlertActionResult,
  type CreateIncidentFromAlertResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Alert stream actions (Task 5-a): acknowledge / assign / suppress /
 * unsuppress / resolve / create-incident. Every mutation invalidates the
 * alert stream, the notifications center, incidents and the dashboard —
 * the engine, the stream and the header badge all move together.
 */

function useInvalidateAlertSurfaces() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["alerts"] });
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    void queryClient.invalidateQueries({ queryKey: ["incidents"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

function errorMessage(error: Error): string {
  return error.message;
}

export function useAcknowledgeAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("acknowledgedTitle"), description: t("acknowledgedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("acknowledgeFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}

export function useAssignAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: ({ id, assignedToId }: { id: string; assignedToId: string }) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignedToId }),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("assignedTitle"), description: t("assignedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("assignFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}

export function useSuppressAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/suppress`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("suppressedTitle"), description: t("suppressedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("suppressFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}

export function useUnsuppressAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/unsuppress`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("unsuppressedTitle"), description: t("unsuppressedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("unsuppressFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}

export function useResolveAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: t("resolvedTitle"), description: t("resolvedDescription") });
    },
    onError: (error: Error) =>
      toast({ title: t("resolveFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}

export function useCreateIncidentFromAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  const t = useTranslations("toast.alerts");
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CreateIncidentFromAlertResult>(`/api/v1/alerts/${id}/create-incident`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      invalidate();
      // {severity} stays the raw enum token (technical value).
      toast({
        title: t("incidentCreatedTitle", { number: result.incident.number }),
        description: t("incidentCreatedDescription", { severity: result.incident.severity }),
      });
    },
    onError: (error: Error) =>
      toast({ title: t("incidentFailedTitle"), description: errorMessage(error), variant: "destructive" }),
  });
}
