import { getToken } from "next-auth/jwt";
import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import { fail } from "@/app/api/v1/_lib/api";

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
  const token = await getToken({
    req: req as Parameters<typeof getToken>[0]["req"],
    secret: process.env.NEXTAUTH_SECRET,
  });
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
 * Permission check against the role's seeded permissionsJson matrix
 * (P19 / audit SEC-005 + AUTH-001 — the permission arrays become
 * authoritative for the sensitive paths that call this helper).
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
  const role = await db.role.findUnique({ where: { name: user.role } });
  let permissions: string[] = [];
  try {
    permissions = role?.permissionsJson
      ? (JSON.parse(role.permissionsJson) as string[])
      : [];
  } catch {
    permissions = [];
  }
  const holds = permissions.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) return permission.endsWith(pattern.slice(1));
    return pattern === permission;
  });
  if (!holds) {
    throw new AuthError(
      "RBAC_FORBIDDEN",
      `This action requires the "${permission}" permission, which the "${user.role}" role does not hold.`,
      403
    );
  }
  return user;
}
