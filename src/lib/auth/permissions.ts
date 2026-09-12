/**
 * Pure permission primitives (Phase 19-C / audit AUTHZ-101).
 *
 * The seeded Role.permissionsJson arrays become the AUTHORITATIVE mutation
 * policy: every mutating API route resolves the session user and checks the
 * permission here (session.ts wraps this with DB lookups + 401/403 errors).
 * This module is deliberately PURE (no Prisma, no next-auth) so the matcher
 * and the approval policy can be unit-tested directly (tests/auth/*).
 *
 * Pattern semantics (matches the seeded matrix):
 *   "*"        — wildcard: every permission (admin)
 *   "*.read"   — trailing-segment wildcard: any permission ending ".read"
 *   "x.y"      — exact key
 */

/** Approval levels the change workflow can require (ChangeApproval.level). */
export const APPROVAL_LEVELS = ["TECHNICAL", "SECURITY", "MANAGER", "CAB"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

/**
 * Level → permission mapping (audit AUTHZ-101A §6.1): deciding an approval
 * level requires the matching fine-grained permission IN ADDITION to the
 * coarse "change.approve" gate.
 *
 * Seeded posture:
 *   manager  → change.approve + technical + manager + cab
 *   admin    → "*" (covers every level incl. security)
 *   engineer/operator/viewer/auditor → no approve permissions
 *
 * "SECURITY" is intentionally reachable only through the admin wildcard
 * until a dedicated security-officer role exists (audit acceptance test:
 * "one manager cannot fake SECURITY approval").
 */
export const APPROVAL_LEVEL_PERMISSIONS: Record<ApprovalLevel, string> = {
  TECHNICAL: "change.approve.technical",
  SECURITY: "change.approve.security",
  MANAGER: "change.approve.manager",
  CAB: "change.approve.cab",
};

/** Coarse gate every approver must hold before the level check. */
export const APPROVE_GATE_PERMISSION = "change.approve";

/** Permission for queueing an approved/scheduled change onto the engine. */
export const CHANGE_EXECUTE_PERMISSION = "change.execute";

/** Permission for requesting an emergency configuration restore. */
export const CONFIG_RESTORE_PERMISSION = "config.restore";

/**
 * Authoritative matcher for one permission against one role's pattern list.
 * Order-independent, allocation-free, and shared by the server check
 * (session.ts), the seed matrix (role-matrix.ts) and the client-side UI
 * gating (lib/permissions-client.ts) so all three can never drift.
 */
export function roleHasPermission(permissions: string[], permission: string): boolean {
  if (permissions.length === 0) return false;
  return permissions.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) return permission.endsWith(pattern.slice(1));
    return pattern === permission;
  });
}

/**
 * True when the principal may decide the given approval level: holds the
 * coarse approve gate AND the level-specific entitlement.
 */
export function mayApproveLevel(permissions: string[], level: ApprovalLevel): boolean {
  return (
    roleHasPermission(permissions, APPROVE_GATE_PERMISSION) &&
    roleHasPermission(permissions, APPROVAL_LEVEL_PERMISSIONS[level])
  );
}

/**
 * True when the principal holds the admin wildcard ("*") — the only policy
 * exception allowed to decide multiple distinct approval levels on one
 * change (multi-level separation of duties; audit acceptance test:
 * "same principal cannot satisfy multiple independent approval levels
 * unless policy explicitly allows it").
 */
export function isWildcardHolder(permissions: string[]): boolean {
  return permissions.includes("*");
}
