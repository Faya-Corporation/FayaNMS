/// <reference types="bun-types" />
/**
 * Vendor auto-detection fingerprint (R50) — PURE module, zero imports.
 *
 * Given the text output of a read-only show command executed over the real
 * SSH transport, identify which certified vendor family the device belongs
 * to and best-effort extract model / OS version evidence.
 *
 * READ-ONLY DISCIPLINE (structural, test-pinned):
 *   - DETECT_COMMANDS is the COMPLETE set of commands the detection flow may
 *     ever execute. Every entry is a vendor's read-only status/show command;
 *     mutation-shaped command literals (the blocked list lives in
 *     tests/audit/vendor-detect.test.ts) must NEVER enter this file — the
 *     suite fails the build if they do (shared and lab devices are never
 *     mutated).
 *   - Coverage honesty: `show version` fingerprints Cisco IOS/IOS-XE/NX-OS/
 *     ASA, Juniper Junos and HPE Aruba AOS-CX; `show system info` is the
 *     Palo Alto PAN-OS status command; `get system status` is the Fortinet
 *     FortiOS status command. Sophos SFOS has no reliable read-only SSH
 *     status command BY DESIGN — that vendor rides the WebAPI transport
 *     (CERT-006) and SSH detection answers "generic" for it.
 */

export type DetectableVendorKey =
  | "cisco"
  | "fortinet"
  | "hpe"
  | "juniper"
  | "palo"
  | "sophos"
  | "generic";

/**
 * The one and only command list the /live/detect-vendor flow may execute.
 * Tried in order over the real SSH exec channel; the first command that
 * returns informative output wins (SSH_EXEC_FAILED on one candidate moves to
 * the next — connect-level failures abort immediately).
 */
export const DETECT_COMMANDS: readonly string[] = [
  "show version",
  "show system info",
  "get system status",
];

export interface VendorFingerprint {
  /** Certified vendor family the output was attributed to. */
  vendorKey: DetectableVendorKey;
  /** "high" = a vendor signature line matched; "low" = generic fallback. */
  confidence: "high" | "low";
  /** Best-effort chassis/model string from the output (null when absent). */
  model: string | null;
  /** Best-effort OS/firmware version string (null when absent). */
  osVersion: string | null;
  /** Up to 3 output lines that justified the attribution (bounded). */
  evidence: string[];
}

const EVIDENCE_MAX_LINES = 3;
const EVIDENCE_LINE_MAX = 200;

