import { db } from "@/lib/db";
import { requireUser, authErrorToFail } from "@/lib/auth/session";
import { fail, ok } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/roles (Task 7-a) — role catalog for the users view.
 *
 * Returns every Role with its permissionsJson parsed into a real array plus
 * the number of users currently assigned to the role. Readable by any
 * active authenticated user (auditors get read-only visibility); mutations
 * don't exist in this phase.
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
  try {
    await requireUser(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const [roles, userGroups] = await Promise.all([
    db.role.findMany({ orderBy: { name: "asc" } }),
    db.user.groupBy({ by: ["role"], _count: { _all: true } }),
  ]);

  const countByRole = new Map<string, number>();
  for (const group of userGroups) {
    countByRole.set(group.role, group._count._all);
  }

  return ok(
    roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: parsePermissions(role.permissionsJson),
      userCount: countByRole.get(role.name) ?? 0,
    })),
    { total: roles.length }
  );
}

/** 405 for any other verb — this resource is read-only in 7-a. */
export function POST() {
  return fail("METHOD_NOT_ALLOWED", "Roles are read-only in this phase", 405);
}
