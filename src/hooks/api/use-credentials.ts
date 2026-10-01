"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  type CreateCredentialPayload,
  type CredentialProfileRow,
  type UpdateCredentialPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Credential profiles client data layer (2-c).
 *
 * SECURITY INVARIANT (F-12): the payloads only ever carry the vault
 * REFERENCE (secretRef) — never a secret. The API never returns secret
 * material and this layer renders secretRef as technical reference text.
 */
export function useCredentials() {
  return useQuery({
    queryKey: queryKeys.credentials(),
    queryFn: () => apiFetch<CredentialProfileRow[]>("/api/v1/credentials"),
  });
}

function invalidateCredentialCaches(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["credentials"] });
  void queryClient.invalidateQueries({ queryKey: ["meta"] });
}

/** Create a credential profile. */
export function useCreateCredential() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.credentials");

  return useMutation({
    mutationFn: (payload: CreateCredentialPayload) =>
      apiFetch<{ profile: CredentialProfileRow }>("/api/v1/credentials", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateCredentialCaches(queryClient);
      toast({
        title: t("createdTitle"),
        description: t("createdDescription", { name: result.profile.name }),
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

/** Update a credential profile (partial). */
export function useUpdateCredential() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.credentials");

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateCredentialPayload;
    }) =>
      apiFetch<{ profile: CredentialProfileRow }>(`/api/v1/credentials/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      invalidateCredentialCaches(queryClient);
      toast({
        title: t("updatedTitle"),
        description: t("updatedDescription", { name: result.profile.name }),
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
