import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ANALYSIS_MAX_BYTES,
  DETECT_COMMANDS,
  EVIDENCE_LINE_MAX,
  EVIDENCE_MAX_LINES,
  EVIDENCE_MAX_TOTAL_BYTES,
  VENDOR_REGISTRY,
  getVendorHandler,
  isInformativeCliOutput,
  parseVendorFingerprint,
  type VendorFingerprint,
} from "../../mini-services/worker/vendor-fingerprint";

/**
 * R50.5 — vendor fingerprinting hardening (R50-T050..T054).
 *
 * Pinned here (and kept honest forever):
 *   - R50-T050: attribution is driven by a frozen per-vendor REGISTRY —
 *     every handler owns its display name, probe command, signature
 *     matchers (stable ids + structural/soft strength) and extractors;
 *   - R50-T051: device output is byte-bounded, ANSI-stripped and
 *     control-neutralized BEFORE matching, and evidence is capped per
 *     line, per count and in TOTAL bytes;
 *   - R50-T052: attributions carry DETERMINISTIC matchReasons (the exact
 *     matched signature ids, registry order) — `confidence` is derived
 *     from the same policy, never an opaque score;
 *   - R50-T053: realistic fixtures for Cisco IOS / IOS XE / NX-OS,
 *     FortiOS, Aruba AOS-CX, Junos, PAN-OS and generic SSH output;
 *   - R50-T054: NEGATIVE fixtures where vendor names appear only in
 *     banners, hostnames, descriptions or unrelated text — they must
 *     never attribute a vendor. The policy is deterministic and strict:
 *     ONLY structural (CLI-shaped) signatures attribute; soft name
 *     tokens never do, alone or in combination.
 */

const fixture = (name: string): string =>
  readFileSync(`tests/fixtures/detection/${name}`, "utf8");

/* ────────────── R50-T050 — the per-vendor registry ────────────── */

