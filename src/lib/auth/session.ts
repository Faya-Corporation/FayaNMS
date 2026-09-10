import { getToken } from "next-auth/jwt";
import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import { fail } from "@/app/api/v1/_lib/api";
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
  permission: string
): Promise<User> {
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
