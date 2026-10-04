import { getToken } from "next-auth/jwt";
import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import { fail } from "@/app/api/v1/_lib/api";
import { authenticateApiClient, authenticateApiClientRead } from "@/lib/auth/api-client-auth";
import {
  assertSiteScope,
  SiteScopeDeniedError,
} from "@/lib/auth/scope";
import {
  APPROVAL_LEVEL_PERMISSIONS,
  APPROVE_GATE_PERMISSION,
  isWildcardHolder,
  mayApproveLevel,
  roleHasPermission,
  type ApprovalLevel,
} from "@/lib/auth/permissions";

/**
 * Server-side session helpers (Task 7-a).
 *
 * Route handlers call `requireUser(req)` / `requireRole(req, …roles)` at the
 * top and catch `AuthError` → the standard `_lib` error envelope
 * ({ success:false, error:{ code, message } } via fail()).
 *
 * Identity source: the next-auth JWT (cookie `next-auth.session-token`),
 * decoded with getToken from "next-auth/jwt". Claims are refreshed from the
 * User table by the jwt callback, and re-verified against the database here
 * so a mid-session deactivation answers 401 immediately.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /**
   * Raw `sites` JWT claim passthrough (F-031 resource-level scoping).
   * Typed `unknown` DELIBERATELY: a claim can be anything, and the
   * enforcement helpers in src/lib/auth/scope.ts classify it fail-closed
   * (absent → wildcard; empty/malformed → deny-all). Never read this
   * field directly in routes — go through sessionSiteScope()/assertSiteScope().
   */
  sites?: unknown;
}

/** Thrown by requireUser/requireRole — map with `authErrorToFail`. */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/** Convert an AuthError into the standard error-envelope NextResponse. */
export function authErrorToFail(error: unknown): ReturnType<typeof fail> | null {
  if (error instanceof AuthError) {
    return fail(error.code, error.message, error.status);
  }
  return null;
}

/**
 * Read the authenticated user's claims from the request's session token.
 * Returns null when the request carries no usable session (no token, or the
 * claims were stripped by a mid-session deactivation).
 */
export async function getSessionUser(
  req: Request & { cookies?: unknown }
): Promise<SessionUser | null> {
  // GHSA-xmf8-cvqr-rfgj (next-auth v4): getToken() throws an uncaught
  // exception on a malformed Bearer authorization header. The library fix
  // only lands in the v5 line; until that migration, the crash path is
  // neutralized here — malformed tokens degrade to "no session" (401).
  let token: Awaited<ReturnType<typeof getToken>> = null;
  try {
    token = await getToken({
      req: req as Parameters<typeof getToken>[0]["req"],
      secret: process.env.NEXTAUTH_SECRET,
    });
  } catch {
    return null;
  }
  if (!token) return null;
  const id = token.id;
  const email = token.email;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    email: typeof email === "string" ? email : "",
    name: typeof token.name === "string" ? token.name : null,
    role: typeof token.role === "string" ? token.role : "viewer",
    // F-031: raw claim passthrough — validated fail-closed downstream by
    // sessionSiteScope() (absent → wildcard; empty/malformed → deny-all).
    sites: token.sites,
  };
}

/**
 * Require an authenticated, still-active user. Returns the fresh database
 * record (useful for audit actor attribution) or throws:
 *   - 401 UNAUTHENTICATED — no/invalid session
 *   - 401 ACCOUNT_DISABLED — session exists but the account is now inactive
 */
export async function requireUser(req: Request): Promise<User> {
  const claims = await getSessionUser(req as never);
  if (!claims) {
    throw new AuthError(
      "UNAUTHENTICATED",
      "Sign in required — no valid session was provided.",
      401
    );
  }
  const user = await db.user.findUnique({ where: { id: claims.id } });
  if (!user || !user.isActive) {
    throw new AuthError(
      "ACCOUNT_DISABLED",
      "This account is no longer active.",
      401
    );
  }
  return user;
}

/**
 * Require the authenticated user to hold one of the given roles.
 * Throws 403 RBAC_FORBIDDEN when the role does not match.
 */
export async function requireRole(
  req: Request,
  ...roles: string[]
): Promise<User> {
  const user = await requireUser(req);
  if (roles.length > 0 && !roles.includes(user.role)) {
    throw new AuthError(
      "RBAC_FORBIDDEN",
      `This action requires one of: ${roles.join(", ")}.`,
      403
    );
  }
  return user;
}

