/// <reference types="bun-types" />
/**
 * Vendor auto-detection fingerprint — R50.5 (R50-T050..T054). PURE module,
 * zero imports (Buffer is a runtime global in Bun/Node, not an import).
 *
 * Given the text output of a read-only show command executed over the real
 * SSH transport, identify which certified vendor family the device belongs
 * to and best-effort extract model / OS version evidence.
 *
 * R50-T050 — REGISTRY: attribution is driven by VENDOR_REGISTRY, a frozen,
 * ordered list of per-vendor probe handlers. Each handler owns its display
 * name, its probe command (which DETECT_COMMANDS entry it answers), its
 * signature matchers (each with a STABLE id + strength) and its ordered
 * model / OS-version extractors. Nothing about a vendor's fingerprinting
 * lives outside its handler.
 *
 * R50-T052 — MATCH REASONS: every attribution names the EXACT signature ids
 * that matched (matchReasons, in registry declaration order — deterministic,
 * stable across runs and releases). `confidence` is no longer an opaque
 * score: it is DERIVED from the same deterministic policy that attributed
 * the vendor ("high" ⇔ attributed, "low" ⇔ generic).
 *
 * R50-T054 — FALSE-POSITIVE POLICY (deterministic, no scoring): a vendor is
 * attributed ONLY by STRUCTURAL signatures — CLI-shaped product/version
 * anchors ("Cisco IOS Software", "NX-OS Version", "^model: PA-…",
 * "^Version: Forti…", "^Junos: …", "JUNOS OS …"). SOFT signatures are
 * vendor/model NAME tokens that also appear in MOTD banners, hostnames,
 * inventory descriptions and unrelated text; they NEVER attribute a vendor
 * on their own, no matter how many distinct ones match. A banner that
 * merely names vendors stays generic, with the near-miss ids reported in
 * `softMatches` so the operator sees why nothing was claimed.
 *
 * R50-T051 — EVIDENCE SAFETY: the analysis input is bounded (ANALYSIS_MAX_
 * BYTES), ANSI escape sequences (CSI/OSC) are stripped and C0 control
 * characters are neutralized BEFORE matching, and the returned evidence is
 * capped per line (EVIDENCE_LINE_MAX), per count (EVIDENCE_MAX_LINES) and
 * in TOTAL bytes (EVIDENCE_MAX_TOTAL_BYTES). No device output can blow up
 * the response, the audit trail or a browser UI.
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
 *     (CERT-006) and SSH detection answers "generic" for it (its handler
 *     documents exactly that; the probeCommand is NOT an SSH command).
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

/* ────────────── R50-T051 — evidence + analysis bounds ────────────── */

/** Adversarial-input bound: analysis never looks at more than 256 KiB. */
export const ANALYSIS_MAX_BYTES = 262_144;
/** Evidence caps: 3 lines × 200 chars, and 512 bytes across all lines. */
export const EVIDENCE_MAX_LINES = 3;
export const EVIDENCE_LINE_MAX = 200;
export const EVIDENCE_MAX_TOTAL_BYTES = 512;

/** ANSI CSI sequences (colors/cursor) and OSC sequences (window titles). */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** C0 controls except \t \n \r (the split whitespace), plus DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * R50-T051 — prepare untrusted device output for analysis: byte-bound it,
 * strip ANSI escapes, neutralize control characters. Sanitizing BEFORE
 * matching means escape sequences can neither spoof a signature line nor
 * hide one, and every extracted token / evidence line is clean text.
 */
const prepareOutput = (output: unknown): { text: string; lines: string[] } => {
  const raw = typeof output === "string" ? output : "";
  const bounded = Buffer.from(raw, "utf8")
    .subarray(0, ANALYSIS_MAX_BYTES)
    .toString("utf8");
  const text = bounded
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(CONTROL_CHARS, " ");
  return { text, lines: text.split(/\r?\n/) };
};

const trimEvidence = (lines: string[]): string[] => {
  const out: string[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    const clean = line.replace(/\s+/g, " ").trim().slice(0, EVIDENCE_LINE_MAX);
    if (!clean) continue;
    const bytes = Buffer.byteLength(clean, "utf8");
    if (totalBytes + bytes > EVIDENCE_MAX_TOTAL_BYTES) break;
    out.push(clean);
    totalBytes += bytes;
    if (out.length === EVIDENCE_MAX_LINES) break;
  }
  return out;
};