describe("R50-T050 — VENDOR_REGISTRY (per-vendor probe handlers)", () => {
  test("the registry is frozen and covers exactly the six non-generic families", () => {
    expect(Object.isFrozen(VENDOR_REGISTRY)).toBe(true);
    expect(VENDOR_REGISTRY.map((h) => h.vendorKey)).toEqual([
      "cisco",
      "fortinet",
      "hpe",
      "juniper",
      "palo",
      "sophos",
    ]);
  });

  test("every handler owns displayName, probeCommand, signatures + extractors", () => {
    for (const handler of VENDOR_REGISTRY) {
      expect(handler.displayName.length).toBeGreaterThan(0);
      expect(handler.probeCommand.length).toBeGreaterThan(0);
      expect(handler.signatures.length).toBeGreaterThan(0);
      expect(handler.model === undefined || handler.model.length > 0).toBe(true);
      expect(handler.osVersion === undefined || handler.osVersion.length > 0).toBe(true);
    }
  });

  test("attribution is reachable: ≥1 structural anchor per SSH-detectable family", () => {
    for (const handler of VENDOR_REGISTRY) {
      const structuralCount = handler.signatures.filter(
        (s) => s.strength === "structural",
      ).length;
      if (handler.vendorKey === "sophos") {
        // SFOS rides the WebAPI transport (CERT-006) BY DESIGN — SSH
        // detection answers generic for it, so ALL its tokens are soft.
        expect(structuralCount).toBe(0);
      } else {
        expect(structuralCount, `${handler.vendorKey} has no structural signature`).toBeGreaterThan(0);
      }
    }
  });

  test("signature ids are globally unique and well-formed", () => {
    const ids = VENDOR_REGISTRY.flatMap((h) => h.signatures.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
    }
  });

  test("every handler documents its probe command honestly", () => {
    for (const handler of VENDOR_REGISTRY) {
      if (handler.vendorKey === "sophos") {
        // SFOS rides the WebAPI transport (CERT-006) — the handler says so.
        expect(handler.probeCommand).toContain("WebAPI");
        expect(DETECT_COMMANDS).not.toContain(handler.probeCommand);
      } else {
        expect(DETECT_COMMANDS).toContain(handler.probeCommand);
      }
    }
  });

  test("getVendorHandler resolves registry members and refuses others", () => {
    expect(getVendorHandler("cisco")?.displayName).toBe("Cisco Systems");
    expect(getVendorHandler("sophos")?.vendorKey).toBe("sophos");
    expect(getVendorHandler("generic")).toBeNull();
    expect(getVendorHandler("bogus")).toBeNull();
  });

  test("R50-T050 — probe-chain informativeness: CLI rejections never stop the chain", () => {
    // The classic IOS invalid-command answer (exit 0 on many CLIs) is a
    // rejection, not a fingerprintable status output.
    expect(isInformativeCliOutput("% Invalid input detected at '^' marker.\n")).toBe(false);
    expect(isInformativeCliOutput("unknown command. Type ? for help\n")).toBe(false);
    expect(isInformativeCliOutput("syntax error, expecting <cr>\n")).toBe(false);
    expect(isInformativeCliOutput("^\n")).toBe(false);
    // FortiOS / PAN-OS rejection shapes (authentic persona answers).
    expect(isInformativeCliOutput("Command fail. Return code -3\n")).toBe(false);
    expect(isInformativeCliOutput("Unknown action 0\n")).toBe(false);
    expect(isInformativeCliOutput("")).toBe(false);
    expect(isInformativeCliOutput("   \r\n")).toBe(false);
    // Real status output is informative — even when it CONTAINS an error
    // line or the rejection text inside a longer answer.
    expect(isInformativeCliOutput("Cisco IOS Software, Version 17.09.04a\n")).toBe(true);
    expect(
      isInformativeCliOutput(
        "% Invalid input detected at '^' marker.\n"
          .repeat(30)
          .slice(0, 900),
      ),
    ).toBe(true);
    // Non-string / control-char-laden input is handled by the same
    // sanitizer the fingerprint uses (the param is `unknown` by design —
    // the worker never sends non-strings, but the filter never throws).
    expect(isInformativeCliOutput(null)).toBe(false);
    expect(isInformativeCliOutput(undefined)).toBe(false);
    expect(isInformativeCliOutput(42)).toBe(false);
    expect(isInformativeCliOutput("show\n\x1b[?25hversion\r\n")).toBe(true);
  });
});

/* ────────────── R50-T051 — evidence safety ────────────── */

