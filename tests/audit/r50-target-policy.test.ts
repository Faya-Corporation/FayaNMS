import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { roleHasPermission } from "../../src/lib/auth/permissions";
import { evaluateTargetPolicy } from "../../src/lib/net/target-policy";

/**
 * R50 Phase R50.2 — authorization & abuse controls for ACTIVE probing.
 *
 *   R50-T020 — the detection route requires the DEDICATED `device.detect`
 *              permission (operator + engineer; admin via wildcard) — never
 *              again the broad config.backup data-plane class.
 *   R50-T022/T023 — the target network policy refuses loopback,
 *              cloud-metadata link-local, multicast, reserved and
 *              this-network literals BEFORE any credential/trust/network
 *              work, with a typed TARGET_NOT_ALLOWED refusal + a dedicated
 *              audit event; FAYANMS_PROBE_ALLOW_SPECIAL=true is the
 *              documented lab escape hatch.
 *   R50-T024 — detection-specific budgets over the SHARED rate store (the
 *              SCALE-001 store contract), keyed per actor AND per target;
 *              exhausted → typed DEVICE_PROBE_RATE_LIMITED 429 +
 *              Retry-After.
 *
 * Honest scope (recorded in the roadmap): actor→credential-profile→scope
 * authorization enrichment (R50-T021) and worker-side resolved-address
 * policy remain open; hostname literals intentionally pass the literal
 * policy (they carry no address semantics — ADR §3).
 */

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");

/* ── R50-T020 — dedicated probe permission ── */

describe("R50-T020 — device.detect permission", () => {
  test("operator and engineer carry device.detect; admin via wildcard", () => {
    const operator = ROLE_MATRIX.find((r) => r.id === "role-operator")!;
    const engineer = ROLE_MATRIX.find((r) => r.id === "role-engineer")!;
    expect(roleHasPermission(operator.permissions, "device.detect")).toBe(true);
    expect(roleHasPermission(engineer.permissions, "device.detect")).toBe(true);
  });

  test("manager does NOT gain the probe permission (NOC/engineering surface)", () => {
    const manager = ROLE_MATRIX.find((r) => r.id === "role-manager")!;
    expect(roleHasPermission(manager.permissions, "device.detect")).toBe(false);
  });

  test("the route requires device.detect — the broad config.backup class is gone", () => {
    expect(ROUTE).toContain('requirePermission(request, "device.detect")');
    expect(ROUTE).not.toContain('requirePermission(request, "config.backup")');
  });

  test("the operator and engineer role entries carry device.detect", () => {
    const operator = ROLE_MATRIX.find((r) => r.id === "role-operator")!;
    const engineer = ROLE_MATRIX.find((r) => r.id === "role-engineer")!;
    expect(operator.permissions).toContain("device.detect");
    expect(engineer.permissions).toContain("device.detect");
  });
});

/* ── R50-T022/T023 — target network policy ── */

