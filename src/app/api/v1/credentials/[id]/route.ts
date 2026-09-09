import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/credentials/[id] — edit a credential profile.
 *
 * SECURITY INVARIANT (audit finding F-12): only reference material is ever
 * sent or stored — the request carries the vault REFERENCE (secretRef,
 * "vault://…"), never a secret. All fields are optional; omitted fields are
 * left untouched.
 *
 * Route params are async in Next 16: `params: Promise<{ id: string }>`.
 */

const CREDENTIAL_TYPES = ["SSH_PASSWORD", "SSH_KEY", "API_TOKEN", "SNMPV3", "HTTPS"] as const;

const patchSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80).optional(),
  type: z.enum(CREDENTIAL_TYPES).optional(),
  username: z.string().trim().min(1, "username is required").max(80).optional(),
  secretRef: z
    .string()
    .trim()
    .min(1, "secretRef is required")
    .max(200)
    .startsWith("vault://", "secretRef must point into the vault (vault://…)")
    .optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): credential profiles are sensitive
  // administration — editing requires "admin.credential"; the audit row is
  // attributed to the session principal (hardcoded "admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "admin.credential");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  if (Object.keys(data).length === 0) {
    return fail("INVALID_BODY", "No editable fields were provided", 400);
  }

  const existing = await db.credentialProfile.findUnique({ where: { id } });
  if (!existing) {
    return fail("CREDENTIAL_NOT_FOUND", "The credential profile does not exist", 404);
  }

  if (data.name && data.name !== existing.name) {
    const nameTaken = await db.credentialProfile.findUnique({
      where: { name: data.name },
      select: { id: true },
    });
    if (nameTaken) {
      return fail(
        "CREDENTIAL_NAME_TAKEN",
        `A credential profile named "${data.name}" already exists`,
        409
      );
    }
  }

  const correlationId = newJobCorrelationId();

  const profile = await db.$transaction(async (tx) => {
    const updated = await tx.credentialProfile.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.username !== undefined ? { username: data.username } : {}),
        ...(data.secretRef !== undefined ? { secretRef: data.secretRef } : {}),
        ...(data.port !== undefined ? { port: data.port } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "CREDENTIAL_UPDATED",
        resourceType: "CredentialProfile",
        resourceId: updated.id,
        resourceLabel: updated.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({
          name: existing.name,
          type: existing.type,
          username: existing.username,
          secretRef: existing.secretRef,
          port: existing.port,
        }),
        afterJson: JSON.stringify({
          name: updated.name,
          type: updated.type,
          username: updated.username,
          secretRef: updated.secretRef,
          port: updated.port,
        }),
      },
    });
    return updated;
  });

  return ok(
    {
      profile: {
        id: profile.id,
        name: profile.name,
        type: profile.type,
        username: profile.username,
        secretRef: profile.secretRef,
        port: profile.port,
        notes: profile.notes,
        lastRotatedAt: profile.lastRotatedAt?.toISOString() ?? null,
        deviceCount: 0,
      },
    },
    { correlationId }
  );
}