describe("R50-T051 — bounded, sanitized evidence", () => {
  test("ANSI-colored output still attributes and evidence carries no escapes", () => {
    // Real terminals wrap status lines in color escapes; the signature
    // must survive sanitization and the evidence must be clean text.
    const esc = "\x1b";
    const colored = [
      `${esc}[36m${esc}[1mCisco IOS XE Software, Version 17.09.04a${esc}[0m`,
      `Plain line ${esc}]0;window title${esc}\\ trailing`,
      "cisco Catalyst 9300 (X86_64_LINUX_IOSD-UNIVERSALK9-M) processor with 4194304K bytes of memory.",
    ].join("\n");
    const fp = parseVendorFingerprint(colored);
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.confidence).toBe("high");
    expect(fp.osVersion).toBe("17.09.04a");
    for (const line of fp.evidence) {
      expect(line).not.toContain("\x1b");
      expect(line).not.toContain("\u0007");
    }
    expect(fp.evidence.some((l) => l.includes("Cisco IOS XE Software, Version 17.09.04a"))).toBe(true);
  });

  test("control characters are neutralized before matching and reporting", () => {
    // NUL/BEL/ESC stuffed mid-signature must not defeat attribution, and
    // the evidence must not carry them.
    const dirty = `Cisco IOS XE Soft\x00\x07\x1b[?25hware, Version 19.0.1\r\ncisco C8200 processor with 8G bytes of memory.\n`;
    const fp = parseVendorFingerprint(dirty);
    expect(fp.vendorKey).toBe("cisco");
    for (const line of fp.evidence) {
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)).toBe(false);
    }
  });

  test("evidence is capped per line and in TOTAL bytes", () => {
    // Twelve informative lines at ~150 bytes each: the COUNT cap (3)
    // binds first — 3 × 150 = 450 ≤ 512 total-bytes budget.
    const manyLines = Array.from(
      { length: 12 },
      (_, i) => `Cisco IOS XE Software marker-${i} ${"x".repeat(119)}`,
    ).join("\n");
    const capped = parseVendorFingerprint(manyLines);
    expect(capped.vendorKey).toBe("cisco");
    expect(capped.evidence.length).toBe(EVIDENCE_MAX_LINES);
    for (const line of capped.evidence) {
      expect(line.length).toBeLessThanOrEqual(EVIDENCE_LINE_MAX);
    }

    // Exactly-at-cap 200-byte lines: the TOTAL-BYTES cap binds before the
    // count — 3 × 200 > 512, so the third line is dropped.
    const fatLines = [
      `Cisco IOS XE Software, Version 17.09.04a ${"y".repeat(EVIDENCE_LINE_MAX - 41)}`,
      `Cisco IOS Software [Cupertino] ${"z".repeat(EVIDENCE_LINE_MAX - 30)}`,
      `Cisco IOS Software [Amsterdam] ${"w".repeat(EVIDENCE_LINE_MAX - 30)}`,
    ].join("\n");
    const fat = parseVendorFingerprint(fatLines);
    expect(fat.evidence.length).toBeLessThan(EVIDENCE_MAX_LINES);
    const totalBytes = fat.evidence.reduce(
      (sum, line) => sum + Buffer.byteLength(line, "utf8"),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(EVIDENCE_MAX_TOTAL_BYTES);
  });

  test("the analysis window is byte-bounded (adversarial giant inputs)", () => {
    // A signature line placed beyond the analysis bound is never seen —
    // the parser answers generic instead of scanning unbounded input.
    const padding = "filler line\n".repeat(Math.ceil(ANALYSIS_MAX_BYTES / 12) + 16);
    const beyond = `${padding}\nCisco IOS Software, Version 20.1.1\n`;
    expect(Buffer.byteLength(beyond, "utf8")).toBeGreaterThan(ANALYSIS_MAX_BYTES);
    const fp = parseVendorFingerprint(beyond);
    expect(fp.vendorKey).toBe("generic");
    // Within the bound, the same signature still attributes.
    const inside = `Cisco IOS Software, Version 20.1.1\n${"x".repeat(64)}`;
    expect(parseVendorFingerprint(inside).vendorKey).toBe("cisco");
  });
});

/* ────────────── R50-T052 — deterministic match reasons ────────────── */

describe("R50-T052 — matchReasons (deterministic, no opaque scoring)", () => {
  test("attribution names the exact matched signatures, in registry order", () => {
    const fp = parseVendorFingerprint(fixture("cisco-iosxe-show-version.txt"));
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.matchReasons).toEqual([
      "cisco.ios-xe-banner",
      "cisco.ios-banner",
      "cisco.chassis-memory",
      "cisco.vendor-name",
    ]);
  });

  test("`confidence` is DERIVED: attributed ⇒ high, generic ⇒ low", () => {
    const ios = parseVendorFingerprint(fixture("cisco-ios-show-version.txt"));
    expect(ios.confidence).toBe("high");
    expect(ios.matchReasons.length).toBeGreaterThan(0);
    const generic = parseVendorFingerprint(fixture("generic-unknown-cli.txt"));
    expect(generic.confidence).toBe("low");
    expect(generic.matchReasons).toEqual([]);
  });

  test("PAN-OS key:value output reports its structural anchors", () => {
    const fp = parseVendorFingerprint(fixture("panos-show-system-info.txt"));
    expect(fp.vendorKey).toBe("palo");
    expect(fp.matchReasons).toEqual([
      "palo.model-line",
      "palo.sw-version-line",
      "palo.model-token",
    ]);
  });

  test("the same input always yields the same reasons (determinism)", () => {
    const output = fixture("junos-show-version.txt");
    const a: VendorFingerprint = parseVendorFingerprint(output);
    const b: VendorFingerprint = parseVendorFingerprint(output);
    expect(a.matchReasons).toEqual(b.matchReasons);
    expect(a.vendorKey).toBe(b.vendorKey);
    expect(a.model).toBe(b.model);
    expect(a.osVersion).toBe(b.osVersion);
  });
});

