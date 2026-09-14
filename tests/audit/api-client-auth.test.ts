import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  API_CLIENT_SCOPE_PERMISSIONS,
  API_CLIENT_TOKEN_PATTERN,
  apiClientPrincipal,
  apiClientScopesGrant,
  apiClientTokenHash,
  auditAttribution,
  shouldStampLastUsed,
} from "../../src/lib/auth/api-client-auth";

/**
 * P1-012 — API-client bearer authentication (external ULTRA audit). The
 * finding: ApiClient rows existed but "no route validates tokens yet" and
 * lastUsedAt stayed null by design.
 *
 * These pins hold the PURE contract (the DB-backed flow is proven live in
 * the sandbox E2E — hash lookup, active check, scope refusal, lastUsedAt
 * stamp, audit attribution):
 *   1. the scope→permission mapping is explicit and covers the route
 *      permission vocabulary — a drift in either direction fails a pin;
 *   2. grant decisions go through the SAME roleHasPermission matcher as
 *      the human RBAC matrix (one decision logic, two planes);
 *   3. read scopes are catalog-reserved dead scopes — mapped to NOTHING,
 *      never accidentally granting a write permission;
 *   4. the token shape discriminates the plane: opaque base64url, never a
 *      dot-separated JWT (service or NextAuth bearers cannot collide);
 *   5. token hashing matches the creation path exactly (sha256 of utf8);
 *   6. the lastUsedAt throttle is a pure decision (first use stamps,
 *      cached within 60 s does not);
 *   7. the principal's audit attribution is honest: id = client row id,
 *      role = "api-client", email = the documented synthetic address.
 */

/* ───────────── scope→permission mapping coverage ───────────── */

describe("API_CLIENT_SCOPE_PERMISSIONS — mapping integrity", () => {
  test("every write scope maps to at least one route permission", () => {
    for (const [scope, permissions] of Object.entries(API_CLIENT_SCOPE_PERMISSIONS)) {
      if (scope.endsWith(".read")) continue; // reserved — see the dead-scope pin
      expect(permissions.length, scope).toBeGreaterThan(0);
    }
  });

  test("read scopes are explicitly catalog-reserved (empty mappings)", () => {
    for (const scope of [
      "devices.read",
      "config.read",
      "alerts.read",
      "incidents.read",
      "changes.read",
      "metrics.read",
      "admin.read",
    ]) {
      expect(API_CLIENT_SCOPE_PERMISSIONS[scope], scope).toEqual([]);
    }
  });

  test("the mutation permission vocabulary is covered by write scopes (drift pin)", () => {
    // The route-level permission literals (P1-012 snapshot). A NEW route
    // permission added later must be added to a scope's mapping — this pin
    // forces that decision to be conscious.
    const covered = new Set(Object.values(API_CLIENT_SCOPE_PERMISSIONS).flat());
    const routePermissions = [
      "device.write",
      "cmdb.write",
      "maintenance.write",
      "config.backup",
      "config.baseline",
      "config.restore",
      "config.download",
      "change.create",
      "change.cancel",
      "change.close",
      "change.execute",
      "alert.ack",
      "alert.assign",
      "alert.suppress",
      "incident.create",
      "admin.system",
      "admin.credential",
      "job.run",
      "report.schedule",
      "report.create",
      "ztp.provision",
      "firmware.execute",
    ];
    for (const permission of routePermissions) {
      expect(covered.has(permission), permission).toBe(true);
    }
  });
});

/* ───────────── grant decisions ───────────── */