const trimEvidence = (lines: string[]): string[] =>
  lines
    .map((line) => line.trim().slice(0, EVIDENCE_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, EVIDENCE_MAX_LINES);

/** Collapse internal whitespace of an extracted token (CLI banners wrap). */
const cleanToken = (value: string): string | null =>
  value.replace(/\s+/g, " ").trim().slice(0, 60) || null;

interface VendorSignature {
  vendorKey: Exclude<DetectableVendorKey, "generic">;
  /** ANY of these matching an output line attributes the vendor. */
  signature: RegExp[];
  /** Ordered best-effort extractors (first match wins per slot). */
  model?: RegExp[];
  osVersion?: RegExp[];
}

const SIGNATURES: VendorSignature[] = [
  {
    vendorKey: "cisco",
    signature: [
      /Cisco IOS XE Software/i,
      /Cisco IOS Software/i,
      /Cisco Nexus Operating System/i,
      /NX-OS Version/i,
      /Cisco Adaptive Security Appliance/i,
      /Cisco Adaptive Security Virtual Appliance/i,
      /\bcisco\b.*bytes of memory/i,
    ],
    osVersion: [
      /Cisco IOS XE Software, Version\s+(\S+)/i,
      /Cisco IOS Software(?: \[[^\]]+\])?, Version\s+(\S+)/i,
      /Cisco IOS Software, Version\s+(\S+)/i,
      /NX-OS Version\s+(\S+)/i,
      /Adaptive Security Appliance Version\s+(\S+)/i,
    ],
    model: [
      // "cisco Catalyst 8000V Edge Software … processor …" / "cisco CSR1000V
      // (VXE) processor …" / "cisco ASR1001-X … bytes of memory" — up to two
      // tokens after "cisco" on the chassis line (tokens may start with digits).
      /\bcisco\s+([A-Za-z0-9][A-Za-z0-9-]*(?:\s+[A-Za-z0-9][A-Za-z0-9-]*)?)[^\n]*(?:processor|bytes of memory)/i,
      /\b(WS-C\S+|Nexus\s?\d+\S*|ASA\d{4}\S*)\b/i,
    ],
  },
  {
    vendorKey: "fortinet",
    signature: [
      /FortiOS/i,
      /FortiGate[- ]?\d/i,
      /\bFortinet\b/i,
    ],
    model: [
      /\b(FortiGate[- ]?\S+)\b/i,
      /\b(Forti[A-Z]\S+)\b/i,
    ],
    osVersion: [
      /FortiOS\s+v?(\d+\.\d+\.\d+)/i,
      /\bv(\d+\.\d+\.\d+)\b/,
    ],
  },
  {
    vendorKey: "hpe",
    signature: [
      /AOS-CX/i,
      /ArubaOS/i,
      /Aruba OS-CX/i,
      /ProCurve/i,
      /\bHPE\b.*\bswitch\b/i,
    ],
    osVersion: [
      /(?:AOS-CX|ArubaOS-CX)\s+(?:Software\s+)?Version\s+([A-Z]{2}\.\d+\.\d+(?:\.\d+)?)/i,
      /\b((?:GL|LL|FL|VB|KC|WC|YL)\.\d+\.\d+(?:\.\d+)?)\b/,
    ],
    model: [
      /(?:Aruba|HPE)\s+([A-Z]?\d{4}\S*)/i,
      /\((\S{2,20})\)[^\n]*(?:Switch|switch)/,
      /\b(\d{4}[A-Z]?\s+Switch\s+\S+)\b/i,
    ],
  },
  {
    vendorKey: "juniper",
    signature: [
      /Juniper Networks/i,
      /\bJUNOS\b/i,
      /\bJunos OS\b/i,
    ],
    model: [
      /^Model:\s*(\S+)/m,
      /\b(mx\d+|srx\d+\S*|qfx\d+\S*|ex\d+\S*|acx\d+\S*|vMX|vSRX)\b/i,
    ],
    osVersion: [
      /Junos:\s*(\S+)/,
      /JUNOS\s+(?:OS\s+)?(?:Kernel\s+Release\s+)?(\d+\.\d+[A-Z][\d.]+)\b/i,
    ],
  },
  {
    vendorKey: "palo",
    signature: [
      /Palo Alto Networks/i,
      /\bPAN-OS\b/i,
      // `show system info` never spells the vendor out — the chassis model
      // line ("model: PA-VM" / "PA-460") is itself the fingerprint.
      /\bPA-(?:VM|\d{3,4})\b/i,
    ],
    model: [
      /\b(PA-\d{3,4}|PA-VM|PA-4\d{2}\S*)\b/i,
    ],
    osVersion: [
      /\bPAN-OS\s+(\d+\.\d+\.\d+)/i,
      /\bversion:\s*(\d+\.\d+\.\d+)/im,
    ],
  },
  {
    vendorKey: "sophos",
    signature: [
      /\bSophos\b/i,
      /\bSFOS\b/i,
    ],
    model: [
      /\b(XG \d+|XGS \d+(?:w)?|SG \d+)\b/i,
    ],
    osVersion: [
      /\bSFOS\s+v?(\d+\.\d+\.\d+)/i,
    ],
  },
];

const GENERIC: VendorFingerprint = {
  vendorKey: "generic",
  confidence: "low",
  model: null,
  osVersion: null,
  evidence: [],
};

/**
 * Attribute CLI output to a certified vendor family. Never throws and never
 * returns null: unrecognized output answers the honest "generic / low"
 * fingerprint with the leading evidence lines so the operator can decide.
 */
export function parseVendorFingerprint(output: string): VendorFingerprint {
  const text = typeof output === "string" ? output : "";
  if (!text.trim()) return GENERIC;
  const lines = text.split(/\r?\n/);

  for (const sig of SIGNATURES) {
    const matched = lines.filter((line) => sig.signature.some((re) => re.test(line)));
    if (matched.length === 0) continue;

    const extract = (patterns?: RegExp[]): string | null => {
      if (!patterns) return null;
      for (const re of patterns) {
        const hit = text.match(re);
        if (hit && hit[1]) return cleanToken(hit[1]);
      }
      return null;
    };

    return {
      vendorKey: sig.vendorKey,
      confidence: "high",
      model: extract(sig.model),
      osVersion: extract(sig.osVersion),
      evidence: trimEvidence(matched),
    };
  }

  return { ...GENERIC, evidence: trimEvidence(lines) };
}
