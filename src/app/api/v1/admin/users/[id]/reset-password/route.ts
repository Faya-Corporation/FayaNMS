import { z } from "zod";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/users/[id]/reset-password (Task 7-a) — admin-only
 * password reset. The new password is scrypt-hashed immediately; plaintext
 * is never persisted. Audited USER_PASSWORD_RESET (USR-XXXXXX) with NO
 * password material in the audit payload.
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

  const passwordHash = await hashPassword(parsed.data.password);
  const correlationId = newCorrelationId("USR");

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { passwordHash },
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