/**
 * Handler-level read-plane authn (F-008 phase 1 — per-domain sweep).
 *
 * The ACTIVE control for reads under /api/v1 today is the proxy matcher
 * (src/proxy.ts, `/api/v1/:path*`) — a single point of failure for the
 * whole read plane (audit A1-01 / F-008, P2). This helper adds the
 * defense-in-depth SECOND layer: the read handler itself verifies the
 * session (getToken + active-user DB check), so a matcher regression, a
 * proxy bypass, or a future route mounted outside /api/v1 can no longer
 * silently publish operational reads.
 *
 * Fail-closed by construction:
 *   - no/invalid session                    → 401 UNAUTHENTICATED
 *   - session for a mid-flight deactivated  → 401 ACCOUNT_DISABLED
 *   - API-client bearer, wired domain +     → 200-series (the F-008
 *     scope grants the route permission      follow-up, batch-7: the read
 *                                           plane accepts ACTIVE ApiClient
 *                                           tokens via
 *                                           authenticateApiClientRead over
 *                                           API_CLIENT_READ_DOMAINS —
 *                                           precise 401/403 codes
 *                                           otherwise)
 *   - machine/service-JWT bearer            → 401 (NOT session tokens —
 *                                           getToken cannot verify them
 *                                           under NEXTAUTH_SECRET)
 *
 * Read handlers call this once at the top; the per-request WeakMap (keyed
 * by the Request object itself) dedupes any repeated calls within the same
 * request without retaining entries beyond the request's lifetime. The
 * rollout is per domain group (dashboard → events/alerts →
 * devices/interfaces → the rest), one PR per group; the read-route matrix
 * in tests/auth/authorization-contract.test.ts pins every ungated GET so
 * the sweep cannot silently stall.
 */
const readSessionCache = new WeakMap<object, Promise<User>>();

export function requireSessionRead(req: Request): Promise<User> {
  const cached = readSessionCache.get(req);
  if (cached) return cached;
  const pending = requireReadPrincipal(req);
  readSessionCache.set(req, pending);
  return pending;
}

/**
 * The requireSessionRead resolution body: a human session wins if present
 * (getToken + active-user DB re-verification); otherwise an API-client
 * bearer may authenticate through the wired read-domain table (batch-7);
 * everything else fails closed with the UNAUTHENTICATED envelope.
 */
async function requireReadPrincipal(req: Request): Promise<User> {
  const claims = await getSessionUser(req as never);
  if (claims) {
    const user = await db.user.findUnique({ where: { id: claims.id } });
    if (!user || !user.isActive) {
      throw new AuthError(
        "ACCOUNT_DISABLED",
        "This account is no longer active.",
        401
      );
    }
    return user;
  }

  // F-008 follow-up (batch-7): the API-client read plane. Runs ONLY when
  // no session resolved — a human request is never attributed to a client
  // principal. Unknown/garbage tokens resolve "unknown" and fall through
  // to the same fail-closed envelope as before batch-7.
  let pathname = "";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    // framework-provided req.url is always absolute — defensive only
  }
  const result = await authenticateApiClientRead(
    req.headers.get("authorization"),
    pathname
  );
  if (result.outcome === "principal") {
    return result.principal;
  }
  if (result.outcome === "rejected") {
    throw new AuthError(result.code, result.message, result.status);
  }
  throw new AuthError(
    "UNAUTHENTICATED",
    "Sign in required — no valid session was provided.",
    401
  );
}

/* ───────── resource-level site scope (F-031) — requirePermission-family extension ───────── */

/**
 * Per-request cache of the session claims used for SCOPE resolution. Same
 * WeakMap pattern (and lifetime) as readSessionCache above: keyed by the
 * Request object, entries die with the request. This is deliberately a
 * SEPARATE cache — the F-008 read-gate internals are untouched.
 */
const scopeClaimsCache = new WeakMap<object, Promise<SessionUser | null>>();

/**
 * Resolve (and memoize per-request) the session claims a route needs for
 * resource-scope decisions. Pairs with requireSessionRead on scope-aware
 * routes: the read gate runs first (401/403 handling), then this feeds the
 * pure helpers in src/lib/auth/scope.ts.
 *
 * null claims mean the request authenticated on a NON-session plane (the
 * API-client opaque-bearer read plane) or never authenticated at all. Both
 * resolve WILDCARD downstream (sessionSiteScope(null) → wildcard): the
 * bearer plane stays unscoped by design for F-031, and a truly anonymous
 * request never reaches scope evaluation because the route's auth gate has
 * already answered 401.
 */
export function sessionScopeFor(req: Request): Promise<SessionUser | null> {
  const cached = scopeClaimsCache.get(req);
  if (cached) return cached;
  const pending = getSessionUser(req as never);
  scopeClaimsCache.set(req, pending);
  return pending;
}

/**
 * RequirePermission-family resource gate (F-031): the authenticated
 * session must hold the given site in its scope. Semantics (see
 * assertSiteScope in src/lib/auth/scope.ts):
 *
 *   - siteCode null → unscoped resource — bypasses site scoping (allowed);
 *   - wildcard session (no `sites` claim — the single-tenant default) → allowed;
 *   - sites-limited session holding the code → allowed;
 *   - otherwise → 403 SITE_SCOPE_FORBIDDEN.
 *
 * Routes that want 404-not-403 semantics on detail reads (anti
 * existence-leak) should NOT use this gate — compose the row-level
 * predicate (sessionAllowsSite) and answer the resource's ordinary
 * not-found envelope instead, as GET /api/v1/devices/[id] does.
 */
