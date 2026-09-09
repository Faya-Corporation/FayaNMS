import { db } from "@/lib/db";
import type { User } from "@prisma/client";

import { requireUser } from "@/lib/auth/session";

/**
 * Server-authoritative actor resolution (Phase 19 / audit SEC-001).
 *
 * HISTORY: this helper once accepted a client-supplied `actAsUserId`
 * (id or username key) and defaulted to the seeded admin account when the
 * value was absent — a demo-era identity model that let any authenticated
 * caller choose whose name appeared on approvals, executions and audit rows,
 * defeating separation of duties and evidence integrity.
 *
 * INVARIANT (see docs/design-governance.md and README):
 *   "No business route may synthesize, default, impersonate, or guess a
 *    human actor. The client never chooses the actor."
 *
 * The acting user is now ALWAYS the authenticated request principal,
 * re-verified against the database (active account required) via
 * requireUser(). Client-supplied identity fields are ignored everywhere;
 * has been removed from production request DTOs.
 */

/** Risk levels where the requester may never approve their own change. */
export const SOD_GATED_RISK_LEVELS: readonly string[] = ["HIGH", "CRITICAL"];

/**
 * Resolve the acting user for a business operation: the authenticated
 * principal of the request, re-verified against the database (active account
 * required). Returns null when the session is absent or the account is no
 * longer active — callers respond 401 UNAUTHENTICATED (never a synthesized
 * identity, never the seeded admin).
 */
export async function resolveActingUser(req: Request): Promise<User | null> {
  try {
    return await requireUser(req);
  } catch {
    // Dead/absent session — no actor can be derived from the request.
    return null;
  }
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
