import { z } from "zod";

import { disableMfa, MfaError, mfaErrorToFail } from "@/lib/auth/mfa";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import {
  checkLoginAllowed,
  recordLoginFailure,
  resolveLoginIdentity,
} from "@/lib/auth/login-guard";
import { fail, firstIssueMessage, ok } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/me/mfa (F-034 phase 2) — disable the caller's TOTP
 * second factor. Privileged roles only (admin/operator).
 *
 * FAIL-TIGHT by design: requires BOTH the account password (re-entry) AND
 * a current 6-digit TOTP code or an unused recovery code — a stolen session
 * alone can never strip the second factor. The enrollment row (and its
 * recovery codes, by cascade) is deleted; audited MFA_DISABLED.
 *
 * Unlike enroll/confirm this route works in BOTH FAYANMS_MFA_MODE values:
 * disabling is a security-relevant cleanup and verification is fully
 * data-driven (the stored secret still validates codes while the knob is
 * off).
 *
 * Rate-gate note: this handler lives under the /api/v1/me family (NOT the
 * public-bootstrap /api/v1/auth prefix — the NEW-1 governance pin keeps that
 * prefix read-only). It sits behind the normal /api/v1 rate gate, and
 * requireRole still answers the 401 envelope; the session cookie's
 * SameSite=Lax policy guards the mutation itself.
 *
 * Verification budget (post-register audit wave 5): failed password
 * re-entry and failed code checks are audited MFA_DISABLE_FAILED and feed
 * the login guard's ACCOUNT budget — the same escalating lockout that
 * covers sign-in — so an online guessing attack against the fail-tight
 * verification cannot ride the shared per-IP pool unnoticed.
 */

const disableSchema = z.object({
  password: z
    .string()
    .min(1, "password is required")
    .max(128),
  code: z
    .string()
    .trim()
    .min(1, "a current TOTP code or an unused recovery code is required")
    .max(16),
});

export async function DELETE(request: Request) {
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
  const parsed = disableSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  try {
    await disableMfa(actor, parsed.data.password, parsed.data.code);
    return ok({ enabled: false });
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
