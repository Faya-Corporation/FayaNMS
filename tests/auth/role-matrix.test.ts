import { describe, expect, test } from "bun:test";

import {
  APPROVAL_LEVEL_PERMISSIONS,
  isWildcardHolder,
  mayApproveLevel,
  roleHasPermission,
} from "../../src/lib/auth/permissions";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/**
 * Phase 19-C / audit AUTHZ-101 acceptance policy (P19C-AUTHZ-006):
 * the seeded role matrix is the AUTHORITATIVE mutation policy, so the
 * negative expectations from the audit's exit gate are pinned here:
 *   viewer cannot mutate; operator cannot create/approve/execute;
 *   engineer creates + executes but cannot approve; manager approves
 *   allowed levels but cannot create/execute; security level is admin-only.
 */

function role(name: string): string[] {
  const entry = ROLE_MATRIX.find((role) => role.name === name);
  if (!entry) throw new Error(`role ${name} missing from ROLE_MATRIX`);
  return entry.permissions;
}

describe("permission matcher semantics", () => {
  test("wildcard covers every permission", () => {
    expect(roleHasPermission(["*"], "change.execute")).toBe(true);
    expect(roleHasPermission(["*"], "anything.at.all")).toBe(true);
  });

  test("trailing wildcard *.read matches only read permissions", () => {
    const perms = ["*.read"];
    expect(roleHasPermission(perms, "device.read")).toBe(true);
    expect(roleHasPermission(perms, "report.read")).toBe(true);
    expect(roleHasPermission(perms, "device.write")).toBe(false);
    expect(roleHasPermission(perms, "read")).toBe(false);
  });

  test("exact keys match exactly", () => {
    expect(roleHasPermission(["change.create"], "change.create")).toBe(true);
    expect(roleHasPermission(["change.create"], "change.execute")).toBe(false);
    expect(roleHasPermission([], "change.create")).toBe(false);
  });
});

describe("audit exit gate — negative role expectations", () => {
  test("viewer cannot mutate anything", () => {
    const perms = role("viewer");
    for (const denied of [
      "change.create",
      "change.approve",
      "change.execute",
      "config.restore",
      "device.write",
      "incident.write",
      "alert.ack",
    ]) {
      expect(roleHasPermission(perms, denied)).toBe(false);
    }
  });

  test("auditor cannot mutate anything (defense in depth behind middleware)", () => {
    const perms = role("auditor");
    for (const denied of ["change.create", "change.approve", "change.execute", "config.restore"]) {
      expect(roleHasPermission(perms, denied)).toBe(false);
    }
  });

  test("operator can operate but cannot create/approve/execute", () => {
    const perms = role("operator");
    expect(roleHasPermission(perms, "alert.ack")).toBe(true);
    expect(roleHasPermission(perms, "config.restore")).toBe(true);
    expect(roleHasPermission(perms, "maintenance.write")).toBe(true);
    expect(roleHasPermission(perms, "change.create")).toBe(false);
    expect(roleHasPermission(perms, "change.approve")).toBe(false);
    expect(roleHasPermission(perms, "change.execute")).toBe(false);
  });

  test("engineer can create + execute but cannot approve by default", () => {
    const perms = role("engineer");
    expect(roleHasPermission(perms, "change.create")).toBe(true);
    expect(roleHasPermission(perms, "change.execute")).toBe(true);
    expect(roleHasPermission(perms, "config.restore")).toBe(true);
    expect(roleHasPermission(perms, "change.approve")).toBe(false);
    for (const level of ["TECHNICAL", "SECURITY", "MANAGER", "CAB"] as const) {
      expect(mayApproveLevel(perms, level)).toBe(false);
    }
  });

  test("manager can approve technical/manager/cab but NOT security", () => {
    const perms = role("manager");
    expect(roleHasPermission(perms, "change.approve")).toBe(true);
    expect(mayApproveLevel(perms, "TECHNICAL")).toBe(true);
    expect(mayApproveLevel(perms, "MANAGER")).toBe(true);
    expect(mayApproveLevel(perms, "CAB")).toBe(true);
    // Audit acceptance test: "one manager cannot fake SECURITY approval".
    expect(mayApproveLevel(perms, "SECURITY")).toBe(false);
    expect(roleHasPermission(perms, "change.execute")).toBe(false);
    expect(roleHasPermission(perms, "change.create")).toBe(false);
  });

  test("admin wildcard satisfies every approval level", () => {
    const perms = role("admin");
    for (const level of ["TECHNICAL", "SECURITY", "MANAGER", "CAB"] as const) {
      expect(mayApproveLevel(perms, level)).toBe(true);
    }
    expect(isWildcardHolder(perms)).toBe(true);
    expect(isWildcardHolder(role("manager"))).toBe(false);
  });

  test("level → permission mapping is complete and distinct", () => {
    expect(APPROVAL_LEVEL_PERMISSIONS.TECHNICAL).toBe("change.approve.technical");
    expect(APPROVAL_LEVEL_PERMISSIONS.SECURITY).toBe("change.approve.security");
    expect(APPROVAL_LEVEL_PERMISSIONS.MANAGER).toBe("change.approve.manager");
    expect(APPROVAL_LEVEL_PERMISSIONS.CAB).toBe("change.approve.cab");
  });
});

describe("matrix integrity", () => {
  test("every role entry is well-formed", () => {
    for (const entry of ROLE_MATRIX) {
      expect(entry.permissions.length).toBeGreaterThan(0);
      for (const permission of entry.permissions) {
        expect(permission.length).toBeGreaterThan(0);
      }
    }
  });

  test("no read-only role holds a write permission", () => {
    for (const name of ["viewer", "auditor"]) {
      const perms = role(name);
      for (const permission of perms) {
        expect(permission === "*.read" || permission.endsWith(".read") || permission === "audit.export").toBe(true);
      }
    }
  });
});
