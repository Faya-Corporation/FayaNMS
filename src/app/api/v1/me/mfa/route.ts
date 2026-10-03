import { z } from "zod";

import { disableMfa, mfaErrorToFail } from "@/lib/auth/mfa";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
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
    const envelope = mfaErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
}
