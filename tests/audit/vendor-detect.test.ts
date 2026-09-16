import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DETECT_COMMANDS,
  parseVendorFingerprint,
} from "../../mini-services/worker/vendor-fingerprint";
import { resolveHostToIp } from "../../src/lib/dns/resolve-host";
import { handle } from "../../mini-services/worker/index";
import { serviceAuthHeader } from "../../mini-services/worker/service-token";

/**
 * R50 — vendor auto-detection + hostname→management-IP mapping contract.
 *
 * Pinned here (and kept honest forever):
 *   - the fingerprint parser attributes realistic `show version` /
 *     `show system info` / `get system status` output to the certified
 *     vendor families, with best-effort model/OS extraction and BOUNDED
 *     evidence;
 *   - READ-ONLY discipline: DETECT_COMMANDS is a fixed list of read-only
 *     status commands, no mutation-shaped literal may ever enter the
 *     fingerprint module or the /live/detect-vendor worker surface;
 *   - SAFE-001 on the worker endpoint: the unpinned detection path is
 *     REFUSED unless the caller opts into the audited first-contact capture
 *     (enrollHostKey=true) — refused BEFORE any connection;
 *   - the API route is a form helper: it NEVER mutates the inventory,
 *     requires the data-plane permission, and degrades gracefully;
 *   - hostname→IP mapping is total (never throws) and injectable.
 */

const WORKER_INDEX = readFileSync("mini-services/worker/index.ts", "utf8");
const FINGERPRINT = readFileSync("mini-services/worker/vendor-fingerprint.ts", "utf8");
const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");

/** Mutation-shaped CLI literals that must NEVER enter the detection plane. */
const MUTATION_LITERALS =
  /\b(conf\s+t|configure\s+terminal|reload|write\s+(?:mem|memory|running)|copy\s+running|erase|reboot|delete|no\s+shutdown|shutdown)\b/i;

/* ────────────── vendor fingerprint parser ────────────── */

