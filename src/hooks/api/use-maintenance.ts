"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type DeleteMaintenanceWindowResult,
  type MaintenanceListMeta,
  type MaintenanceMutationResult,
  type MaintenanceRow,
  type MaintenanceWindowPayload,
  type PagedResult,
  type UpdateMaintenanceWindowPayload,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Maintenance windows (Task 5-c). List + CRUD mutations. Every write
 * invalidates the "maintenance" tree plus the audit-event stream and the
 * alert surfaces (the engine suppresses during active windows) and the
 * dashboard.
 */
export interface MaintenanceListParams extends ListParams {
  status?: "ACTIVE" | "UPCOMING" | "PAST";
  siteId?: string;
  deviceId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function useMaintenance(params: MaintenanceListParams = {}) {
  return useQuery({
    queryKey: queryKeys.maintenance(params),
    queryFn: async (): Promise<PagedResult<MaintenanceRow, MaintenanceListMeta>> => {
      const envelope = await apiRequest<MaintenanceRow[]>(
        `/api/v1/maintenance${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as MaintenanceListMeta;
      return { data: envelope.data, meta };
    },
  });
}

function invalidateMaintenanceSurfaces(
  queryClient: ReturnType<typeof useQueryClient>
) {
  void queryClient.invalidateQueries({ queryKey: ["maintenance"] });
  // Window writes are audited and change alert-suppression semantics.
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: ["alerts"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

function overlapDescription(
  result: MaintenanceMutationResult
): string | undefined {
  if (result.overlap.length === 0) return undefined;
  const first = result.overlap[0];
  return (
    `Overlaps ${result.overlap.length} active same-scope window` +
    `${result.overlap.length === 1 ? "" : "s"} (e.g. ${first.name}). ` +
    "The most specific scope suppresses first — review in the list."
  );
}

/** Create a maintenance window (audited MAINTENANCE_WINDOW_CREATED). */
export function useCreateMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: MaintenanceWindowPayload) =>
      apiFetch<MaintenanceMutationResult>("/api/v1/maintenance", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateMaintenanceSurfaces(queryClient);
      const overlapNote = overlapDescription(result);
      toast({
        title: "Maintenance window created",
        description:
          `${result.window.name} — alerts for the scoped device(s) ` +
          `suppress while the window is active.${overlapNote ? ` ${overlapNote}` : ""}`,
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not create maintenance window",
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Partial update / isActive toggle (audited MAINTENANCE_WINDOW_UPDATED). */
export function useUpdateMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateMaintenanceWindowPayload;
    }) =>
      apiFetch<MaintenanceMutationResult>(`/api/v1/maintenance/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      invalidateMaintenanceSurfaces(queryClient);
      toast({
        title: "Maintenance window updated",
        description: `${result.window.name} saved.`,
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not update maintenance window",
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Quiet toggle for the inline isActive switch (no success toast). */
export function useToggleMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch<MaintenanceMutationResult>(`/api/v1/maintenance/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: (result, variables) => {
      invalidateMaintenanceSurfaces(queryClient);
      toast({
        title: variables.isActive ? "Suppression enabled" : "Suppression paused",
        description: `${result.window.name} — ${
          variables.isActive
            ? "alerts suppress while the window is active."
            : "alerts fire normally even inside the window."
        }`,
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not toggle suppression",
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Delete a window (audited MAINTENANCE_WINDOW_DELETED). */
export function useDeleteMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteMaintenanceWindowResult>(`/api/v1/maintenance/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateMaintenanceSurfaces(queryClient);
      toast({
        title: "Maintenance window deleted",
        description: "Suppression for the scope ends immediately.",
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Could not delete maintenance window",
        description: error.message,
        variant: "destructive",
      }),
  });
}
