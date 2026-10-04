import { z } from "zod";

import {
  confirmMfaEnrollment,
  MfaError,
  mfaErrorToFail,
} from "@/lib/auth/mfa";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import {
  checkLoginAllowed,
  recordLoginFailure,
  resolveLoginIdentity,
} from "@/lib/auth/login-guard";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/me/mfa/confirm (F-034 phase 2) — complete a pending TOTP
 * enrollment with the first valid 6-digit code (proof the caller actually
 * provisioned the secret). Privileged roles only (admin/operator).
 *
 * On success the enrollment flips ENABLED (the code's time-step is stamped
 * as consumed so the confirming code cannot be replayed at sign-in) and
 * TEN single-use recovery codes are returned — plaintext EXACTLY ONCE;
 * only sha256 hashes are persisted.
 *
 * Rollback knob: FAYANMS_MFA_MODE=disabled gates confirm the same way it
 * gates enroll (MFA_DISABLED) — a pending row can never flip enabled while
 * the lever is set, so a pending row stays DISABLED and never challenges
 * at sign-in.
 *
 * Verification budget (post-register audit wave 5): failed code checks are
 * audited MFA_CONFIRM_FAILED and feed the login guard's ACCOUNT budget —
 * the same escalating lockout that covers sign-in — so an online guessing
 * attack against the enrollment code cannot ride the shared per-IP pool
 * unnoticed.
 */

const confirmSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "code is required")
    .max(16),
});

export async function POST(request: Request) {
  let actor;
  try {
    actor = await requireRole(request, "admin", "operator");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const identity = resolveLoginIdentity(
    new Headers(request.headers),
    actor.email
  );
  const verdict = await checkLoginAllowed(identity);
  if (!verdict.allowed) {
    return fail(
      "RATE_LIMITED",
      "Too many verification attempts — try again later.",
      429
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  try {
    const { recoveryCodes } = await confirmMfaEnrollment(
      actor,
      parsed.data.code
    );
    return ok({ enabled: true, recoveryCodes });
  } catch (error) {
    // Guessing-class failures share the sign-in account budget.
    if (
      error instanceof MfaError &&
      (error.code === "MFA_CODE_INVALID" || error.code === "MFA_PASSWORD_INVALID")
    ) {
      await recordLoginFailure(identity);
    }
    const envelope = mfaErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
}