describe("R50 — parseVendorFingerprint fixtures", () => {
  test("Cisco IOS-XE (Catalyst 8000V) → cisco / high with model + OS", () => {
    const output = [
      "Cisco IOS XE Software, Version 17.09.04a",
      "Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a",
      "TECHNICAL SUPPORT: https://www.cisco.com/techsupport",
      "cisco Catalyst 8000V Edge Software (ciscoC8000V) processor (1)vcpus with 1764380K/6147K bytes of memory.",
      "Processor Board ID FLM2044W2FD",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.confidence).toBe("high");
    expect(fp.osVersion).toBe("17.09.04a");
    expect(fp.model).toContain("8000V");
    expect(fp.evidence.length).toBeGreaterThan(0);
    expect(fp.evidence.length).toBeLessThanOrEqual(3);
  });

  test("Cisco NX-OS → cisco", () => {
    const output = [
      "Cisco Nexus Operating System (NX-OS) Software",
      "TAC support: http://www.cisco.com/tac",
      "NX-OS Version 9.3(5)",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.osVersion).toBe("9.3(5)");
  });

  test("Fortinet FortiOS (get system status) → fortinet with model + version", () => {
    const output = [
      "FortiGate-100F v7.2.4",
      "Firmware Version: FortiOS v7.2.4",
      "Current Time: Thu Sep 17 09:00:00 2026",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("fortinet");
    expect(fp.confidence).toBe("high");
    expect(fp.model).toBe("FortiGate-100F");
    expect(fp.osVersion).toBe("7.2.4");
  });

  test("HPE Aruba AOS-CX → hpe with version", () => {
    const output = [
      "ArubaOS-CX (c8250)",
      "Version: GL.10.10.1030",
      "Aruba OS-CX Software Version GL.10.10.1030",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("hpe");
    expect(fp.confidence).toBe("high");
    expect(fp.osVersion).toBe("GL.10.10.1030");
  });

  test("Juniper Junos → juniper with model + version", () => {
    const output = [
      "Juniper Networks, Inc. mx204 internet router, kernel JUNOS 21.2R3.8, Build date: 2023-01-01",
      "Model: mx204",
      "JUNOS OS Kernel Release 21.2R3.8",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("juniper");
    expect(fp.confidence).toBe("high");
    expect(fp.model).toBe("mx204");
    expect(fp.osVersion).toBe("21.2R3.8");
  });

  test("Palo Alto PAN-OS (show system info) → palo with model + version", () => {
    const output = [
      "type: firewall",
      "family: 3000",
      "model: PA-VM",
      "serial: unknown",
      "sw-version: 10.2.6",
      "vm-license: none",
    ].join("\n");
    const fp = parseVendorFingerprint(output);
    expect(fp.vendorKey).toBe("palo");
    expect(fp.confidence).toBe("high");
    expect(fp.model).toBe("PA-VM");
    expect(fp.osVersion).toBe("10.2.6");
  });

  test("Palo Alto PAN-OS banner form → palo", () => {
    const fp = parseVendorFingerprint(
      "Palo Alto Networks PA-460 firewall, PAN-OS 11.1.2",
    );
    expect(fp.vendorKey).toBe("palo");
    expect(fp.model).toBe("PA-460");
    expect(fp.osVersion).toBe("11.1.2");
  });

  test("Sophos banner text → sophos (when the CLI answers at all)", () => {
    const fp = parseVendorFingerprint("Sophos Firewall SFOS 19.5.1 on XG 230");
    expect(fp.vendorKey).toBe("sophos");
    expect(fp.model).toBe("XG 230");
    expect(fp.osVersion).toBe("19.5.1");
  });

  test("unrecognized output → honest generic / low with bounded evidence", () => {
    const fp = parseVendorFingerprint("Welcome.\n\nLogin failed: permission denied.\n");
    expect(fp.vendorKey).toBe("generic");
    expect(fp.confidence).toBe("low");
    expect(fp.model).toBeNull();
    expect(fp.osVersion).toBeNull();
    expect(fp.evidence.length).toBeGreaterThan(0);
  });

  test("empty / non-string input → generic without throwing", () => {
    expect(parseVendorFingerprint("").vendorKey).toBe("generic");
    expect(parseVendorFingerprint("   \r\n").confidence).toBe("low");
    // @ts-expect-error — runtime hardening: the worker never sends non-strings
    expect(parseVendorFingerprint(null).vendorKey).toBe("generic");
  });
});

/* ────────────── read-only command discipline ────────────── */

describe("R50 — DETECT_COMMANDS read-only allowlist", () => {
  test("the command list is exactly the three read-only status probes", () => {
    expect(DETECT_COMMANDS).toEqual([
      "show version",
      "show system info",
      "get system status",
    ]);
  });

  test("every detection command is read-only (show/get prefix, no mutation)", () => {
    for (const command of DETECT_COMMANDS) {
      expect(command.startsWith("show ") || command.startsWith("get ")).toBe(true);
      expect(MUTATION_LITERALS.test(command)).toBe(false);
    }
  });

  test("no mutation-shaped literal ever enters the fingerprint module", () => {
    expect(MUTATION_LITERALS.test(FINGERPRINT)).toBe(false);
  });

  test("the /live/detect-vendor worker surface execs ONLY the allowlist", () => {
    const marker = 'url.pathname === "/live/detect-vendor"';
    const start = WORKER_INDEX.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = WORKER_INDEX.indexOf('"/live/apply"', start);
    const block = WORKER_INDEX.slice(start, end);
    // The endpoint exists on the real worker HTTP surface (control-token
    // gate covers /live/* — same token class as every other live plane).
    expect(block).toContain('url.pathname === "/live/detect-vendor"');
    // The ONLY exec call drains from the pinned allowlist variable.
    expect(block).toContain("for (const command of DETECT_COMMANDS)");
    expect(block).toContain("sshExecText(creds, command");
    // No raw command literal is ever exec'd inline in the handler.
    expect(block).not.toMatch(/sshExecText\(\s*creds\s*,\s*"/);
    // And the whole surface stays mutation-free.
    expect(MUTATION_LITERALS.test(block)).toBe(false);
  });
});

/* ────────────── SAFE-001 host-key policy on the worker endpoint ───── */

describe("R50 — /live/detect-vendor host-key policy (pre-connection refusals)", () => {
  const call = (payload: unknown): Promise<Response> =>
    handle(
      new Request("http://worker/live/detect-vendor", {
        method: "POST",
        headers: {
          authorization: serviceAuthHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

  test("missing host → 400 before anything else", async () => {
    const res = await call({ credential: { username: "u", port: 22, secretRef: "vault://x" } });
    expect(res.status).toBe(400);
  });

  test("missing credential block → 400 CREDENTIAL_REF_INVALID (no connection)", async () => {
    const res = await call({ host: "10.20.0.5" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("CREDENTIAL_REF_INVALID");
  });

  test("unpinned without enrollment opt-in → 400 SSH_HOSTKEY_UNENROLLED (fail-closed)", async () => {
    const res = await call({
      host: "10.20.0.5",
      credential: { username: "u", port: 22, secretRef: "vault://x" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("SSH_HOSTKEY_UNENROLLED");
  });

  test("malformed pin → 400 SSH_HOSTKEY_PIN_INVALID (validated before vault/SSH)", async () => {
    const res = await call({
      host: "10.20.0.5",
      credential: { username: "u", port: 22, secretRef: "vault://x" },
      sshHostKeyPin: "not-a-fingerprint",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("SSH_HOSTKEY_PIN_INVALID");
  });
});

/* ────────────── hostname → management-IP mapping ────────────── */

describe("R50 — resolveHostToIp (injectable, total)", () => {
  test("IPv4 literal passes through without touching DNS", async () => {
    let dnsCalls = 0;
    const probe = async (): Promise<{ address: string; family: number }> => {
      dnsCalls += 1;
      return { address: "0.0.0.0", family: 4 };
    };
    const result = await resolveHostToIp("10.20.255.1", probe);
    expect(result).toEqual({ mgmtIp: "10.20.255.1", mode: "ip-literal" });
    expect(dnsCalls).toBe(0);
  });

  test("IPv6 literal passes through", async () => {
    const result = await resolveHostToIp("fd00::1", async () => ({
      address: "x",
      family: 4,
    }));
    expect(result).toEqual({ mgmtIp: "fd00::1", mode: "ip-literal" });
  });

  test("hostname resolves via the A record", async () => {
    const seen: number[] = [];
    const result = await resolveHostToIp("hq-core-rtr-01", async (_host, opts) => {
      seen.push(opts.family);
      return { address: "10.20.255.9", family: opts.family };
    });
    expect(result).toEqual({ mgmtIp: "10.20.255.9", mode: "dns-a" });
    expect(seen).toEqual([4]);
  });

  test("A-record failure falls back to AAAA", async () => {
    const result = await resolveHostToIp("v6-only.host", async (_host, opts) => {
      if (opts.family === 4) {
        throw Object.assign(new Error("no A"), { code: "ENOTFOUND" });
      }
      return { address: "2001:db8::9", family: 6 };
    });
    expect(result).toEqual({ mgmtIp: "2001:db8::9", mode: "dns-aaaa" });
  });

  test("total resolution failure is a typed RESULT, never a throw", async () => {
    const result = await resolveHostToIp("missing.invalid", async () => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    });
    expect(result.mode).toBe("failed");
    expect(result.mgmtIp).toBeNull();
    expect(result.resolutionError).toBe("ENOTFOUND");
  });

  test("empty host → typed failure", async () => {
    const result = await resolveHostToIp("   ");
    expect(result.mode).toBe("failed");
    expect(result.resolutionError).toBe("EMPTY_HOST");
  });
});

/* ────────────── API route governance ────────────── */

describe("R50 — /api/v1/devices/auto-detect route contract", () => {
  test("data-plane permission + audited + worker-proxied", () => {
    expect(ROUTE).toContain('requirePermission(request, "config.backup")');
    expect(ROUTE).toContain("/live/detect-vendor");
    expect(ROUTE).toContain("resolveHostToIp(");
    expect(ROUTE).toContain("DEVICE_VENDOR_AUTODETECTED");
    // SAFE-001 / R50-T001: the trust state is resolved EXPLICITLY via the
    // trust-state resolver, and capture mode is opted into ONLY for a
    // PROVEN-unenrolled endpoint. (The original R50 pin asserted
    // `enrollHostKey: !pin` — the P0 fail-open literal itself; the
    // dedicated fail-closed matrix lives in r50-trust-failclosed.test.ts.)
    expect(ROUTE).toContain("resolveHostKeyTrustState(");
    expect(ROUTE).toContain('enrollHostKey: trust.state === "unenrolled"');
  });

  test("R50-T010 — vendor-FIRST orchestration: credential → trust → detection → DNS", () => {
    // The user-facing promise (README, form copy, verdict R50-002) is
    // vendor-first; the stage ORDER is executable contract now.
    const authIdx = ROUTE.indexOf('requirePermission(request, "config.backup")');
    const credIdx = ROUTE.indexOf("db.credentialProfile.findUnique");
    const trustIdx = ROUTE.indexOf("await resolveHostKeyTrustState(");
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    const dnsIdx = ROUTE.indexOf("await resolveHostToIp(requestedHost)");
    for (const [name, idx] of [
      ["auth", authIdx],
      ["credential", credIdx],
      ["trust", trustIdx],
      ["worker fetch", fetchIdx],
      ["dns resolution", dnsIdx],
    ] as const) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(authIdx).toBeLessThan(credIdx);
    expect(credIdx).toBeLessThan(trustIdx);
    expect(trustIdx).toBeLessThan(fetchIdx);
    expect(fetchIdx).toBeLessThan(dnsIdx);
  });

  test("R50-T013 — resolution is single-shot and never retargets the probe", () => {
    // Exactly ONE resolution call; it happens AFTER the worker fetch.
    expect(ROUTE.match(/await resolveHostToIp\(/g)?.length).toBe(1);
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    const dnsIdx = ROUTE.indexOf("await resolveHostToIp(");
    expect(dnsIdx).toBeGreaterThan(fetchIdx);
    // The worker dials the bound connection address (the requested
    // endpoint) — DNS output is never a fetch input.
    expect(ROUTE).toContain("host: connectionAddress");
  });

  test("R50-T011 — requestedHost / connectionAddress / resolvedManagementIp are explicit", () => {
    expect(ROUTE).toContain("const requestedHost = parsed.data.host;");
    expect(ROUTE).toContain("const connectionAddress = requestedHost;");
    expect(ROUTE).toContain("const resolvedManagementIp = resolution.mgmtIp;");
    // Response contract carries the three names explicitly (plus the
    // original fields for UI compatibility).
    expect(ROUTE).toContain("requestedHost,");
    expect(ROUTE).toContain("resolvedManagementIp,");
  });

  test("R50-T012 — trust identity is the requested endpoint (ADR), audit carries it", () => {
    // The trust lookup runs against the connection address BEFORE the fetch,
    // and the audit event records the host-key state + credential profile.
    const trustIdx = ROUTE.indexOf("await resolveHostKeyTrustState(");
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    expect(trustIdx).toBeGreaterThan(-1);
    expect(trustIdx).toBeLessThan(fetchIdx);
    expect(ROUTE).toContain("hostKeyState");
    expect(ROUTE).toContain("credentialProfileId: profile?.id ?? null");
  });

  test("the route NEVER mutates the device inventory (form helper)", () => {
    expect(ROUTE).not.toContain("db.device.create");
    expect(ROUTE).not.toContain("db.device.update");
    expect(ROUTE).not.toContain("db.device.delete");
  });
});
