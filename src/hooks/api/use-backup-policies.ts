"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type BackupPolicyMutationResult,
  type BackupPolicyPayload,
  type BackupPolicyRow,
  type DeleteBackupPolicyResult,
  type UpdateBackupPolicyPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/** Backup policies with computed scope/enqueue stats (Backups view, Policies tab). */
export function useBackupPolicies() {
  return useQuery({
    queryKey: queryKeys.backupPolicies(),
    queryFn: () => apiFetch<BackupPolicyRow[]>("/api/v1/backup-policies"),
    staleTime: 30_000,
  });
}

function invalidatePolicies(queryClient: ReturnType<typeof useQueryClient>) {
  // Policies drive the scheduler — jobs enqueued by them surface via jobs.
  void queryClient.invalidateQueries({ queryKey: ["backupPolicies"] });
}

/** Create a backup policy. Becomes a live schedule on the next worker tick. */
export function useCreateBackupPolicy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.backupPolicies");

  return useMutation({
    mutationFn: (payload: BackupPolicyPayload) =>
      apiFetch<BackupPolicyMutationResult>("/api/v1/backup-policies", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidatePolicies(queryClient);
      toast({
        title: t("createdTitle"),
        description: t("createdDescription", { name: result.policy.name }),
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

/** Partial policy update (name, cron, scope, retention, isActive toggle). */
export function useUpdateBackupPolicy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.backupPolicies");

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateBackupPolicyPayload }) =>
      apiFetch<BackupPolicyMutationResult>(`/api/v1/backup-policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (result, variables) => {
      invalidatePolicies(queryClient);
      // The inline isActive toggle has its own quiet confirmation below.
      if (variables.data.isActive !== undefined) {
        toast({
          title: variables.data.isActive ? t("enabledTitle") : t("pausedTitle"),
          description: variables.data.isActive
            ? t("enabledDescription", { name: result.policy.name })
            : t("pausedDescription", { name: result.policy.name }),
        });
      }
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

/** Delete a policy. Policies are standalone — backup history is untouched. */
export function useDeleteBackupPolicy() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.backupPolicies");

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteBackupPolicyResult>(`/api/v1/backup-policies/${id}`, {
        method: "DELETE",
      }),
    onSuccess: (result) => {
      invalidatePolicies(queryClient);
      toast({
        title: t("deletedTitle"),
        description: t("deletedDescription", {
          label: result.audit.resourceLabel ?? t("policyFallback"),
        }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("deleteFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
