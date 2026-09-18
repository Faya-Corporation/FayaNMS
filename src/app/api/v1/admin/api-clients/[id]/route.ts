import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/api-clients/[id] (Task 7-b)
 *
 * PATCH  — partial update (name, scopes, isActive). Setting
 *          isActive = false revokes the token and is audited
 *          API_CLIENT_REVOKED; every other change is audited
 *          API_CLIENT_UPDATED. 404 API_CLIENT_NOT_FOUND.
 * DELETE — remove the client entirely. Audited API_CLIENT_DELETED with a
 *          beforeJson snapshot. 404 API_CLIENT_NOT_FOUND.
 *
 * tokenHash is never returned by either action.
 */

const patchSchema = z
  .object({
    name: z.string().trim().min(1, "name cannot be empty").max(80).optional(),
    scopes: z
      .array(z.string().trim().min(1).max(64))
      .min(1, "select at least one scope")
      .max(32, "at most 32 scopes")
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "at least one of name/scopes/isActive is required",
  });

/** Serialize WITHOUT tokenHash — the hash never leaves the server. */
function clientView(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopesJson: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}) {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopesJson);
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes,
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
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

    const existing = await db.apiClient.findUnique({ where: { id } });
    if (!existing) {
      return fail(
        "API_CLIENT_NOT_FOUND",
        "No API client exists with this id",
        404
      );
    }

    const revoking = parsed.data.isActive === false && existing.isActive;
    const scopes =
      parsed.data.scopes !== undefined
        ? Array.from(new Set(parsed.data.scopes))
        : undefined;

    const updated = await db.apiClient.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(scopes !== undefined ? { scopesJson: JSON.stringify(scopes) } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
    });

    const correlationId = newCorrelationId("AXC");
    const after = clientView(updated);
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: revoking ? "API_CLIENT_REVOKED" : "API_CLIENT_UPDATED",
        resourceType: "ApiClient",
        resourceId: id,
        resourceLabel: updated.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(clientView(existing)),
        afterJson: JSON.stringify(after),
      },
    });

    return ok(
      { client: after, audit: { correlationId } },
      { correlationId },
      200
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }

    const existing = await db.apiClient.findUnique({ where: { id } });
    if (!existing) {
      return fail(
        "API_CLIENT_NOT_FOUND",
        "No API client exists with this id",
        404
      );
    }

    await db.apiClient.delete({ where: { id } });

    const correlationId = newCorrelationId("AXC");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "API_CLIENT_DELETED",
        resourceType: "ApiClient",
        resourceId: id,
        resourceLabel: existing.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(clientView(existing)),
      },
    });

    return ok(
      { deleted: true, id, audit: { correlationId } },
      { correlationId },
      200
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
