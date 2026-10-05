import { z } from "zod";

import { db } from "@/lib/db";
import { breachIssueToFail, checkPasswordBreach } from "@/lib/auth/hibp";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/users/[id]/reset-password (Task 7-a) — admin-only
 * password reset. The new password is scrypt-hashed immediately; plaintext
 * is never persisted. F-034 phase 1: the role-aware password policy is
 * enforced against the TARGET account's role (the policy travels with the
 * account, not with the acting admin). F-034 follow-up: the config-gated
 * HIBP k-anonymity breach check (FAYANMS_HIBP_MODE=enforce) gates the same
 * SET after the offline policy, before any hashing. Audited
 * USER_PASSWORD_RESET (USR-XXXXXX) with NO password material in the audit
 * payload.
 */

const resetSchema = z.object({
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(128),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let actor;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const target = await db.user.findUnique({ where: { id } });
  if (!target) {
    return fail("USER_NOT_FOUND", `No user exists with id "${id}"`, 404);
  }

  // F-034 phase 1: policy keyed to the TARGET's role — resetting an
  // operator/admin account below the privileged bar is refused.
  const policyIssue = validatePasswordPolicy(parsed.data.password, target.role);
  if (policyIssue) {
    return fail(policyIssue.code, policyIssue.message, 400);
  }

  // F-034 follow-up: the config-gated HIBP k-anonymity breach check —
  // only after the offline policy passed, off (default) = no-op null,
  // enforce + breach/unavailable refuses the SET fail-closed.
  const breachIssue = await checkPasswordBreach(parsed.data.password);
  if (breachIssue) {
    return breachIssueToFail(breachIssue);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const correlationId = newCorrelationId("USR");

  await db.$transaction(async (tx) => {
    // Wave-9 credential epoch (audit 9-a F-3): the bump rides the SAME
    // transaction as the hash swap — every token minted before this reset
    // fails requireUser's epoch-vs-DB comparison on its next request and
    // answers 401 UNAUTHENTICATED (fresh sign-in with the new password
    // mints the new epoch). The resetting admin's own session is untouched
    // (the epoch is per-target).
    await tx.user.update({
      where: { id: target.id },
      data: { passwordHash, credentialEpoch: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "USER_PASSWORD_RESET",
        resourceType: "User",
        resourceId: target.id,
        resourceLabel: target.email,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          email: target.email,
          passwordChanged: true, // never the value itself
        }),
      },
    });
  });

  return ok(
    { reset: true, email: target.email },
    { correlationId }
  );
}
