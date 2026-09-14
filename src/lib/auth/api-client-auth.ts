import { createHash } from "node:crypto";
import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import { bearerTokenOf } from "@/lib/auth/service-jwt";
import { roleHasPermission } from "@/lib/auth/permissions";

/**
 * API-client bearer authentication (P1-012 — external ULTRA audit).
 *
 * The finding: ApiClient rows existed (name + sha256 tokenHash + scopes)
 * but "no route validates tokens yet" and `lastUsedAt` stayed null by
 * design — the feature was a dead UI. This module wires the plane:
 *
 *   - the token is an OPAQUE base64url string (32-byte, shown once at
 *     creation); authentication is a sha256 lookup against
 *     ApiClient.tokenHash — the plaintext is never stored anywhere;
 *   - an active client's SCOPES are mapped onto the route-permission
 *     vocabulary (the catalog's "devices.write" etc. vs the handlers'
 *     "device.write" etc.) through the explicit table below — the same
 *     roleHasPermission matcher the RBAC matrix uses, so one grant
 *     decision logic serves both planes;
 *   - a successful authentication returns a USER-SHAPED principal whose
 *     audit attribution is honest: id = the ApiClient row id (traceable),
 *     name = the client name, email = a documented synthetic address
 *     (`<tokenPrefix>@api-client.fayanms.invalid`) that exists only so
 *     existing audit writer code compiles unchanged;
 *   - `lastUsedAt` is stamped with a 60 s in-memory throttle — evidence
 *     without a write per request.
 *
 * PLANE BOUNDARIES (fail-closed by construction):
 *   - requireRole (admin surfaces, client management) never consults this
 *     module — API clients cannot manage API clients;
 *   - requireApprovalEntitlement / SoD stay human-only — an API client can
 *     never satisfy a human approval quorum (POL-001's two-person CAB);
 *   - READ routes are proxy-session-gated and do not consult this module —
 *     the `.read` catalog scopes are RESERVED until read routes grow
 *     handler-level gates (documented honest limitation);
 *   - the proxy passes opaque bearer candidates ONLY for mutations and
 *     rate-limits them like any external caller (no service-JWT exemption).
 */

/** The token shape minted by POST /admin/api-clients (32-byte base64url). */
export const API_CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

/**
 * Catalog scope → route-permission keys (explicit policy table — code, not
 * env). Both vocabularies are kept intentionally: scopes are a STABLE
 * external contract; route permissions evolve with the RBAC matrix.
 */
export const API_CLIENT_SCOPE_PERMISSIONS: Record<string, string[]> = {
  "devices.write": ["device.write", "cmdb.write", "maintenance.write"],
  "config.write": ["config.backup", "config.baseline", "config.restore", "config.download"],
  "changes.write": ["change.create", "change.cancel", "change.close", "change.execute"],
  "alerts.write": ["alert.ack", "alert.assign", "alert.suppress"],
  "incidents.write": ["incident.create"],
  "admin.write": [
    "admin.system",
    "admin.credential",
    "job.run",
    "report.schedule",
    "report.create",
    "ztp.provision",
    "firmware.execute",
  ],
  // Read scopes are catalog-reserved: no route consults them yet (see the
  // plane-boundaries note). Listed so the UI keeps offering the full set
  // and the mapping table documents their status explicitly.
  "devices.read": [],
  "config.read": [],
  "alerts.read": [],
  "incidents.read": [],
  "changes.read": [],
  "metrics.read": [],
  "admin.read": [],
};

/** Route permissions granted by a client's scope list for ONE permission. */
export function apiClientScopesGrant(scopes: string[], permission: string): boolean {
  const granted: string[] = [];
  for (const scope of scopes) {
    granted.push(...(API_CLIENT_SCOPE_PERMISSIONS[scope] ?? []));
  }
  return roleHasPermission(granted, permission);
}

/** sha256 of the bearer token — matches POST creation storage exactly. */
export function apiClientTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Audit attribution for a principal (P1-012): AuditEvent.actorId is a
 * NULLABLE User FK — a client principal is NOT a User row, so its audit
 * rows carry actorId = null, a descriptive actorName, and the client row
 * id inside the payload (viaApiClientId) for traceability. Human
 * principals are attributed exactly as before.
 */