/**
 * CLI rejection shapes that mean "this CLI does not speak the command".
 * Real devices answer an unknown probe with a SHORT error line (exit 0 on
 * many CLIs) — treating that as informative output would stop the probe
 * chain before it reaches the command this CLI actually answers. Covered
 * shapes: Cisco ("% Invalid input detected"), Junos ("syntax error",
 * "unknown command"), FortiOS ("Command fail. Return code -3",
 * "Unknown action 0"), PAN-OS ("Unknown command"), and generic "invalid".
 */
const CLI_REJECTION_RE =
  /^\s*%|^\s*invalid\b|^\s*unrecognized\b|^\s*unknown (?:command|action)\b|^\s*command fail\b|^\s*syntax error\b|^\s*ambiguous command\b|^\s*incomplete command\b|^\s*error:\s|\^\s*$/i;

/**
 * R50-T050 — probe-chain informativeness filter. TRUE when the output is
 * plausibly a status answer worth fingerprinting; FALSE for empty output
 * and for SHORT, entirely-rejection answers ("% Invalid input detected…").
 * A long output that merely CONTAINS an error line is still informative.
 */
export function isInformativeCliOutput(output: unknown): boolean {
  const { text } = prepareOutput(output);
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length <= 256 && CLI_REJECTION_RE.test(trimmed)) return false;
  return true;
}

/** Collapse internal whitespace of an extracted token (CLI banners wrap). */
const cleanToken = (value: string): string | null =>
  value.replace(/\s+/g, " ").trim().slice(0, 60) || null;

/* ────────────── R50-T050 — the per-vendor registry ────────────── */

/** "structural" anchors CLI structure; "soft" is a name/model token. */
export type SignatureStrength = "structural" | "soft";

export interface VendorSignature {
  /** Stable cross-release id — the value reported in matchReasons. */
  id: string;
  strength: SignatureStrength;
  /** Tested against each sanitized output line. */
  re: RegExp;
}

export interface VendorProbeHandler {
  vendorKey: Exclude<DetectableVendorKey, "generic">;
  displayName: string;
  /**
   * Which read-only probe this vendor answers. For every handler except
   * sophos this is a member of DETECT_COMMANDS; sophos rides the WebAPI
   * transport (CERT-006) and its value documents that honestly.
   */
  probeCommand: string;
  signatures: readonly VendorSignature[];
  /** Ordered best-effort extractors (first match wins per slot). */
  model?: readonly RegExp[];
  osVersion?: readonly RegExp[];
}

/**
 * R50-T054 — attribution policy: STRUCTURAL signatures only. Soft
 * (name-shaped) tokens never attribute a vendor, alone or in combination;
 * they are reported as softMatches so operators see the near-miss.
 */