/* ────────────── R50-T053 — realistic fixtures ────────────── */

describe("R50-T053 — realistic CLI fixtures across certified families", () => {
  test("Cisco IOS 15 (Catalyst 2960X) → cisco", () => {
    const fp = parseVendorFingerprint(fixture("cisco-ios-show-version.txt"));
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.confidence).toBe("high");
    expect(fp.model).toBe("WS-C2960X-24TS-L");
    expect(fp.osVersion).toBe("15.2(4)E7");
    expect(fp.matchReasons).toContain("cisco.ios-banner");
    expect(fp.matchReasons).toContain("cisco.chassis-memory");
  });

  test("Cisco IOS XE 17 (Catalyst 8000V) → cisco", () => {
    const fp = parseVendorFingerprint(fixture("cisco-iosxe-show-version.txt"));
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.model).toContain("8000V");
    expect(fp.osVersion).toBe("17.09.04a");
  });

  test("Cisco NX-OS 9.3(5) → cisco", () => {
    const fp = parseVendorFingerprint(fixture("cisco-nxos-show-version.txt"));
    expect(fp.vendorKey).toBe("cisco");
    expect(fp.osVersion).toBe("9.3(5)");
    expect(fp.matchReasons).toContain("cisco.nxos-banner");
  });

  test("Fortinet FortiOS 7.2.4 (FortiGate-100F status) → fortinet", () => {
    const fp = parseVendorFingerprint(fixture("fortios-get-system-status.txt"));
    expect(fp.vendorKey).toBe("fortinet");
    expect(fp.model).toBe("FortiGate-100F");
    expect(fp.osVersion).toBe("7.2.4");
    expect(fp.matchReasons).toContain("fortinet.status-version");
    expect(fp.matchReasons).toContain("fortinet.chassis-token");
  });

  test("HPE Aruba AOS-CX (3810M) → hpe", () => {
    const fp = parseVendorFingerprint(fixture("aruba-aoscx-show-version.txt"));
    expect(fp.vendorKey).toBe("hpe");
    expect(fp.confidence).toBe("high");
    expect(fp.osVersion).toBe("GL.10.06.0001");
    expect(fp.matchReasons).toContain("hpe.aoscx-name");
  });

  test("Juniper Junos 21.3R1.7 (mx204) → juniper", () => {
    const fp = parseVendorFingerprint(fixture("junos-show-version.txt"));
    expect(fp.vendorKey).toBe("juniper");
    expect(fp.model).toBe("mx204");
    expect(fp.osVersion).toBe("21.3R1.7");
    expect(fp.matchReasons).toContain("juniper.junos-version-line");
    expect(fp.matchReasons).toContain("juniper.kernel-line");
  });

  test("Palo Alto PAN-OS 10.2.6 (PA-VM show system info) → palo", () => {
    const fp = parseVendorFingerprint(fixture("panos-show-system-info.txt"));
    expect(fp.vendorKey).toBe("palo");
    expect(fp.model).toBe("PA-VM");
    expect(fp.osVersion).toBe("10.2.6");
    expect(fp.matchReasons).toContain("palo.model-line");
    expect(fp.matchReasons).toContain("palo.sw-version-line");
  });

  test("generic unknown CLI (pfSense) → honest generic with evidence", () => {
    const fp = parseVendorFingerprint(fixture("generic-unknown-cli.txt"));
    expect(fp.vendorKey).toBe("generic");
    expect(fp.confidence).toBe("low");
    expect(fp.model).toBeNull();
    expect(fp.osVersion).toBeNull();
    expect(fp.evidence.length).toBeGreaterThan(0);
    expect(fp.softMatches).toBeUndefined();
  });
});

/* ────────────── R50-T054 — false-positive negatives ────────────── */

