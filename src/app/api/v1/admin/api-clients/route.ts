import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { SITE_SCOPE_MAX_CODES } from "@/lib/auth/scope";

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
  // P1-A04: optional explicit expiry (ISO datetime). When omitted, the
  // FAYANMS_API_CLIENT_MAX_LIFETIME_DAYS policy applies (default 90; 0
  // disables the automatic lifetime — the row then has no expiry unless
  // the admin passes one explicitly).
  expiresAt: z.string().datetime({ offset: true }).optional(),
  // P1-A05: optional resource scope. Omitted/null = global (the admin's
  // explicit choice, documented); [] = deny-all; codes = sites mode.
  siteCodes: z.array(z.string().trim().min(1).max(64)).max(SITE_SCOPE_MAX_CODES).optional(),
});

/** Serialize WITHOUT tokenHash — the hash never leaves the server. */
function clientView(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopesJson: string;
  isActive: boolean;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  siteScopeJson: string | null;
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
  let siteCodes: string[] | null = null;
  if (row.siteScopeJson !== null) {
    try {
      const parsed: unknown = JSON.parse(row.siteScopeJson);
      siteCodes = Array.isArray(parsed)
        ? parsed.filter((s): s is string => typeof s === "string")
        : [];
    } catch {
      siteCodes = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes,
    isActive: row.isActive,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
    siteCodes,
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
      200
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

    // P1-A04 — credential lifetime policy (FAYANMS_API_CLIENT_MAX_LIFETIME_DAYS,
    // clamped 0..3650, default 90): an explicit future expiresAt is honored
    // but must not exceed the maximum; an omitted expiresAt gets the
    // default lifetime (unless the policy is 0 — then no expiry at all).
    const rawLifetimeDays = Number.parseInt(
      process.env.FAYANMS_API_CLIENT_MAX_LIFETIME_DAYS ?? "90",
      10
    );
    const maxLifetimeDays = Number.isFinite(rawLifetimeDays)
      ? Math.min(Math.max(rawLifetimeDays, 0), 3650)
      : 90;
    let expiresAt: Date | null = null;
    if (parsed.data.expiresAt) {
      expiresAt = new Date(parsed.data.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        return fail("INVALID_EXPIRY", "expiresAt must be a future ISO datetime", 400);
      }
      if (maxLifetimeDays > 0) {
        const maxMs = Date.now() + maxLifetimeDays * 86_400_000;
        if (expiresAt.getTime() > maxMs) {
          return fail(
            "EXPIRY_BEYOND_MAX_LIFETIME",
            `expiresAt exceeds the ${maxLifetimeDays}-day maximum lifetime policy`,
            400
          );
        }
      }
    } else if (maxLifetimeDays > 0) {
      expiresAt = new Date(Date.now() + maxLifetimeDays * 86_400_000);
    }

    // P1-A05 — resource scope: dedupe + fail on unknown site codes (the
    // creator is an admin with a global view; a typo must not silently
    // grant nothing or widen anything).
    let siteScopeJson: string | null = null;
    if (parsed.data.siteCodes !== undefined) {
      const codes = Array.from(new Set(parsed.data.siteCodes));
      if (codes.length > 0) {
        const sites = await db.site.findMany({
          where: { code: { in: codes } },
          select: { code: true },
        });
        const known = new Set(sites.map((site) => site.code));
        const unknown = codes.filter((code) => !known.has(code));
        if (unknown.length > 0) {
          return fail(
            "SITE_CODE_INVALID",
            `Unknown site code(s): ${unknown.join(", ")}`,
            400
          );
        }
      }
      siteScopeJson = JSON.stringify(codes); // [] preserved = deny-all
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const tokenPrefix = token.slice(0, 8);

    const correlationId = newCorrelationId("AXC");
    // Wave-9 (audit 9-a F-2): the create and its API_CLIENT_CREATED audit
    // row commit together — a row without its audit entry (or the reverse)
    // can no longer be observed.
    const row = await db.$transaction(async (tx) => {
      const created = await tx.apiClient.create({
        data: {
          name: parsed.data.name,
          tokenHash,
          tokenPrefix,
          scopesJson: JSON.stringify(scopes),
          isActive: parsed.data.isActive ?? true,
          expiresAt,
          siteScopeJson,
          createdBy: actor.id,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "API_CLIENT_CREATED",
          resourceType: "ApiClient",
          resourceId: created.id,
          resourceLabel: created.name,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            name: created.name,
            scopes,
            tokenPrefix,
            isActive: created.isActive,
            expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
            siteScopeJson: created.siteScopeJson,
          }),
        },
      });
      return created;
    });

    return ok(
      {
        client: clientView(row),
        // Shown exactly once — only the sha256 hash is stored server-side.
        token,
        audit: { correlationId },
      },
      { correlationId },
      201
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
