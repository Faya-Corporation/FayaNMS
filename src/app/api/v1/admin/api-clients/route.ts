import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  requestContext,
} from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/api-clients (Task 7-b)
 *
 * GET   — list registered API clients. tokenHash is NEVER returned; the
 *         response carries tokenPrefix (first 8 chars of the plaintext
 *         token) and parsed scopes. The scope catalog rides along so the
 *         UI renders the same checkbox set the server accepts.
 * POST  — create a client: name + scopes[] → 32-byte base64url bearer
 *         token. Only the sha256 hash + prefix are stored; the plaintext
 *         token is returned ONCE in this response. Audited
 *         API_CLIENT_CREATED with an AXC-XXXXXX correlation.
 *
 * NOTE: P1-012 wires the bearer plane — an active client's token now
 * authenticates the permission-gated MUTATION routes through
 * requirePermission → authenticateApiClient (scope-mapped, lastUsedAt
 * stamped with a 60 s throttle, audit attribution traces to the client
 * row). Read routes remain session-gated: the `.read` catalog scopes are
 * RESERVED until read routes grow handler-level gates (documented in
 * src/lib/auth/api-client-auth.ts).
 */

/** Advisory scope catalog (resource.action) rendered by the create dialog. */
export const API_SCOPE_CATALOG = [
  "devices.read",
  "devices.write",
  "config.read",
  "config.write",
  "alerts.read",
  "alerts.write",
  "incidents.read",
  "incidents.write",
  "changes.read",
  "changes.write",
  "metrics.read",
  "admin.read",
  "admin.write",
] as const;

const createSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").max(80),
  scopes: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "select at least one scope")
    .max(32, "at most 32 scopes"),
  isActive: z.boolean().optional(),
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

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    const rows = await db.apiClient.findMany({
      orderBy: { createdAt: "desc" },
    });
    return ok(
      {
        clients: rows.map(clientView),
        scopes: API_SCOPE_CATALOG,
      },
      undefined,
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    // Phase 19-C (audit AUTHZ-001 sweep): API client management is
    // admin-only — requireRole("admin") replaces the resolveAdminActor
    // call, whose UNAUTHENTICATED fallback let anonymous callers through.
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
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }

    const scopes = Array.from(new Set(parsed.data.scopes));
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const tokenPrefix = token.slice(0, 8);

    const correlationId = newCorrelationId("AXC");
    const row = await db.apiClient.create({
      data: {
        name: parsed.data.name,
        tokenHash,
        tokenPrefix,
        scopesJson: JSON.stringify(scopes),
        isActive: parsed.data.isActive ?? true,
        createdBy: actor.id,
      },
    });

    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "API_CLIENT_CREATED",
        resourceType: "ApiClient",
        resourceId: row.id,
        resourceLabel: row.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          name: row.name,
          scopes,
          tokenPrefix,
          isActive: row.isActive,
        }),
      },
    });

    return ok(
      {
        client: clientView(row),
        // Shown exactly once — only the sha256 hash is stored server-side.
        token,
        audit: { correlationId },
      },
      { correlationId },
      201,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
