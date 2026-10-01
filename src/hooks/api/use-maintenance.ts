"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

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

/**
 * Overlap note (localized). Returns undefined when there is no overlap —
 * the caller embeds it as " {note}" so the joined copy keeps its spacing.
 */
function overlapDescription(
  result: MaintenanceMutationResult,
  t: ReturnType<typeof useTranslations>
): string | undefined {
  if (result.overlap.length === 0) return undefined;
  const first = result.overlap[0];
  return (
    t("overlapCount", { count: result.overlap.length }) +
    t("overlapTail", { name: first.name })
  );
}

/** Create a maintenance window (audited MAINTENANCE_WINDOW_CREATED). */
export function useCreateMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.maintenance");

  return useMutation({
    mutationFn: (payload: MaintenanceWindowPayload) =>
      apiFetch<MaintenanceMutationResult>("/api/v1/maintenance", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateMaintenanceSurfaces(queryClient);
      const overlapNote = overlapDescription(result, t);
      toast({
        title: t("createdTitle"),
        description: t("createdDescription", {
          name: result.window.name,
          overlap: overlapNote ? ` ${overlapNote}` : "",
        }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("createFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Partial update / isActive toggle (audited MAINTENANCE_WINDOW_UPDATED). */
export function useUpdateMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.maintenance");

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
        title: t("updatedTitle"),
        description: t("updatedDescription", { name: result.window.name }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("updateFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Quiet toggle for the inline isActive switch (no success toast). */
export function useToggleMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.maintenance");

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch<MaintenanceMutationResult>(`/api/v1/maintenance/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: (result, variables) => {
      invalidateMaintenanceSurfaces(queryClient);
      toast({
        title: variables.isActive ? t("suppressionEnabledTitle") : t("suppressionPausedTitle"),
        description: variables.isActive
          ? t("suppressionEnabledDescription", { name: result.window.name })
          : t("suppressionPausedDescription", { name: result.window.name }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("toggleFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}

/** Delete a window (audited MAINTENANCE_WINDOW_DELETED). */
export function useDeleteMaintenanceWindow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.maintenance");

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteMaintenanceWindowResult>(`/api/v1/maintenance/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateMaintenanceSurfaces(queryClient);
      toast({
        title: t("deletedTitle"),
        description: t("deletedDescription"),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("deleteFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}