export function auditAttribution(actor: Pick<User, "id" | "name" | "role">): {
  actorId: string | null;
  actorName: string;
  viaApiClientId: string | null;
} {
  if (actor.role === "api-client") {
    return {
      actorId: null,
      actorName: `api-client: ${actor.name ?? "unknown"}`,
      viaApiClientId: actor.id,
    };
  }
  return { actorId: actor.id, actorName: actor.name ?? "Unknown user", viaApiClientId: null };
}

/**
 * User-shaped principal for API-client callers. Fields:
 *   id   — the ApiClient row id; routes must NOT write it into User-FK
 *          columns (use auditAttribution() for audit rows: actorId null,
 *          viaApiClientId = this id in the payload);
 *   name — the client name (rendered in "api-client: <name>" attribution);
 *   email — SYNTHETIC (documented): the token prefix + api-client.invalid,
 *           never a real mailbox; exists because audit writer code renders
 *           `actor.name ?? actor.email` and the type demands a string.
 */
export function apiClientPrincipal(row: {
  id: string;
  name: string;
  tokenPrefix: string;
}): User {
  return {
    id: row.id,
    name: row.name,
    email: `${row.tokenPrefix}@api-client.fayanms.invalid`,
    role: "api-client",
    isActive: true,
    passwordHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as User;
}

/* ───────────── lastUsedAt stamping (60 s in-memory throttle) ───────────── */

const STAMP_THROTTLE_MS = 60_000;
const lastStampCache = new Map<string, number>();

/** Pure throttle decision — exported for pins. */
export function shouldStampLastUsed(
  cachedAt: number,
  rowLastUsedAt: Date | null,
  now: number
): boolean {
  if (rowLastUsedAt === null) return true; // never used — stamp immediately
  const sinceCached = now - cachedAt;
  return sinceCached >= STAMP_THROTTLE_MS;
}

async function stampLastUsed(clientId: string, rowLastUsedAt: Date | null): Promise<void> {
  const now = Date.now();
  const cachedAt = lastStampCache.get(clientId) ?? 0;
  if (!shouldStampLastUsed(cachedAt, rowLastUsedAt, now)) return;
  lastStampCache.set(clientId, now);
  try {
    await db.apiClient.update({
      where: { id: clientId },
      data: { lastUsedAt: new Date(now) },
    });
  } catch {
    // The stamp is advisory evidence — an update race must never fail the
    // authenticated request it accompanies.
  }
}

/* ───────────────────── the authentication result ───────────────────── */

export type ApiClientAuthResult =
  | { outcome: "principal"; principal: User }
  | { outcome: "rejected"; code: string; message: string; status: number }
  /** No ApiClient row matches the token — the caller may fall back to the
   *  session plane (a logged-in human experimenting with a garbage token
   *  keeps their own rights; the permission check still applies). */
  | { outcome: "unknown" };

/**
 * Authenticate an Authorization header as an API-client token against ONE
 * required route permission. Non-bearer headers resolve "unknown" instantly
 * (the caller's session path handles them).
 */
export async function authenticateApiClient(
  authorization: string | null,
  permission: string
): Promise<ApiClientAuthResult> {
  const token = bearerTokenOf(authorization);
  if (!token || !API_CLIENT_TOKEN_PATTERN.test(token)) {
    return { outcome: "unknown" };
  }

  const row = await db.apiClient.findUnique({
    where: { tokenHash: apiClientTokenHash(token) },
  });
  if (!row) return { outcome: "unknown" };

  if (!row.isActive) {
    return {
      outcome: "rejected",
      code: "API_CLIENT_INACTIVE",
      message: "This API client has been deactivated.",
      status: 401,
    };
  }

  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopesJson);
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    scopes = [];
  }
  if (!apiClientScopesGrant(scopes, permission)) {
    return {
      outcome: "rejected",
      code: "API_CLIENT_SCOPE_INSUFFICIENT",
      message: `This API client's scopes do not grant the "${permission}" permission.`,
      status: 403,
    };
  }

  await stampLastUsed(row.id, row.lastUsedAt);
  return { outcome: "principal", principal: apiClientPrincipal(row) };
}
