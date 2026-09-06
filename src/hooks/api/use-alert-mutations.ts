"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

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
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Alert acknowledged", description: "Removed from the firing queue." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not acknowledge alert", description: errorMessage(error), variant: "destructive" }),
  });
}

export function useAssignAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, assignedToId }: { id: string; assignedToId: string }) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignedToId }),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Alert assigned", description: "The owner now shows on the stream row." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not assign alert", description: errorMessage(error), variant: "destructive" }),
  });
}

export function useSuppressAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/suppress`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Alert suppressed", description: "Hidden from the firing queue until unsuppressed." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not suppress alert", description: errorMessage(error), variant: "destructive" }),
  });
}

export function useUnsuppressAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/unsuppress`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Alert unsuppressed", description: "Back in the firing queue." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not unsuppress alert", description: errorMessage(error), variant: "destructive" }),
  });
}

export function useResolveAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AlertActionResult>(`/api/v1/alerts/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Alert resolved", description: "Marked resolved — history is kept." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not resolve alert", description: errorMessage(error), variant: "destructive" }),
  });
}

export function useCreateIncidentFromAlert() {
  const invalidate = useInvalidateAlertSurfaces();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CreateIncidentFromAlertResult>(`/api/v1/alerts/${id}/create-incident`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      invalidate();
      toast({
        title: `Incident ${result.incident.number} created`,
        description: `${result.incident.severity} linked to the alert — open Incidents for the timeline.`,
      });
    },
    onError: (error: Error) =>
      toast({ title: "Could not create incident", description: errorMessage(error), variant: "destructive" }),
  });
}
