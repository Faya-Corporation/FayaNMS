import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * R50 Phase R50.3 — management-address contract (R50-T030..T033).
 *
 * Fixes the open P1 R50-004: the resolver's A→AAAA fallback + IPv6-literal
 * passthrough could autofill a value the inventory contract (validated IPv4
 * on device create/update, the form sheet, and both CSV import surfaces)
 * ALWAYS rejects — a guaranteed submit error fed by the feature's own
 * success path.
 *
 * The T030 DECISION (docs/adr/ADR-management-address-policy.md): Device
 * management addresses are IPv4-ONLY. T031: no misleading AAAA success —
 * a typed IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED refusal instead. T033:
 * multi-address RRsets resolve deterministically (numeric-ascending pick)
 * so the inventory lands on the SAME address on every lookup regardless of
 * resolver RR rotation.
 */

import {
  IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED,
  resolveHostToIp,
  type HostResolutionMode,
} from "../../src/lib/dns/resolve-host";

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");
const RESOLVER = readFileSync("src/lib/dns/resolve-host.ts", "utf8");
const HOOK = readFileSync("src/hooks/api/use-devices.ts", "utf8");
const ADR = readFileSync("docs/adr/ADR-management-address-policy.md", "utf8");

/** Injectable fake for the A (IPv4) RRset query. */
type Resolve4Fn = (host: string) => Promise<string[]>;
/** Injectable fake for the diagnostic AAAA query. */
type Resolve6Fn = (host: string) => Promise<string[]>;

const noV6: Resolve6Fn = async () => [];

describe("R50-T031 — resolveHostToIp enforces the IPv4 management-address policy", () => {
  test("IPv4 literal passes through without touching DNS (unchanged contract)", async () => {
    let queries = 0;
    const r4: Resolve4Fn = async () => {
      queries += 1;
      return ["0.0.0.0"];
    };
    const result = await resolveHostToIp("10.20.255.1", r4, noV6);
    expect(result).toEqual({ mgmtIp: "10.20.255.1", mode: "ip-literal" });
    expect(queries).toBe(0);
  });

  test("empty host → typed failure (unchanged contract)", async () => {
    const result = await resolveHostToIp("   ");
    expect(result.mode).toBe("failed");
    expect(result.mgmtIp).toBeNull();
    expect(result.resolutionError).toBe("EMPTY_HOST");
  });

  test("an IPv6 literal target is REFUSED — never autofilled into the form", async () => {
    let queried = false;
    const r4: Resolve4Fn = async () => {
      queried = true;
      return ["10.0.0.1"];
    };
    const result = await resolveHostToIp("fd00::1", r4, noV6);
    expect(result.mgmtIp).toBeNull();
    expect(result.mode).toBe("refused-ipv6-literal");
    expect(result.resolutionError).toBe(IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED);
    expect(queried).toBe(false); // the policy refusal is pre-DNS
  });

  test("a hostname with an A record resolves via dns-a", async () => {
    const r4: Resolve4Fn = async (host) => {
      expect(host).toBe("hq-core-rtr-01");
      return ["10.20.255.9"];
    };
    const result = await resolveHostToIp("hq-core-rtr-01", r4, noV6);
    expect(result).toEqual({ mgmtIp: "10.20.255.9", mode: "dns-a" });
  });

  test("AAAA-ONLY hostname → typed IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED, mgmtIp null", async () => {
    // The old behavior returned { mgmtIp: "2001:db8::9", mode: "dns-aaaa" }
    // — the misleading success the audit flagged (R50-004): the form's
    // IPv4 validation would reject it on submit, guaranteed.
    const r4: Resolve4Fn = async () => {
      throw Object.assign(new Error("no A"), { code: "ENOTFOUND" });
    };
    const r6: Resolve6Fn = async () => ["2001:db8::9"];
    const result = await resolveHostToIp("v6-only.host", r4, r6);
    expect(result).toEqual({
      mgmtIp: null,
      mode: "refused-aaaa-only",
      resolutionError: IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED,
    });
  });

  test("a hostname with NEITHER A nor AAAA → failed with the A-query error code", async () => {
    const r4: Resolve4Fn = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    };
    let v6Queried = false;
    const r6: Resolve6Fn = async () => {
      v6Queried = true;
      return [];
    };
    const result = await resolveHostToIp("missing.invalid", r4, r6);
    expect(result.mode).toBe("failed");
    expect(result.mgmtIp).toBeNull();
    expect(result.resolutionError).toBe("ENOTFOUND");
    expect(v6Queried).toBe(true); // the AAAA probe is the honest diagnostic
  });

  test("total resolver failure is a typed RESULT, never a throw", async () => {
    const boom: Resolve4Fn = async () => {
      throw Object.assign(new Error("servfail"), { code: "EAI_AGAIN" });
    };
    const boom6: Resolve6Fn = async () => {
      throw Object.assign(new Error("servfail"), { code: "EAI_AGAIN" });
    };
    const result = await resolveHostToIp("flaky.host", boom, boom6);
    expect(result.mode).toBe("failed");
    expect(result.resolutionError).toBe("EAI_AGAIN");
  });
});

