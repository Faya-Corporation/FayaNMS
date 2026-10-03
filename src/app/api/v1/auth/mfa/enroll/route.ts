import { z } from "zod";

import {
  beginMfaEnrollment,
  mfaErrorToFail,
} from "@/lib/auth/mfa";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import { fail, firstIssueMessage, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/mfa/enroll (F-034 phase 2) — begin self-service TOTP
 * enrollment for PRIVILEGED roles (admin/operator; other roles answer
 * 403 RBAC_FORBIDDEN — the second factor targets the config-pushing plane).
 *
 * Generates a fresh Base32 secret + otpauth:// URI (issuer FayaNMS) for the
 * caller's authenticator app. The enrollment row is stored DISABLED —
 * nothing challenges at sign-in until the first valid code is confirmed via
 * POST /api/v1/auth/mfa/confirm (proof of possession).
 *
 * Rollback knob: FAYANMS_MFA_MODE=disabled answers 400 MFA_DISABLED here —
 * the documented operator lever (see src/lib/auth/mfa.ts).
 *
 * Proxy note: /api/v1/auth/* is the public-bootstrap prefix (step 3a in
 * src/proxy.ts), so THIS handler owns authentication (requireRole answers
 * the 401 envelope) — anonymous callers fail closed here, and the
 * session cookie's SameSite=Lax policy guards the mutation itself.
 *
 * Honest limitation (documented in the PR): enrollment is API-only at this
 * stage (curl / OpenAPI); the settings-UI wave owns the form.
 */

const enrollSchema = z.object({}).optional();

export async function POST(request: Request) {
  let actor;
  try {
    actor = await requireRole(request, "admin", "operator");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  // Tolerate an empty body (curl convenience) but reject non-JSON junk.
  // Single read: the request stream can only be consumed once.
  const rawBody = (await request.text()).trim();
  if (rawBody.length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return fail("INVALID_BODY", "Request body must be valid JSON", 400);
    }
    const parsed = enrollSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }
  }

  try {
    const enrollment = await beginMfaEnrollment(actor);
    return ok({
      enrolled: true,
      enabled: false,
      secret: enrollment.secret,
      otpauth: enrollment.otpauth,
      confirm: "POST /api/v1/auth/mfa/confirm with the 6-digit code",
    });
  } catch (error) {
    const envelope = mfaErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
}
