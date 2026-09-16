/**
 * Authoritative role → permission matrix (Phase 19-C / audit AUTHZ-101).
 *
 * SINGLE SOURCE OF TRUTH shared by:
 *   - prisma/seed.ts (fresh installs)
 *   - scripts/sync-role-permissions.ts (live-database sync — no wipe)
 *   - tests/auth/role-matrix.test.ts (policy regression tests)
 *
 * The server enforces these arrays through requirePermission() /
 * requireApprovalEntitlement() (src/lib/auth/session.ts). The UI mirrors
 * them client-side (lib/permissions-client.ts) as a courtesy only.
 *
 * Phase 19-C posture decisions (recorded for the authorization matrix doc):
 *   - admin keeps the "*" superuser wildcard;
 *   - change.execute → engineer only (admin via wildcard); managers and
 *     operators do NOT queue executions (audit §7.2);
 *   - config.restore → operator + engineer (emergency ops are NOC work;
 *     restore still creates an approval-gated change);
 *   - approval levels: manager = technical+manager+cab, security = admin
 *     wildcard only until a security-officer role exists;
 *   - change.cancel / change.close → operator + engineer + manager;
 *   - device.detect (R50-T020) → operator + engineer — the DEDICATED
 *     active-probe permission (vendor auto-detection); never the broad
 *     config.backup data-plane class;
 *   - cmdb.write → engineer; firmware.execute / ztp.provision → engineer;
 *   - report.create → operator+engineer+manager; report.schedule and
 *     report.export → manager;
 *   - alert.assign / incident.create / incident.close → operator + engineer
 *     (manager gains incident.close for sign-off);
 *   - admin.* keys are enforced as the admin ROLE gate (requireRole admin)
 *     and documented in docs/security/authorization-matrix.md.
 */

export interface RoleMatrixEntry {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

export const ROLE_MATRIX: RoleMatrixEntry[] = [
  {
    id: "role-admin",
    name: "admin",
    description: "Full platform administration",
    permissions: ["*"],
  },
  {
    id: "role-operator",
    name: "operator",
    description: "NOC operator — run operational actions, ack alerts, request restores",
    permissions: [
      "device.read",
      "device.detect",
      "config.read",
      "config.backup",
      "config.download",
      "config.restore",
      "alert.read",
      "alert.ack",
      "alert.assign",
      "alert.suppress",
      "incident.read",
      "incident.create",
      "incident.write",
      "incident.close",
      "change.read",
      "change.cancel",
      "change.close",
      "maintenance.read",
      "maintenance.write",
      "job.read",
      "job.run",
      "metrics.read",
      "report.read",
      "report.create",
    ],
  },
  {
    id: "role-engineer",
    name: "engineer",
    description: "Network engineer — device/config authoring, execute + restore",
    permissions: [
      "device.read",
      "device.write",
      "device.detect",
      "config.read",
      "config.write",
      "config.backup",
      "config.baseline",
      "config.download",
      "config.restore",
      "change.read",
      "change.create",
      "change.execute",
      "change.cancel",
      "change.close",
      "alert.read",
      "incident.read",
      "incident.create",
      "incident.write",
      "incident.close",
      "maintenance.read",
      "job.read",
      "job.run",
      "metrics.read",
      "firmware.execute",
      "ztp.provision",
      "cmdb.write",
      "report.read",
      "report.create",
    ],
  },
  {
    id: "role-manager",
    name: "manager",
    description: "Service manager — approvals (technical/manager/CAB) and reporting",
    permissions: [
      "device.read",
      "config.read",
      "config.download",
      "change.read",
      "change.approve",
      "change.approve.technical",
      "change.approve.manager",
      "change.approve.cab",
      "change.cancel",
      "change.close",
      "incident.read",
      "incident.close",
      "alert.read",
      "metrics.read",
      "report.read",
      "report.create",
      "report.schedule",
      "report.export",
    ],
  },
  {
    id: "role-auditor",
    name: "auditor",
    description: "Read-only + audit export (secrets masked)",
    permissions: ["*.read", "audit.export"],
  },
  {
    id: "role-viewer",
    name: "viewer",
    description: "Read-only dashboard access",
    permissions: ["*.read"],
  },
];

/** All permission keys referenced by production routes (matrix contract). */
export const KNOWN_PERMISSIONS: readonly string[] = Array.from(
  new Set(ROLE_MATRIX.flatMap((role) => role.permissions))
);
