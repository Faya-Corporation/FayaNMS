import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { ok, fail } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/auth/session — permission bootstrap (Task 7-a).
 *
 * Returns the current user (fresh from the database, not just the JWT) plus
 * the parsed permission array from Role.permissionsJson. This endpoint is
 * the FRONTEND permission source of truth (canWrite gate for the UI); the
 * middleware stays the coarse API gate.
 *
 * F-034 (batch-24): the response also carries `mfaEnabled` — whether the
 * caller's TOTP second factor is ACTIVE (an enabled UserMfa row). The UI
 * needs this to surface enrollment state; a pending (unconfirmed)
 * enrollment reports false, and FAYANMS_MFA_MODE=disabled bypasses the
 * factor at sign-in without changing this data-plane answer.
 *
 * 401 envelope when signed out — the caller (permissions store hydration)
 * treats that as "show the sign-in gate".
 */

function parsePermissions(permissionsJson: string | null): string[] {
  if (!permissionsJson) return [];
  try {
    const parsed: unknown = JSON.parse(permissionsJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const claims = await getSessionUser(request as never);
  if (!claims) {
    return fail(
      "UNAUTHENTICATED",
      "Sign in required — no active session.",
      401
    );
  }

  const user = await db.user.findUnique({
    where: { id: claims.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });

  if (!user || !user.isActive) {
    return fail(
      "ACCOUNT_DISABLED",
      "This account is no longer active — sign in again or contact an administrator.",
      401
    );
  }

  // F-034: second-factor state for the UI (only an ENABLED row counts —
  // a pending enrollment never challenges at sign-in).
  const mfa = await db.userMfa.findUnique({
    where: { userId: user.id },
    select: { enabled: true },
  });

  const role = await db.role.findUnique({
    where: { name: user.role },
    select: { name: true, description: true, permissionsJson: true },
  });

  const permissions = parsePermissions(role?.permissionsJson ?? null);

  return ok({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    },
    role: {
      name: role?.name ?? user.role,
      description: role?.description ?? null,
    },
    permissions,
    // F-034 (batch-24): TOTP second-factor state for the caller.
    mfaEnabled: mfa?.enabled === true,
    // UI write gate (Task 7-a; Phase 19-C): read-only roles (auditor,
    // viewer) and disabled accounts can never write — the server-side
    // permission gates remain the hard backstop.
    canWrite: !["auditor", "viewer"].includes(user.role) && user.isActive,
  });
}
