"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

  return useMutation({
    mutationFn: (payload: CreateCredentialPayload) =>
      apiFetch<{ profile: CredentialProfileRow }>("/api/v1/credentials", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateCredentialCaches(queryClient);
      toast({
        title: "Credential profile created",
        description: `${result.profile.name} — the secret stays in the vault; FayaNMS stores the reference only.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not create credential profile",
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
        title: "Credential profile updated",
        description: `${result.profile.name} — vault reference unchanged unless you edited it.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update credential profile",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
