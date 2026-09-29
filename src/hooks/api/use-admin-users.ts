"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  createUser as createUserApi,
  fetchAdminRoles,
  resetUserPassword as resetUserPasswordApi,
  updateUser as updateUserApi,
  type AdminRoleRow,
  type AdminUserRow,
  type AdminUsersListMeta,
  type AdminUsersResult,
  type CreateUserPayload,
  type PagedResult,
  type ResetPasswordResult,
  type UpdateUserPayload,
  type UserMutationResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Administration: users + roles (Task 7-a). List/create/update/reset
 * mutations invalidate the whole "admin" tree plus the audit-event stream
 * (every admin action is audited) and the auth session (the acting user's
 * own role may change).
 */

export interface AdminUsersListParams extends ListParams {
  q?: string;
  page?: number;
  pageSize?: number;
}

export function useAdminUsers(params: AdminUsersListParams = {}) {
  return useQuery({
    queryKey: queryKeys.adminUsers(params),
    queryFn: async (): Promise<PagedResult<AdminUserRow, AdminUsersListMeta>> => {
      const envelope = await apiRequest<AdminUserRow[]>(
        `/api/v1/admin/users${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as AdminUsersListMeta;
      return { data: envelope.data, meta };
    },
  });
}

/** Paged result type reuse: AdminUsersResult is the same shape. */
export type { AdminUsersResult };

export function useAdminRoles() {
  return useQuery({
    queryKey: queryKeys.adminRoles(),
    queryFn: fetchAdminRoles,
  });
}

function invalidateAdminSurfaces(
  queryClient: ReturnType<typeof useQueryClient>
) {
  void queryClient.invalidateQueries({ queryKey: ["admin"] });
  // User changes are audited → the event stream refreshes; the session's
  // own claims (role/isActive) may have changed as well.
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.authSession() });
}

/** Create a user (audited USER_CREATED). */
export function useCreateUser() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.users");

  return useMutation({
    mutationFn: (payload: CreateUserPayload) => createUserApi(payload),
    onSuccess: (result) => {
      invalidateAdminSurfaces(queryClient);
      // {role} stays the raw enum token (technical value).
      toast({
        title: t("createdTitle"),
        description: t("createdDescription", {
          email: result.user.email,
          role: result.user.role,
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

/** Partial update — role select, activate/deactivate switch (audited USER_UPDATED). */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.users");

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUserPayload }) =>
      updateUserApi(id, data),
    onSuccess: (result, variables) => {
      invalidateAdminSurfaces(queryClient);
      // {role} stays the raw enum token (technical value).
      const parts: string[] = [];
      if (variables.data.role !== undefined)
        parts.push(t("updateRoleSegment", { role: variables.data.role }));
      if (variables.data.isActive !== undefined)
        parts.push(variables.data.isActive ? t("updateActivatedSegment") : t("updateDeactivatedSegment"));
      if (variables.data.name !== undefined) parts.push(t("updateNameSegment"));
      if (variables.data.password !== undefined) parts.push(t("updatePasswordSegment"));
      toast({
        title: t("updatedTitle"),
        description: t("updatedDescription", {
          email: result.user.email,
          changes: parts.length ? ` — ${parts.join(", ")}` : "",
        }),
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

/** Admin-only password reset (audited USER_PASSWORD_RESET). */
export function useResetUserPassword() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.users");

  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      resetUserPasswordApi(id, password),
    onSuccess: (result: ResetPasswordResult) => {
      invalidateAdminSurfaces(queryClient);
      toast({
        title: t("resetTitle"),
        description: t("resetDescription", { email: result.email }),
      });
    },
    onError: (error: Error) =>
      toast({
        title: t("resetFailedTitle"),
        description: error.message,
        variant: "destructive",
      }),
  });
}
