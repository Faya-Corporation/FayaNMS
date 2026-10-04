"use client";

import { useMutation } from "@tanstack/react-query";

import {
  confirmMfa as confirmMfaApi,
  disableMfa as disableMfaApi,
  enrollMfa as enrollMfaApi,
  ApiError,
  type MfaConfirmResult,
  type MfaDisableResult,
  type MfaEnrollResult,
} from "@/lib/api-client";

/**
 * Self-service MFA mutations (F-034 follow-up — the settings-UI wave).
 *
 * Unlike the other hook modules these mutations deliberately own NO toast
 * feedback: the account-security view needs the typed ApiError code (the
 * MFA_* family) to drive its status state machine and inline, code-mapped
 * error copy — and confirm's success payload is the reveal-once recovery
 * codes, which render as a card, not a toast.
 */

export function useEnrollMfa() {
  return useMutation<MfaEnrollResult, Error>({
    mutationFn: () => enrollMfaApi(),
  });
}

export function useConfirmMfa() {
  return useMutation<MfaConfirmResult, Error, string>({
    mutationFn: (code: string) => confirmMfaApi(code),
  });
}

export function useDisableMfa() {
  return useMutation<MfaDisableResult, Error, { password: string; code: string }>({
    mutationFn: ({ password, code }) => disableMfaApi(password, code),
  });
}

/**
 * Map an API error to its keyed localized message under the
 * `accountSecurity.errors` namespace. Unknown/foreign codes (including the
 * network-failure ApiError and non-ApiError throws) fall back to
 * `errors.fallback` — the API message itself is never rendered raw for the
 * MFA flows (its English server text would leak into the Arabic locale).
 */
export function mfaErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "MFA_DISABLED":
        return "errors.MFA_DISABLED";
      case "MFA_ALREADY_ENABLED":
        return "errors.MFA_ALREADY_ENABLED";
      case "MFA_NOT_ENROLLED":
        return "errors.MFA_NOT_ENROLLED";
      case "MFA_CODE_REQUIRED":
        return "errors.MFA_CODE_REQUIRED";
      case "MFA_CODE_INVALID":
      case "MFA_CODE_REPLAYED":
        return "errors.MFA_CODE_INVALID";
      case "MFA_PASSWORD_INVALID":
        return "errors.MFA_PASSWORD_INVALID";
      case "RBAC_FORBIDDEN":
        return "errors.RBAC_FORBIDDEN";
      case "UNAUTHENTICATED":
      case "ACCOUNT_DISABLED":
        return "errors.UNAUTHENTICATED";
      case "INVALID_BODY":
        return "errors.INVALID_BODY";
      case "NETWORK_ERROR":
        return "errors.network";
      default:
        return "errors.fallback";
    }
  }
  return "errors.fallback";
}
