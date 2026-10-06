import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";
import {
  fail,
  newCorrelationId,
  ok,
} from "../../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";

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

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const tokenPrefix = token.slice(0, 8);

    // Wave-9 (audit 9-a F-2): the hash/prefix swap and its
    // API_CLIENT_ROTATED audit row commit together — a rotated credential
    // can never exist without its audit trail (or vice versa).
    const correlationId = newCorrelationId("AXC");
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.apiClient.update({
        where: { id },
        // P1-A04: rotation bookkeeping — rotatedAt stamps the credential
        // handover; the full trail lives in the API_CLIENT_ROTATED audit
        // rows (beforeJson/afterJson carry the token prefixes).
        data: { tokenHash, tokenPrefix, rotatedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "API_CLIENT_ROTATED",
          resourceType: "ApiClient",
          resourceId: id,
          resourceLabel: row.name,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({ tokenPrefix: existing.tokenPrefix }),
          afterJson: JSON.stringify({ tokenPrefix }),
        },
      });
      return row;
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
      200
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
