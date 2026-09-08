"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  requestAiAssist,
  requestAiChangeDraft,
  requestAiRcaDraft,
  type AiAssistPayload,
  type AiAssistResult,
  type AiChangeDraftPayload,
  type AiChangeDraftResult,
  type AiRcaDraftPayload,
  type AiRcaDraftResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * AI mutation hooks (Phase 12-a). Errors are handled inline by the
 * components (the assistant tab renders an error state with retry, the
 * incident view surfaces the draft failure next to the button), so these
 * hooks intentionally carry no toasts.
 *
 * Success only invalidates the "events" audit stream — AI queries write
 * lean AI_* audit rows. Deliberately NOT invalidating "incidents": the RCA
 * draft never touches the incident record (the user saves the PIR through
 * the existing flow).
 */

export function useAiAssist(scope: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation<AiAssistResult, Error, AiAssistPayload>({
    mutationKey: queryKeys.aiAssist(scope, id),
    mutationFn: (payload) => requestAiAssist(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

export function useAiRcaDraft(incidentId: string) {
  const queryClient = useQueryClient();
  return useMutation<AiRcaDraftResult, Error, AiRcaDraftPayload>({
    mutationKey: queryKeys.aiRcaDraft(incidentId),
    mutationFn: (payload) => requestAiRcaDraft(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

/**
 * Natural-language → change-request draft (Phase 13-a). The result is only
 * ever a review suggestion — wiring it into the wizard is a pure client-side
 * prefill and no Change row is created here.
 */
export function useAiChangeDraft() {
  const queryClient = useQueryClient();
  return useMutation<AiChangeDraftResult, Error, AiChangeDraftPayload>({
    mutationKey: queryKeys.aiChangeDraft(),
    mutationFn: (payload) => requestAiChangeDraft(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

/**
 * Map an ApiError code to the relative "ai" namespace message key for it.
 * Falls back to null → callers render the raw server message.
 */
export function aiErrorKey(code: string): string | null {
  switch (code) {
    case "AI_UNAVAILABLE":
      return "errors.unavailable";
    case "AI_BAD_RESPONSE":
      return "errors.badResponse";
    case "DEVICE_NOT_FOUND":
    case "INCIDENT_NOT_FOUND":
      return "errors.notFound";
    default:
      return null;
  }
}