describe("R50-T022/T023 — target network policy (literal classes)", () => {
  const original = process.env.FAYANMS_PROBE_ALLOW_SPECIAL;

  test("loopback, metadata link-local, multicast, reserved, this-network are DENIED", () => {
    const denied: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["127.8.8.8", "loopback"],
      ["169.254.169.254", "link-local"], // cloud metadata endpoint
      ["169.254.0.1", "link-local"],
      ["224.0.0.1", "multicast"],
      ["239.255.255.250", "multicast"],
      ["255.255.255.255", "reserved"],
      ["240.0.0.1", "reserved"],
      ["0.0.0.0", "this-network"],
      ["0.1.2.3", "this-network"],
    ];
    for (const [target, cls] of denied) {
      const decision = evaluateTargetPolicy(target);
      expect(decision.allowed).toBe(false);
      expect(decision.addressClass).toBe(cls);
      expect(decision.reason).toBe(cls);
    }
  });

  test("IPv6 special classes are DENIED (unspecified, loopback, link-local, multicast)", () => {
    // Scope: fe80::/10 link-local (cloud/metadata class), ff00::/8 multicast,
    // :: unspecified, ::1 loopback. fec0::/10 is DEPRECATED SITE-local, not
    // link-local — deliberately outside the literal-deny classes.
    const denied: Array<[string, string]> = [
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["febf::1", "link-local"],
      ["ff02::1", "multicast"],
    ];
    for (const [target, cls] of denied) {
      const decision = evaluateTargetPolicy(target);
      expect(decision.allowed).toBe(false);
      expect(decision.addressClass).toBe(cls);
    }
  });

  test("operational targets are ALLOWED (private, CGNAT, public, ULA, global v6)", () => {
    const allowed: Array<[string, string]> = [
      ["10.20.0.5", "private"],
      ["172.16.4.1", "private"],
      ["172.31.255.254", "private"],
      ["192.168.1.1", "private"],
      ["100.64.0.1", "cgnat"],
      ["203.0.113.10", "public"],
      ["8.8.8.8", "public"],
      ["fd00::5", "ipv6-global"], // ULA — operational management range
      ["2001:db8::10", "ipv6-global"],
    ];
    for (const [target, cls] of allowed) {
      const decision = evaluateTargetPolicy(target);
      expect(decision.allowed).toBe(true);
      expect(decision.addressClass).toBe(cls);
    }
  });

  test("IPv4-mapped IPv6 specials are classified through the embedded v4", () => {
    expect(evaluateTargetPolicy("::ffff:127.0.0.1").allowed).toBe(false);
    expect(evaluateTargetPolicy("::ffff:127.0.0.1").addressClass).toBe("loopback");
    expect(evaluateTargetPolicy("::ffff:10.0.0.5").allowed).toBe(true);
  });

  test("hostname literals pass the LITERAL policy (resolved-address policy is worker-side)", () => {
    const decision = evaluateTargetPolicy("hq-core-rtr-01");
    expect(decision.allowed).toBe(true);
    expect(decision.addressClass).toBe("hostname");
  });

  test("the lab escape hatch re-allows specials WITHOUT hiding their class", () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    try {
      const decision = evaluateTargetPolicy("127.0.0.1");
      expect(decision.allowed).toBe(true);
      expect(decision.addressClass).toBe("loopback");
      expect(decision.reason).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
      else process.env.FAYANMS_PROBE_ALLOW_SPECIAL = original;
    }
  });

  test("the route refuses denied targets BEFORE credentials/trust/network with a typed error + audit", () => {
    const policyIdx = ROUTE.indexOf("evaluateTargetPolicy(requestedHost)");
    const credIdx = ROUTE.indexOf("db.credentialProfile.findUnique");
    const trustIdx = ROUTE.indexOf("await resolveHostKeyTrustState(");
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(policyIdx).toBeLessThan(credIdx);
    expect(policyIdx).toBeLessThan(trustIdx);
    expect(policyIdx).toBeLessThan(fetchIdx);
    expect(ROUTE).toContain('"TARGET_NOT_ALLOWED"');
    expect(ROUTE).toContain('action: "DEVICE_PROBE_TARGET_REFUSED"');
  });

  test("the route enforces detection budgets over the SHARED store (actor + target)", () => {
    expect(ROUTE).toContain("getRateStore().hit(");
    expect(ROUTE).toContain("device-detect:actor:");
    expect(ROUTE).toContain("device-detect:target:");
    expect(ROUTE).toContain('"DEVICE_PROBE_RATE_LIMITED"');
    expect(ROUTE).toContain('retryAfterSec)');
    // The rate stage sits between the target policy and the credential stage.
    const rateIdx = ROUTE.indexOf("device-detect:actor:");
    const credIdx = ROUTE.indexOf("db.credentialProfile.findUnique");
    expect(rateIdx).toBeGreaterThan(-1);
    expect(rateIdx).toBeLessThan(credIdx);
  });
});
