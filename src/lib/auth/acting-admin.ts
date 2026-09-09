import { requireRole } from "@/lib/auth/session";
import type { User } from "@prisma/client";

/**
 * Acting-admin resolution for the /api/v1/admin/* surface (Task 7-b).
 *
 * Phase 19-C (audit follow-up): the historical FALLBACK_ADMIN "operability"
 * fallback (unauthenticated callers were attributed to a synthetic admin
 * identity) is REMOVED — fail closed. The /api/v1 middleware already
 * rejects session-less requests with 401, so the fallback only ever masked
 * misconfiguration; a signed-in admin is attributed correctly and every
 * other case answers 401/403 through the standard envelope.
 */

export interface ActingAdmin {
  id: string | null;
  name: string;
  role: string;
}

/**
 * Resolve the acting admin for an admin-surface request: the session
 * holder with the admin role (RBAC_FORBIDDEN / ACCOUNT_DISABLED /
 * UNAUTHENTICATED all propagate as AuthErrors for the caller to map).
 */
export async function resolveAdminActor(
  req: Request
): Promise<{ actor: ActingAdmin; user: User | null }> {
  const user = await requireRole(req, "admin");
  return {
    actor: {
      id: user.id,
      name: user.name ?? user.email,
      role: user.role,
    },
    user,
  };
}
