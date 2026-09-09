import { db } from "@/lib/db";
import type { User } from "@prisma/client";

/**
 * Demo acting-user resolution (Task 4-b).
 *
 * The platform ships without a login wall (ADR-04 — full NextAuth lands in
 * Phase 7). Until then, mutating endpoints that need an identity accept
 * `actAsUserId` — a seeded user id ("usr-admin") or username key ("admin",
 * the email prefix exposed by /api/v1/meta). The UI's Act-as selector feeds
 * this; the server is always authoritative.
 */

/** Risk levels where the requester may never approve their own change. */
export const SOD_GATED_RISK_LEVELS: readonly string[] = ["HIGH", "CRITICAL"];

/**
 * Resolve the acting user by id or username key. Falls back to the seeded
 * admin account when no explicit identity is supplied (demo default),
 * matching the 4-a requester convention.
 */
export async function resolveActingUser(
  actAsUserId?: string | null
): Promise<User | null> {
  const key = actAsUserId?.trim();
  if (!key) {
    return db.user.findFirst({
      where: { isActive: true, email: { startsWith: "admin@" } },
      orderBy: { createdAt: "asc" },
    });
  }

  const byId = await db.user.findFirst({
    where: { isActive: true, id: key },
  });
  if (byId) return byId;

  // Username key = email prefix (meta exposes "admin", "manager1", …).
  return db.user.findFirst({
    where: {
      isActive: true,
      email: { startsWith: `${key.toLowerCase()}@` },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Separation of duties: the requester cannot decide on their own
 * HIGH/CRITICAL change. MEDIUM/LOW self-approval is allowed (flagged in
 * the response as `selfApproval: true` by the caller).
 */
export function isSodViolation(
  riskLevel: string,
  requesterId: string,
  actorId: string
): boolean {
  return SOD_GATED_RISK_LEVELS.includes(riskLevel) && actorId === requesterId;
}
