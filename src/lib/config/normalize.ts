/**
 * FayaNMS — Vendor-aware configuration normalization (Task 3-b).
 *
 * Pure functions, zero dependencies, safe to import on the server (diff API)
 * AND in the client (ConfigViewer "Normalize" toggle). The canonical,
 * comparable text produced here drives the diff engine: two snapshots of the
 * same config that differ only in volatile noise (timestamps, banners,
 * counters) normalize to identical text.
 *
 * Design rule (conservative): when unsure whether a line is noise, KEEP it.
 * Missing a noise line is harmless; dropping a real config line would hide a
 * real drift.
 */

/* ------------------------------------------------------------------ */
/* Secrets masking — THE single shared keyword list                    */
/* ------------------------------------------------------------------ */

/**
 * Keywords whose VALUE is sensitive. One list reused by:
 *   - normalizeConfig (masks values in normalized text, so secret rotations
 *     never show up as diff rows),
 *   - config-viewer (on-screen masking),
 *   - diff display (client-side re-masking of raw mode).
 * Per F-12: deliberate over-masking — everything after the keyword is hidden.
 */
export const SECRET_KEYWORDS = [
  "password",
  "passwd",
  "secret",
  "community",
  "psk",
  "passphrase",
  "pre-shared-key",
] as const;

/** Constant placeholder substituted for secret values. */
export const SECRET_MASK = "•••";

/** Matches `<keyword><whitespace><value to end of line>`, case-insensitive. */
export const SECRET_KEYWORD_RE = new RegExp(
  `((?:${SECRET_KEYWORDS.join("|")}))([ \\t]+).*$`,
  "i"
);

/** Mask the value following a secret keyword on a single line. */
export function maskSecretLine(line: string): string {
  return line.replace(SECRET_KEYWORD_RE, `$1$2${SECRET_MASK}`);
}

/* ------------------------------------------------------------------ */
/* Vendor keys                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalizer flavor keys — aligned with the worker adapters'
 * `configFlavor` values (mini-services/worker/adapters.ts):
 * cisco-ios (folds in NX-OS), fortios, sfos, aos-cx, generic.
 * `cisco-nxos` is accepted as a distinct key for future adapters.
 */
export type NormalizerVendorKey =
  | "cisco-ios"
  | "cisco-nxos"
  | "fortios"
  | "sfos"
  | "aos-cx"
  | "generic";

/**
 * Map a Device.vendor.key (DB: cisco | fortinet | sophos | hpe | generic)
 * — or an already-flavored key — onto a normalizer flavor. Unknown vendors
 * fall back to the conservative generic rules.
 */
export function resolveVendorKey(
  key: string | null | undefined
): NormalizerVendorKey {
  const normalized = (key ?? "").trim().toLowerCase();
  switch (normalized) {
    case "cisco":
    case "cisco-ios":
    case "ios":
    case "ios-xe":
      return "cisco-ios";
    case "cisco-nxos":
    case "nxos":
    case "nx-os":
      return "cisco-nxos";
    case "fortinet":
    case "fortios":
    case "fortigate":
      return "fortios";
    case "sophos":
    case "sfos":
      return "sfos";
    case "hpe":
    case "aruba":
    case "aos-cx":
    case "procurve":
      return "aos-cx";
    default:
      return "generic";
  }
}

/* ------------------------------------------------------------------ */
/* Global noise rules (vendor-independent)                             */
/* ------------------------------------------------------------------ */

/**
 * Non-comment volatile lines stripped for every vendor:
 *   - "Building configuration..." / "Current configuration" (show run headers)
 *   - "uptime is ..." / "last configuration change at ..." / "last read ..."
 *   - "ntp clock-period <drifting integer>" (auto-recomputed on Cisco IOS)
 */
const GLOBAL_NOISE_RE: RegExp[] = [
  /^building configuration\b/i,
  /^current configuration\b/i,
  /^uptime is\b/i,
  /^(?:last configuration change|last read)\b/i,
  /^ntp clock-period\b/i,
];

/**
 * Comment lines containing long hex runs (device-ids, serial dumps,
 * incrementing counters) are volatile noise. Only ever applied to lines
 * already identified as comments, so real config is never touched.
 */
const HEX_RUN_RE = /[0-9a-f]{10,}/i;

/**
 * Volatile comment lines stripped for EVERY vendor (comment lines are
 * never functional config, so stripping them cannot hide a real change):
 * uptime stamps, "last configuration change" timestamps, collector
 * time markers, "last read" lines and incrementing revision counters.
 */
const SHARED_COMMENT_NOISE_RE: RegExp[] = [
  /^uptime[:\s]/i,
  /^last configuration change at\b/i,
  /^last read[:\s]/i,
  /^time:\s/i,
  /config-revision counter\b/i,
];

/* ------------------------------------------------------------------ */
/* Per-vendor helpers                                                  */
/* ------------------------------------------------------------------ */