export async function requireSiteScope(
  req: Request,
  siteCode: string | null
): Promise<void> {
  const claims = await sessionScopeFor(req);
  try {
    assertSiteScope(claims, siteCode);
  } catch (error) {
    if (error instanceof SiteScopeDeniedError) {
      throw new AuthError(error.code, error.message, 403);
    }
    throw error;
  }
}

/**
 * Load the authoritative permission array for a role name from the DB.
 * Returns [] for unknown roles / unparsable JSON (fail closed).
 */
export async function loadRolePermissions(roleName: string): Promise<string[]> {
  const role = await db.role.findUnique({ where: { name: roleName } });
  try {
    return role?.permissionsJson
      ? (JSON.parse(role.permissionsJson) as string[])
      : [];
  } catch {
    return [];
  }
}

/**
 * Permission check against the role's seeded permissionsJson matrix
 * (P19 / audit SEC-005 + AUTH-001; Phase 19-C / audit AUTHZ-101 makes this
 * THE authoritative mutation gate — every mutating route calls it).
 *
 * Pattern semantics (matches the seeded matrix):
 *   "*"         — wildcard: every permission (admin)
 *   "*.read"    — trailing-segment wildcard: any permission ending ".read"
 *   "x.y"       — exact key
 *
 * Throws 403 RBAC_FORBIDDEN when the caller's role lacks the permission.
 */
export async function requirePermission(
  req: Request,
  permission: string,
  opts: { allowApiClients?: boolean } = {}
): Promise<User> {
  // P1-012 (API-client bearer plane) — FAIL-CLOSED OPT-IN: a Bearer header
  // that resolves to an ACTIVE ApiClient row authenticates ONLY when this
  // route explicitly opted in (opts.allowApiClients). The default refusal
  // guarantees no route ever unknowingly receives the synthetic client
  // identity (whose id is NOT a User row — writing it into a User-FK
  // column would crash or, worse, misattribute). Opting-in routes must
  // handle the client principal deliberately (see the acknowledge route
  // for the certified pattern: nullable FK stays null, the audit row
  // carries the client attribution).
  const authorization = req.headers.get("authorization");
  if (authorization && /^Bearer\s+\S+$/i.test(authorization)) {
    const result = await authenticateApiClient(authorization, permission);
    if (result.outcome === "principal") {
      if (!opts.allowApiClients) {
        throw new AuthError(
          "API_CLIENT_HUMAN_REQUIRED",
          `This operation requires human accountability — API-client tokens are not accepted on this route ("${permission}").`,
          403
        );
      }
      return result.principal;
    }
    if (result.outcome === "rejected") {
      throw new AuthError(result.code, result.message, result.status);
    }
  }

  const user = await requireUser(req);
  const permissions = await loadRolePermissions(user.role);
  if (!roleHasPermission(permissions, permission)) {
    throw new AuthError(
      "RBAC_FORBIDDEN",
      `This action requires the "${permission}" permission, which the "${user.role}" role does not hold.`,
      403
    );
  }
  return user;
}

/**
 * Approval entitlement (Phase 19-C / audit AUTHZ-101A): the caller must
 * hold the coarse "change.approve" gate AND the level-specific permission
 * (change.approve.technical|security|manager|cab) to decide that level.
 *
 * Throws:
 *   401 UNAUTHENTICATED / ACCOUNT_DISABLED — via requireUser
 *   403 RBAC_FORBIDDEN — coarse gate missing, or the role is not entitled
 *   to this level (message names the level so the UI can explain)
 */
export async function requireApprovalEntitlement(
  req: Request,
  level: ApprovalLevel
): Promise<User> {
  const user = await requireUser(req);
  const permissions = await loadRolePermissions(user.role);
  if (!roleHasPermission(permissions, APPROVE_GATE_PERMISSION)) {
    throw new AuthError(
      "RBAC_FORBIDDEN",
      `This action requires the "${APPROVE_GATE_PERMISSION}" permission, which the "${user.role}" role does not hold.`,
      403
    );
  }
  if (!mayApproveLevel(permissions, level)) {
    throw new AuthError(
      "RBAC_FORBIDDEN",
      `The "${user.role}" role is not entitled to decide ${level} approvals (requires "${APPROVAL_LEVEL_PERMISSIONS[level]}" ).`,
      403
    );
  }
  return user;
}

/** Admin wildcard check for the multi-level SoD guard (approvals route). */
export async function actorIsWildcard(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!user) return false;
  return isWildcardHolder(await loadRolePermissions(user.role));
}
