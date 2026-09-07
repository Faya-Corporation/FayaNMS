/**
 * Identity constants (Task 7-a).
 *
 * The allowed User.role values mirror the schema comment (SQLite — no
 * enums): admin | operator | engineer | auditor | manager | viewer.
 */

export const USER_ROLES = [
  "admin",
  "operator",
  "engineer",
  "manager",
  "auditor",
  "viewer",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Roles that may never perform writes (enforced in middleware + UI). */
export const READ_ONLY_ROLES: readonly string[] = ["auditor"];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrator",
  operator: "NOC Operator",
  engineer: "Network Engineer",
  manager: "Service Manager",
  auditor: "Auditor",
  viewer: "Viewer",
};

/** Human permission-label for the users view (best-effort prettifier). */
export function permissionLabel(permission: string): string {
  return permission
    .split(".")
    .map((part) =>
      part === "*" ? "all" : part.replace(/([a-z])([A-Z])/g, "$1 $2")
    )
    .join(" · ");
}
