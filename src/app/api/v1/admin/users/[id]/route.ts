import { z } from "zod";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { USER_ROLES } from "@/lib/auth/roles";
import { userSiteScopeClaim } from "@/lib/auth/scope";
import { requireRole, authErrorToFail } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/admin/users/[id] (Task 7-a) — update name/role/isActive/
 * password. Admin-only, audited USER_UPDATED (USR-XXXXXX).
 *
 * F-031 — siteScope (string[] | null): admin-only write surface for the
 * per-user SITE SCOPE the session JWT `sites` claim is minted from at
 * sign-in. null = wildcard (every site — the single-tenant default); an
 * array limits the user's device reads to those site codes. Validation:
 * ≤ 32 codes, each ≤ 32 chars matching SITE_SCOPE_CODE_PATTERN, trimmed,
 * deduped (order-preserving). Audited with dedicated rows —
 * USER_SCOPE_SET / USER_SCOPE_CLEARED — alongside USER_UPDATED when other
 * identity fields changed (kept out of USER_UPDATED's before/after so each
 * row states one fact). EFFECT TIMING (honest): the JWT is minted at
 * login, so a scope change lands on the user's NEXT sign-in — no live
 * token revocation (authorization-matrix.md §5). Self-service scope
 * changes are allowed (unlike deactivation/demotion): the admin plane is
 * not device-scoped, so a self-scope cannot lock the platform out.
 *
 * Self-guard: an admin cannot deactivate or demote THEMSELVES — that would
 * leave the platform without a writable session (and lock out the last
 * admin). Name/password self-updates remain allowed.
 */

// F-031: site codes are unique Site.code values (seed convention:
// "HQ-SAN", "DC-ADN" — letters/digits then letters/digits/hyphen/underscore).
const SITE_SCOPE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SITE_SCOPE_MAX_CODES = 32;
const SITE_SCOPE_MAX_CODE_LENGTH = 32;

const siteScopeSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "site codes cannot be empty")
      .max(SITE_SCOPE_MAX_CODE_LENGTH, "site codes are at most 32 characters")
      .regex(
        SITE_SCOPE_CODE_PATTERN,
        "site codes must start with a letter or digit and contain only letters, digits, '-' or '_'"
      )
  )
  .max(SITE_SCOPE_MAX_CODES, "a site scope holds at most 32 site codes")
  .nullable()
  .optional()
  // Dedupe (order-preserving) at the validation boundary — a duplicated
  // code is redundant, not an error.
  .transform((value) =>
    value === undefined || value === null ? value : [...new Set(value)]
  );

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
    siteScope: siteScopeSchema,
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.role !== undefined ||
      data.isActive !== undefined ||
      data.password !== undefined ||
      data.siteScope !== undefined,
    { message: "Provide at least one field to update (name, role, isActive, password, siteScope)" }
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

  // F-031: the scope column value (undefined = untouched, null = wildcard).
  const siteScopeJson =
    data.siteScope === undefined
      ? undefined
      : data.siteScope === null
        ? null
        : JSON.stringify(data.siteScope);
  const hasIdentityFields =
    data.name !== undefined ||
    data.role !== undefined ||
    data.isActive !== undefined ||
    data.password !== undefined;

  const correlationId = newCorrelationId("USR");

  const user = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: target.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
        // F-031: rides the same transactional update; its audit trail is
        // the dedicated scope row below (deliberately NOT folded into the
        // USER_UPDATED before/after — each audit row states one fact).
        ...(siteScopeJson !== undefined ? { siteScopeJson } : {}),
      },
    });
    if (hasIdentityFields) {
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
    }
    if (data.siteScope !== undefined) {
      // F-031 dedicated scope audit: SET for a non-null scope, CLEARED for
      // the wildcard reset. beforeJson shows the EFFECTIVE prior scope
      // (userSiteScopeClaim is fail-closed: a malformed stored row reads []).
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: data.siteScope === null ? "USER_SCOPE_CLEARED" : "USER_SCOPE_SET",
          resourceType: "User",
          resourceId: updated.id,
          resourceLabel: updated.email,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            siteScope:
              target.siteScopeJson === null
                ? null
                : userSiteScopeClaim(target.siteScopeJson),
          }),
          afterJson: JSON.stringify({ siteScope: data.siteScope }),
        },
      });
    }
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
        // F-031: the stored scope, parsed for the admin UI (next sign-in
        // effect — see the docblock).
        siteScope: userSiteScopeClaim(user.siteScopeJson) ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    },
    { correlationId }
  );
}
