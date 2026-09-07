import { AuthError, requireRole } from "@/lib/auth/session";
import type { User } from "@prisma/client";

/**
 * Acting-admin resolution for the /api/v1/admin/* surface (Task 7-b).
 *
 * TODO(7-a-integration): THIS FILE IS THE ONE PLACE to adjust when the auth
 * story changes. Today it delegates to Task 7-a's session helpers
 * (requireRole(req, "admin")) so a signed-in admin is attributed correctly;
 * the platform-admin fallback below keeps the governance surfaces operable
 * when no usable session exists yet (e.g. password hashes not seeded) or
 * when the middleware gate is disabled in a deployment. RBAC rejections and
 * disabled accounts are NEVER masked by the fallback — they rethrow so the
 * route maps them to the standard 403/401 envelope.
 */

export interface ActingAdmin {
  id: string | null;
  name: string;
  role: string;
}

/** Platform-admin fallback actor (documented Task 7-b contract). */
export const FALLBACK_ADMIN: ActingAdmin = {
  id: null,
  name: "admin@faya.local",
  role: "admin",
};

/**
 * Resolve the acting admin for an admin-surface request:
 *   - session holder with the admin role → attributed User,
 *   - UNAUTHENTICATED (401-class) → fallback actor (operability mode),
 *   - anything else (RBAC_FORBIDDEN, ACCOUNT_DISABLED) → rethrows AuthError.
 */
export async function resolveAdminActor(
  req: Request
): Promise<{ actor: ActingAdmin; user: User | null }> {
  try {
    const user = await requireRole(req, "admin");
    return {
      actor: {
        id: user.id,
        name: user.name ?? user.email,
        role: user.role,
      },
      user,
    };
  } catch (error) {
    if (error instanceof AuthError && error.code === "UNAUTHENTICATED") {
      return { actor: FALLBACK_ADMIN, user: null };
    }
    throw error;
  }
}