describe("R50-T054 — vendor names in banners/hostnames/text never attribute", () => {
  test("a MOTD banner naming several vendors stays generic, with near-misses", () => {
    const fp = parseVendorFingerprint(fixture("negative-banner-vendor-names.txt"));
    expect(fp.vendorKey).toBe("generic");
    expect(fp.confidence).toBe("low");
    expect(fp.matchReasons).toEqual([]);
    // The banner names four vendors via name tokens — every one of those
    // handlers was a NEAR-MISS, and none was claimed.
    expect(fp.softMatches).toEqual([
      "cisco.vendor-name",
      "fortinet.vendor-name",
      "juniper.vendor-name",
      "palo.vendor-name",
    ]);
  });

  test("vendor-shaped hostnames/prompts stay generic", () => {
    const fp = parseVendorFingerprint(fixture("negative-hostname-prompt.txt"));
    expect(fp.vendorKey).toBe("generic");
    expect(fp.softMatches).toEqual([
      "cisco.vendor-name",
      "juniper.model-token",
      "palo.model-token",
      "sophos.vendor-name",
    ]);
  });

  test("inventory/description text with vendor models stays generic", () => {
    const fp = parseVendorFingerprint(fixture("negative-asset-text.txt"));
    expect(fp.vendorKey).toBe("generic");
    // Rich near-miss list: chassis tokens, product names, image versions.
    expect(fp.softMatches).not.toHaveLength(0);
    for (const id of fp.softMatches ?? []) {
      const handler = getVendorHandler(id.split(".")[0]);
      expect(handler).not.toBeNull();
      expect(handler?.signatures.find((s) => s.id === id)?.strength).toBe("soft");
    }
    // The prose mentions BOTH FortiGate-100F and FortiOS 7.2.4 — even
    // together they never attribute fortinet (structural-only policy).
    expect(fp.softMatches).toContain("fortinet.chassis-token");
    expect(fp.softMatches).toContain("fortinet.fortios-name");
  });

  test("even MULTIPLE distinct soft tokens never attribute (structural-only)", () => {
    // Two name tokens on adjacent lines — a chassis + an image version —
    // would satisfy any "≥2 soft" scoring rule; the structural-only
    // policy refuses them all the same.
    const fp = parseVendorFingerprint(
      "FortiGate-100F kept as cold spare.\nFortiOS 7.2.4 image staged on TFTP.\n",
    );
    expect(fp.vendorKey).toBe("generic");
    expect(fp.softMatches).toContain("fortinet.chassis-token");
    expect(fp.softMatches).toContain("fortinet.fortios-name");
    expect(fp.matchReasons).toEqual([]);
  });

  test("login-failure text with NO vendor tokens stays generic without near-misses", () => {
    const fp = parseVendorFingerprint("Welcome.\n\nLogin failed: permission denied.\n");
    expect(fp.vendorKey).toBe("generic");
    expect(fp.softMatches).toBeUndefined();
  });

  test("single soft tokens are never enough (the classic banner sentences)", () => {
    expect(parseVendorFingerprint("Access governed by Fortinet security policy.").vendorKey).toBe("generic");
    expect(parseVendorFingerprint("PA-460 fw prompt logged out").vendorKey).toBe("generic");
    expect(parseVendorFingerprint("Juniper Networks device in rack 4.").vendorKey).toBe("generic");
    expect(parseVendorFingerprint("Sophos antivirus is installed on this host.").vendorKey).toBe("generic");
  });

  test("positive attribution still wins when names appear alongside structure", () => {
    // Real device output carries the vendor name in legit lines too —
    // attribution must not regress to generic when structure is present.
    const fp = parseVendorFingerprint(
      [
        "banner motd ^ Unauthorized access to this Juniper Networks device is prohibited ^",
        "Model: mx204",
        "Junos: 21.3R1.7",
        "JUNOS OS Kernel 64-bit [build]",
      ].join("\n"),
    );
    expect(fp.vendorKey).toBe("juniper");
    expect(fp.matchReasons).toContain("juniper.junos-version-line");
    expect(fp.matchReasons).toContain("juniper.kernel-line");
    expect(fp.softMatches).toBeUndefined();
  });
});