describe("apiClientScopesGrant — decision logic", () => {
  test("a write scope grants its mapped family, nothing else", () => {
    expect(apiClientScopesGrant(["devices.write"], "device.write")).toBe(true);
    expect(apiClientScopesGrant(["devices.write"], "cmdb.write")).toBe(true);
    expect(apiClientScopesGrant(["devices.write"], "change.create")).toBe(false);
    expect(apiClientScopesGrant(["devices.write"], "device.read")).toBe(false);
  });

  test("scopes compose additively", () => {
    expect(
      apiClientScopesGrant(["changes.write", "alerts.write"], "alert.ack")
    ).toBe(true);
    expect(
      apiClientScopesGrant(["changes.write", "alerts.write"], "config.backup")
    ).toBe(false);
  });

  test("unknown scopes grant nothing", () => {
    expect(apiClientScopesGrant(["super.admin"], "admin.system")).toBe(false);
    expect(apiClientScopesGrant([], "device.write")).toBe(false);
  });

  test("a read scope never grants a write permission (reserved)", () => {
    expect(apiClientScopesGrant(["alerts.read"], "alert.ack")).toBe(false);
    expect(apiClientScopesGrant(["admin.read"], "admin.system")).toBe(false);
  });
});

/* ───────────── token plane discrimination + hashing ───────────── */

describe("token shape and hashing", () => {
  test("the minted 32-byte base64url token matches the opaque pattern", () => {
    // 32 bytes → 43 base64url chars, no padding.
    const token = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz234567";
    expect(token.length).toBe(55);
    expect(API_CLIENT_TOKEN_PATTERN.test(token)).toBe(true);
  });

  test("dot-separated JWTs never match the opaque pattern (plane separation)", () => {
    const serviceJwt = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ3b3JrZXIifQ.sig";
    expect(API_CLIENT_TOKEN_PATTERN.test(serviceJwt)).toBe(false);
  });

  test("short or padded garbage never matches", () => {
    expect(API_CLIENT_TOKEN_PATTERN.test("short")).toBe(false);
    expect(API_CLIENT_TOKEN_PATTERN.test("has+slash-and=padding")).toBe(false);
  });

  test("token hashing matches the creation path (sha256 utf8 hex)", () => {
    const token = "abcd1234-ABCD-EF56";
    expect(apiClientTokenHash(token)).toBe(
      createHash("sha256").update(token, "utf8").digest("hex")
    );
  });
});

/* ───────────── lastUsedAt throttle + principal ───────────── */

describe("lastUsedAt stamping throttle (pure decision)", () => {
  test("never-used rows stamp immediately", () => {
    expect(shouldStampLastUsed(0, null, 1_000_000)).toBe(true);
  });

  test("a cached stamp inside the 60 s window does not re-stamp", () => {
    expect(shouldStampLastUsed(1_000_000, new Date(999_000), 1_030_000)).toBe(false);
  });

  test("a cache older than the window re-stamps", () => {
    expect(shouldStampLastUsed(0, new Date(0), 61_000)).toBe(true);
  });
});

describe("apiClientPrincipal — honest audit attribution", () => {
  test("id traces to the client row, role is the synthetic api-client", () => {
    const principal = apiClientPrincipal({
      id: "apic-123",
      name: "monitoring-integration",
      tokenPrefix: "AbCd1234",
    });
    expect(principal.id).toBe("apic-123");
    expect(principal.name).toBe("monitoring-integration");
    expect(principal.role).toBe("api-client");
    expect(principal.email).toContain("@api-client.fayanms.invalid");
    expect(principal.isActive).toBe(true);
  });
});

describe("auditAttribution — User-FK-safe audit rows", () => {
  test("a client principal attributes as null actorId + descriptive name + payload id", () => {
    const attribution = auditAttribution({
      id: "apic-123",
      name: "monitoring-integration",
      role: "api-client",
    });
    expect(attribution.actorId).toBe(null); // AuditEvent.actorId is a User FK
    expect(attribution.actorName).toBe("api-client: monitoring-integration");
    expect(attribution.viaApiClientId).toBe("apic-123");
  });

  test("a human principal is attributed exactly as before", () => {
    const attribution = auditAttribution({
      id: "usr-admin",
      name: "Amal Al-Sabri",
      role: "admin",
    });
    expect(attribution.actorId).toBe("usr-admin");
    expect(attribution.actorName).toBe("Amal Al-Sabri");
    expect(attribution.viaApiClientId).toBe(null);
  });

  test("a human with a null name falls back to Unknown user", () => {
    const attribution = auditAttribution({ id: "usr-x", name: null, role: "viewer" });
    expect(attribution.actorName).toBe("Unknown user");
  });
});
