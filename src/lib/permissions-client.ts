"use client";

import { usePermissionsStore } from "@/stores/permissions";
import {
  APPROVAL_LEVEL_PERMISSIONS,
  APPROVE_GATE_PERMISSION,
  mayApproveLevel,
  roleHasPermission,
  type ApprovalLevel,
} from "@/lib/auth/permissions";

/**
 * Client-side permission selectors (Phase 19-C / audit AUTHZ-101).
 *
 * Purely a COURTESY gate: the UI hides/disables affordances the server
 * would 403 anyway. The authoritative checks live in
 * requirePermission/requireApprovalEntitlement (src/lib/auth/session.ts);
 * this module reuses the exact same matcher (lib/auth/permissions.ts) so
 * client and server can never disagree about who may act.
 */

/** May the signed-in role perform actions gated by `permission`? */
export function useCan(permission: string): boolean {
  return usePermissionsStore((state) =>
    state.hydrated ? roleHasPermission(state.permissions, permission) : false
  );
}

/**
 * May the signed-in role decide `level` approvals? Requires BOTH the
 * coarse change.approve gate and the level-specific entitlement.
 */
export function useCanApproveLevel(level: ApprovalLevel): boolean {
  return usePermissionsStore((state) =>
    state.hydrated ? mayApproveLevel(state.permissions, level) : false
  );
}

/** Non-hook variant for event handlers / non-component code. */
export function canApproveLevelSync(
  permissions: string[],
  level: ApprovalLevel
): boolean {
  return mayApproveLevel(permissions, level);
}

/** Exposed for the change-detail tooltips (why a level is not actionable). */
export { APPROVAL_LEVEL_PERMISSIONS, APPROVE_GATE_PERMISSION };