describe("R50-T033 — deterministic multi-address selection", () => {
  test("a multi-address A RRset picks the numeric-ASCENDING first — same answer every call", async () => {
    const r4: Resolve4Fn = async () => ["10.0.0.9", "10.0.0.2", "192.168.1.1", "10.0.0.20"];
    const first = await resolveHostToIp("rr.host", r4, noV6);
    expect(first).toEqual({ mgmtIp: "10.0.0.2", mode: "dns-a" });
    // Resolver rotation shuffles RRset order between queries; the policy
    // pick must NOT follow the shuffle.
    const shuffled: Resolve4Fn = async () => ["192.168.1.1", "10.0.0.20", "10.0.0.2", "10.0.0.9"];
    const second = await resolveHostToIp("rr.host", shuffled, noV6);
    expect(second.mgmtIp).toBe("10.0.0.2");
  });

  test("numeric compare is per-octet (10.0.0.2 < 10.0.0.20 < 10.0.1.2)", async () => {
    const r4: Resolve4Fn = async () => ["10.0.1.2", "10.0.0.20", "10.0.0.2"];
    const result = await resolveHostToIp("octet.host", r4, noV6);
    expect(result.mgmtIp).toBe("10.0.0.2");
  });

  test("an empty A answer (no records, no throw) → AAAA diagnostic, then honest failure", async () => {
    const empty4: Resolve4Fn = async () => [];
    const result = await resolveHostToIp("empty.host", empty4, noV6);
    expect(result.mode).toBe("failed");
    expect(result.resolutionError).toBe("EMPTY_ANSWER");
  });
});

describe("R50-T030/T031 — the policy is documented, typed, and pinned at every surface", () => {
  test("the T030 decision is recorded in an ADR", () => {
    expect(ADR).toContain("Management Address Support Policy");
    expect(ADR).toContain("IPv4-ONLY");
    expect(ADR).toContain("IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED");
    expect(ADR).toContain("numeric-ASCENDING");
  });

  test("the resolver exports the typed refusal code and has no AAAA-success path", () => {
    expect(RESOLVER).toContain('IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED = "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED"');
    // The old success modes are structurally gone from the mode union.
    const modes = RESOLVER.match(/export type HostResolutionMode = ([^;]+);/)?.[1] ?? "";
    expect(modes).not.toContain('"dns-aaaa"');
    // The AAAA probe exists ONLY as the diagnostic (never returns mgmtIp).
    expect(RESOLVER).toContain('"refused-aaaa-only"');
    expect(RESOLVER).toContain('"refused-ipv6-literal"');
  });

  test("the inventory contract stays IPv4 at every validated surface", () => {
    // The policy decision ALIGNS the resolver with these surfaces — they
    // must remain IPv4-validated (the audit's R50-004 mismatch is closed
    // from the resolver side, not by weakening the inventory). Each surface
    // either names IPV4_PATTERN or inlines the octet regex / the IPv4
    // validation message.
    for (const surface of [
      "src/app/api/v1/devices/route.ts",
      "src/app/api/v1/devices/[id]/route.ts",
      "src/app/api/v1/devices/csv-import/route.ts",
      "src/components/device/device-form-sheet.tsx",
      "src/components/device/csv-import-dialog.tsx",
    ] as const) {
      const src = readFileSync(surface, "utf8");
      const ipv4Enforced =
        src.includes("IPV4_PATTERN") ||
        src.includes("must be a valid IPv4 address") ||
        src.includes("Enter a valid IPv4 management address");
      expect(ipv4Enforced).toBe(true);
    }
  });

  test("the route surfaces the typed refusal (response + audit), detection unaffected", () => {
    // The response contract carries the resolution mode + typed error.
    expect(ROUTE).toContain("mgmtIpResolution");
    expect(ROUTE).toContain("resolutionError: resolution.resolutionError ?? null");
    // The audit event records the resolution outcome too (R50-T070 groundwork).
    expect(ROUTE).toContain("resolutionMode: resolution.mode");
    expect(ROUTE).toContain("resolutionError: resolution.resolutionError ?? null");
    // The detection stage is NOT gated on the address policy: an IPv6
    // target can still be fingerprinted — only the inventory mapping is
    // refused (the route keeps the vendor-first order).
    expect(ROUTE).toContain("await resolveHostToIp(requestedHost)");
  });

  test("the operator-facing toast names the IPv6 policy explicitly", () => {
    expect(HOOK).toContain("IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED");
    expect(HOOK).toContain("IPv4");
  });
});