export const VENDOR_REGISTRY: readonly VendorProbeHandler[] = Object.freeze([
  {
    vendorKey: "cisco",
    displayName: "Cisco Systems",
    probeCommand: "show version",
    signatures: [
      { id: "cisco.ios-xe-banner", strength: "structural", re: /Cisco IOS XE Software/i },
      { id: "cisco.ios-banner", strength: "structural", re: /Cisco IOS Software/i },
      { id: "cisco.nxos-banner", strength: "structural", re: /Cisco Nexus Operating System/i },
      { id: "cisco.nxos-version", strength: "structural", re: /NX-OS Version/i },
      { id: "cisco.asa-banner", strength: "structural", re: /Cisco Adaptive Security Appliance/i },
      { id: "cisco.asa-virtual", strength: "structural", re: /Cisco Adaptive Security Virtual Appliance/i },
      // The chassis line ("cisco WS-C2960X-24TS-L … bytes of memory") —
      // classic IOS without the banner lines.
      { id: "cisco.chassis-memory", strength: "structural", re: /\bcisco\b.*bytes of memory/i },
      // A bare "cisco" token alone (hostname/banner text) is a near-miss:
      // reported via softMatches, never attributed on its own (R50-T054).
      { id: "cisco.vendor-name", strength: "soft", re: /\bcisco\b/i },
    ],
    osVersion: [
      /Cisco IOS XE Software, Version\s+(\S+)/i,
      /Cisco IOS Software(?: \[[^\]]+\])?, Version\s+(\S+)/i,
      /Cisco IOS Software, Version\s+(\S+)/i,
      /NX-OS Version\s+(\S+)/i,
      /Adaptive Security Appliance Version\s+(\S+)/i,
      // Classic IOS chassis-line form: "… C2960-LANBASEK9-M), Version
      // 15.2(4)E7, RELEASE SOFTWARE" (the last-listed fallback).
      /, Version\s+([^,\s]+)/,
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
    displayName: "Fortinet",
    probeCommand: "get system status",
    signatures: [
      // "Version:FortiGate-100D v5.0.7,build0282,…" — the status header of
      // `get system status` (always present on real output).
      { id: "fortinet.status-version", strength: "structural", re: /^Version:\s*Forti/i },
      // "Firmware Version: FortiOS v7.2.4" — the firmware status line.
      { id: "fortinet.firmware-version-line", strength: "structural", re: /^Firmware Version:\s*FortiOS/i },
      // Chassis/product NAME tokens: also appear in inventory prose and
      // banners — near-misses only (R50-T054).
      { id: "fortinet.chassis-token", strength: "soft", re: /\bFortiGate-\d/i },
      { id: "fortinet.fortios-name", strength: "soft", re: /FortiOS/i },
      { id: "fortinet.vendor-name", strength: "soft", re: /\bFortinet\b/i },
      // FortiManager / FortiSwitch / FortiAuthenticator tokens.
      { id: "fortinet.forti-product", strength: "soft", re: /\bForti[A-Z]\S+/ },
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
    displayName: "HPE Aruba",
    probeCommand: "show version",
    signatures: [
      { id: "hpe.aoscx-name", strength: "structural", re: /AOS-CX/i },
      { id: "hpe.arubaos-name", strength: "structural", re: /ArubaOS/i },
      { id: "hpe.procurve-name", strength: "structural", re: /ProCurve/i },
      // HPE name tokens in banners/asset text are near-misses (R50-T054).
      { id: "hpe.hpe-switch", strength: "soft", re: /\bHPE\b.*\bswitch\b/i },
      { id: "hpe.hpe-name", strength: "soft", re: /\bHewlett Packard Enterprise\b/i },
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
    displayName: "Juniper Networks",
    probeCommand: "show version",
    signatures: [
      // "Junos: 21.3R1.7" — the status line of show version.
      { id: "juniper.junos-version-line", strength: "structural", re: /^Junos:\s*\S+/ },
      { id: "juniper.kernel-line", strength: "structural", re: /JUNOS OS\b/i },
      // Vendor/model name tokens: banner/hostname near-misses only.
      { id: "juniper.vendor-name", strength: "soft", re: /Juniper Networks/i },
      { id: "juniper.junos-name", strength: "soft", re: /\bJunos OS\b/i },
      { id: "juniper.junos-token", strength: "soft", re: /\bJUNOS\b/ },
      { id: "juniper.model-token", strength: "soft", re: /\b(mx\d+|srx\d+\S*|qfx\d+\S*|ex\d+\S*|acx\d+\S*|vMX|vSRX)\b/i },
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
    displayName: "Palo Alto Networks",
    probeCommand: "show system info",
    signatures: [
      // `show system info` structure: "model: PA-VM" / "sw-version: 10.2.6".
      { id: "palo.model-line", strength: "structural", re: /^model:\s*PA-/i },
      { id: "palo.sw-version-line", strength: "structural", re: /^sw-version:\s*\d/i },
      // "Palo Alto Networks" appears in Panorama/MOTD text of OTHER devices —
      // a name token only (R50-T054); "PA-460" alone is a hostname/prompt.
      { id: "palo.vendor-name", strength: "soft", re: /Palo Alto Networks/i },
      { id: "palo.panos-name", strength: "soft", re: /\bPAN-OS\b/i },
      { id: "palo.model-token", strength: "soft", re: /\bPA-(?:VM|\d{3,4})\b/i },
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
    displayName: "Sophos",
    probeCommand:
      "(WebAPI transport — CERT-006; SFOS has no read-only SSH status command, SSH detection answers generic)",
    signatures: [
      // SFOS has no read-only SSH status command (rides WebAPI, CERT-006);
      // every SFOS token is a name-shaped near-miss — SSH detection stays
      // generic BY DESIGN (R50-T054).
      { id: "sophos.sfos-version", strength: "soft", re: /\bSFOS\s+v?\d/i },
      { id: "sophos.vendor-name", strength: "soft", re: /\bSophos\b/i },
      { id: "sophos.sfos-name", strength: "soft", re: /\bSFOS\b/i },
      { id: "sophos.model-token", strength: "soft", re: /\b(XG \d+|XGS \d+\w?|SG \d+)\b/i },
    ],
    model: [
      /\b(XG \d+|XGS \d+(?:w)?|SG \d+)\b/i,
    ],
    osVersion: [
      /\bSFOS\s+v?(\d+\.\d+\.\d+)/i,
    ],
  },
]);

/** Registry lookup by vendor key (null for "generic" / unknown keys). */
export const getVendorHandler = (
  vendorKey: string,
): VendorProbeHandler | null =>
  VENDOR_REGISTRY.find((h) => h.vendorKey === vendorKey) ?? null;

/* ────────────── attribution + the public fingerprint ────────────── */

export interface VendorFingerprint {
  /** Certified vendor family the output was attributed to. */
  vendorKey: DetectableVendorKey;
  /** Derived deterministically: "high" ⇔ attributed, "low" ⇔ generic. */
  confidence: "high" | "low";
  /** Best-effort chassis/model string from the output (null when absent). */
  model: string | null;
  /** Best-effort OS/firmware version string (null when absent). */
  osVersion: string | null;
  /** Bounded, sanitized output lines that justified the attribution. */
  evidence: string[];
  /**
   * R50-T052 — the stable signature ids that matched, in registry order.
   * Empty for the generic fallback.
   */
  matchReasons: string[];
  /**
   * R50-T054 — soft (name-token) ids that matched a handler WITHOUT
   * reaching attribution (banner/hostname near-misses). Present only on
   * generic results that have near-misses, so operators see why nothing
   * was claimed.
   */
  softMatches?: string[];
}

const GENERIC: VendorFingerprint = {
  vendorKey: "generic",
  confidence: "low",
  model: null,
  osVersion: null,
  evidence: [],
  matchReasons: [],
};

/**
 * Attribute CLI output to a certified vendor family under the deterministic
 * R50-T054 policy: only STRUCTURAL (CLI-shaped) signatures attribute; soft
 * name tokens never do. Never throws and never returns null: unrecognized
 * output answers the honest "generic / low" fingerprint with the leading
 * evidence lines — and any banner near-misses — so the operator can decide.
 */
export function parseVendorFingerprint(output: string): VendorFingerprint {
  const { text, lines } = prepareOutput(output);
  if (!text.trim()) return GENERIC;

  const softNearMisses: string[] = [];

  for (const handler of VENDOR_REGISTRY) {
    const matched = handler.signatures.filter((sig) =>
      lines.some((line) => sig.re.test(line)),
    );
    if (matched.length === 0) continue;

    const hasStructural = matched.some((s) => s.strength === "structural");

    if (!hasStructural) {
      // Name-token near-miss (banner/hostname/description text naming the
      // vendor) — record and keep looking; this handler is NOT claimed
      // (R50-T054).
      softNearMisses.push(...matched.map((s) => s.id));
      continue;
    }

    const extract = (patterns?: readonly RegExp[]): string | null => {
      if (!patterns) return null;
      for (const re of patterns) {
        const hit = text.match(re);
        if (hit && hit[1]) return cleanToken(hit[1]);
      }
      return null;
    };

    return {
      vendorKey: handler.vendorKey,
      confidence: "high",
      model: extract(handler.model),
      osVersion: extract(handler.osVersion),
      evidence: trimEvidence(lines),
      matchReasons: matched.map((s) => s.id),
    };
  }

  const uniqueNearMisses = [...new Set(softNearMisses)];
  return {
    ...GENERIC,
    evidence: trimEvidence(lines),
    ...(uniqueNearMisses.length > 0 ? { softMatches: uniqueNearMisses } : {}),
  };
}
