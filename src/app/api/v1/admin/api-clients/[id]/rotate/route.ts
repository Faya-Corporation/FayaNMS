import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";
import {
  fail,
  newCorrelationId,
  ok,
  requestContext,
} from "../../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/api-clients/[id]/rotate (Task 7-b)
 *
 * Issue a fresh 32-byte base64url token for the client: the stored sha256
 * hash and prefix are replaced, scopes/isActive carry over, and the new
 * plaintext token is returned ONCE. Audited API_CLIENT_ROTATED.
 * 404 API_CLIENT_NOT_FOUND.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { actor } = await resolveAdminActor(request);

    const existing = await db.apiClient.findUnique({ where: { id } });
    if (!existing) {
      return fail(
        "API_CLIENT_NOT_FOUND",
        "No API client exists with this id",
        404
      );
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const tokenPrefix = token.slice(0, 8);

    const updated = await db.apiClient.update({
      where: { id },
      data: { tokenHash, tokenPrefix },
    });

    const correlationId = newCorrelationId("AXC");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name,
        action: "API_CLIENT_ROTATED",
        resourceType: "ApiClient",
        resourceId: id,
        resourceLabel: updated.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({ tokenPrefix: existing.tokenPrefix }),
        afterJson: JSON.stringify({ tokenPrefix }),
      },
    });

    let scopes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(updated.scopesJson);
      if (Array.isArray(parsed)) {
        scopes = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      scopes = [];
    }

    return ok(
      {
        client: {
          id: updated.id,
          name: updated.name,
          tokenPrefix: updated.tokenPrefix,
          scopes,
          isActive: updated.isActive,
          lastUsedAt: updated.lastUsedAt
            ? updated.lastUsedAt.toISOString()
            : null,
          createdAt: updated.createdAt.toISOString(),
          createdBy: updated.createdBy,
        },
        // Shown exactly once — only the sha256 hash is stored server-side.
        token,
        audit: { correlationId },
      },
      { correlationId },
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
