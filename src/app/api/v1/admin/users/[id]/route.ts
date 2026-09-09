import { z } from "zod";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { USER_ROLES } from "@/lib/auth/roles";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/admin/users/[id] (Task 7-a) — update name/role/isActive/
 * password. Admin-only, audited USER_UPDATED (USR-XXXXXX).
 *
 * Self-guard: an admin cannot deactivate or demote THEMSELVES — that would
 * leave the platform without a writable session (and lock out the last
 * admin). Name/password self-updates remain allowed.
 */

const updateSchema = z
  .object({
    name: z.string().trim().min(1, "name cannot be empty").max(80).optional(),
    role: z.enum(USER_ROLES).optional(),
    isActive: z.boolean().optional(),
    password: z
      .string()
      .min(8, "password must be at least 8 characters")
      .max(128)
      .optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.role !== undefined ||
      data.isActive !== undefined ||
      data.password !== undefined,
    { message: "Provide at least one field to update (name, role, isActive, password)" }
  );

export async function PATCH(
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
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const target = await db.user.findUnique({ where: { id } });
  if (!target) {
    return fail("USER_NOT_FOUND", `No user exists with id "${id}"`, 404);
  }

  // Self-guard: no self-deactivation, no self-demotion.
  if (target.id === actor.id) {
    if (data.isActive === false) {
      return fail(
        "SELF_UPDATE_FORBIDDEN",
        "You cannot deactivate your own account — ask another admin.",
        409
      );
    }
    if (data.role !== undefined && data.role !== target.role) {
      return fail(
        "SELF_UPDATE_FORBIDDEN",
        "You cannot change your own role — ask another admin.",
        409
      );
    }
  }

  const passwordHash =
    data.password !== undefined ? await hashPassword(data.password) : undefined;

  const correlationId = newCorrelationId("USR");

  const user = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: target.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "USER_UPDATED",
        resourceType: "User",
        resourceId: updated.id,
        resourceLabel: updated.email,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({
          name: target.name,
          role: target.role,
          isActive: target.isActive,
          passwordChanged: data.password !== undefined,
        }),
        afterJson: JSON.stringify({
          name: updated.name,
          role: updated.role,
          isActive: updated.isActive,
          passwordChanged: data.password !== undefined,
        }),
      },
    });
    return updated;
  });

  return ok(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
      },
    },
    { correlationId }
  );
}