interface VendorRules {
  /** Prefixes marking a comment line for the vendor ("!" for Cisco families). */
  commentPrefixes: string[];
  /** Volatile comment patterns (matched after stripping the comment marker). */
  volatileCommentRe: RegExp[];
  /** Collapse runs of identical comment-only lines to a single instance. */
  collapseCommentRuns: boolean;
  /** Drop lines starting with these prefixes (e.g. "#config-version="). */
  dropPrefixes?: string[];
}

const FORTIOS_METADATA_RE = /^#(?:config-version|fw-version|fwb-version)=/i;

const VENDOR_RULES: Record<NormalizerVendorKey, VendorRules> = {
  "cisco-ios": {
    commentPrefixes: ["!"],
    volatileCommentRe: [],
    collapseCommentRuns: true,
  },
  "cisco-nxos": {
    commentPrefixes: ["!"],
    volatileCommentRe: [],
    collapseCommentRuns: true,
  },
  "aos-cx": {
    commentPrefixes: ["!"],
    volatileCommentRe: [],
    collapseCommentRuns: true,
  },
  fortios: {
    commentPrefixes: ["#"],
    volatileCommentRe: [FORTIOS_METADATA_RE],
    collapseCommentRuns: true,
    dropPrefixes: ["#config-version=", "#fw-version=", "#fwb-version="],
  },
  sfos: {
    commentPrefixes: ["#", "!"],
    volatileCommentRe: [],
    collapseCommentRuns: false,
  },
  generic: {
    commentPrefixes: ["!", "#"],
    volatileCommentRe: [],
    collapseCommentRuns: false,
  },
};

function isCommentLine(trimmed: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalize raw configuration text into the canonical comparable form:
 *
 *  1. CRLF safety + trailing-whitespace trim per line.
 *  2. Vendor metadata drops (FortiOS `#config-version=…`).
 *  3. Global volatile noise drops (show-run headers, uptime/last-change,
 *     ntp clock-period) + volatile vendor comment lines.
 *  4. Comment lines carrying long hex runs (counters/serial dumps) dropped.
 *  5. Secret values masked with the shared constant placeholder.
 *  6. Consecutive whitespace collapsed to a single space — skipped on lines
 *     containing quotes (free-text descriptions stay verbatim).
 *  7. Runs of blank lines collapsed to one; leading/trailing blanks removed.
 *  8. Vendor comment-only runs collapsed to a single comment line.
 */
export function normalizeConfig(rawText: string, vendorKey: string): string {
  const rules = VENDOR_RULES[resolveVendorKey(vendorKey)];
  const rawLines = rawText.split(/\r?\n/);

  // Pass 1 — per-line transforms and drops (order preserved).
  const kept: string[] = [];
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/u, "");
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      kept.push("");
      continue;
    }

    if (rules.dropPrefixes?.some((prefix) => trimmed.startsWith(prefix))) {
      continue;
    }

    if (GLOBAL_NOISE_RE.some((re) => re.test(trimmed))) {
      continue;
    }

    const comment = isCommentLine(trimmed, rules.commentPrefixes);
    if (comment) {
      const bare = trimmed.replace(/^[!#\s]+/, "");
      const volatileComment =
        rules.volatileCommentRe.some((re) => re.test(bare)) ||
        SHARED_COMMENT_NOISE_RE.some((re) => re.test(bare));
      if (volatileComment) {
        continue;
      }
      if (HEX_RUN_RE.test(bare)) {
        continue;
      }
    }

    // Secret masking before whitespace collapse so the placeholder spacing
    // is deterministic.
    let normalized = maskSecretLine(line);

    if (!normalized.includes('"')) {
      normalized = normalized.replace(/[ \t]{2,}/gu, " ");
    }

    kept.push(normalized);
  }

  // Pass 2 — blank-line collapse (runs → single blank; drop lead/trail).
  const blankCollapsed: string[] = [];
  let previousBlank = true; // swallows leading blanks
  for (const line of kept) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) continue;
    blankCollapsed.push(line);
    previousBlank = blank;
  }
  while (
    blankCollapsed.length > 0 &&
    blankCollapsed[blankCollapsed.length - 1].trim().length === 0
  ) {
    blankCollapsed.pop();
  }

  // Pass 3 — vendor comment-run collapse.
  const lines: string[] = [];
  let previousComment: string | null = null;
  for (const line of blankCollapsed) {
    const trimmed = line.trim();
    const isCommentRun =
      rules.collapseCommentRuns &&
      isCommentLine(trimmed, rules.commentPrefixes) &&
      trimmed.replace(/^[!#\s]+/, "").length === 0;
    if (isCommentRun && previousComment === trimmed) continue;
    lines.push(line);
    previousComment = isCommentRun ? trimmed : null;
  }

  return lines.join("\n");
}

/**
 * Quick non-crypto content fingerprint (FNV-1a 32-bit, hex) for equality
 * display and cheap change detection. NOT a substitute for the stored
 * sha256 integrity hash.
 */
export function configFingerprint(normalized: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
