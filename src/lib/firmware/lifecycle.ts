/**
 * FayaNMS firmware lifecycle matrix (Phase 13-b).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED VENDOR LIFECYCLE                                 │
 * │ The release lines, "current stable" versions, EOS/EOL dates and status   │
 * │ assignments below are DOCUMENTED SIMULATIONS for the FayaNMS demo        │
 * │ fleet. They are directionally realistic (each family's real versioning   │
 * │ scheme and roughly its real lifecycle posture) but the specific dates    │
 * │ and status boundaries are invented — this is NOT a live vendor feed and  │
 * │ MUST NOT be used for real upgrade planning.                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Static, dependency-free per-vendor/per-family table. Every entry carries:
 *   - a `match` regex recognising the family's version strings,
 *   - `stable` — the suggested current-stable target for upgrades (the
 *     upgrade dialog pre-fills this),
 *   - `versionRegex` — the vendor-appropriate target-version format for the
 *     family (POST /api/v1/firmware/upgrade validates against it),
 *   - `lines` — longest-prefix status map for versions seen in the demo
 *     fleet (status per release line),
 *   - `eolDate` — documented end-of-support date for the family's older
 *     trains (simulated).
 *
 * Status ladder (getLifecycle):
 *   current — on the recommended stable line
 *   aging   — one or two trains behind; supported, plan the jump
 *   eos     — end-of-sale reached; last maintenance releases only
 *   eol     — past the documented end-of-support date
 *
 * An unrecognized version inside a known family classifies as "aging"
 * (detail says so explicitly); an unknown vendor/firmware returns null so
 * callers can render a neutral "no data" state instead of guessing.
 */

export type LifecycleStatus = "current" | "aging" | "eos" | "eol";

export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  "current",
  "aging",
  "eos",
  "eol",
];

export interface LifecycleDetail {
  status: LifecycleStatus;
  /** English canonical detail (technical fallback — the view localizes). */
  detail: string;
  /** Family label, e.g. "Cisco IOS XE" (technical string, not localized). */
  family: string;
}

interface ReleaseLine {
  /** Version prefix, matched longest-first ("17.09." before "17."). */
  prefix: string;
  status: LifecycleStatus;
}

interface FirmwareFamily {
  key: string;
  label: string;
  /** Recognises the family's own version strings. */
  match: RegExp;
  /** Vendor-appropriate version format for upgrade targets. */
  versionRegex: RegExp;
  /** Suggested current-stable target (upgrade dialog pre-fill). */
  stable: string;
  /** Simulated end-of-support date for the family's older trains. */
  eolDate: string;
  /** Longest-prefix status map for the versions seen in the demo fleet. */
  lines: ReleaseLine[];
  /** Status for versions in-family that no line matches. */
  fallbackStatus: LifecycleStatus;
}

interface VendorLifecycle {
  vendor: string;
  families: FirmwareFamily[];
}

// Shared version-format regexes (vendor-appropriate target validation).
const RE_IOS = /^\d{1,2}\.\d\(\d+\)[A-Z]?\d*$/i; // 15.2(7)E4
const RE_IOS_XE = /^\d{2}\.\d{2}\.\d{2}[a-z]?$/i; // 17.12.04 / 17.09.03a
const RE_NXOS = /^\d{1,2}\.\d\(\d+\)$/; // 10.3(2)
const RE_FORTIOS = /^\d{1,2}\.\d\.\d{1,2}$/; // 7.4.5
const RE_SFOS = /^\d{2}\.\d(\.\d)?( MR\d+)?$/i; // 20.0 MR2 / 19.5 MR3
const RE_AOS_CX = /^\d{2}\.\d{2}\.\d{4}$/; // 10.13.0008
const RE_JUNOS = /^\d{1,2}\.\dR\d+(-S\d+(\.\d+)?)?$/; // 22.4R3-S2.9
const RE_PANOS = /^\d{2}\.\d\.\d[a-z]?$/i; // 11.1.3
const RE_GENERIC = /^[A-Za-z0-9][A-Za-z0-9.\-() ]{0,24}$/; // 24.03, 23.09

/**
 * The matrix. Family regexes within a vendor are disjoint; getLifecycle
 * matches families via `match` and release lines via longest-prefix.
 */
export const FIRMWARE_LIFECYCLE: VendorLifecycle[] = [
  {
    vendor: "cisco",
    families: [
      {
        key: "cisco-ios-xe",
        label: "Cisco IOS XE",
        match: /^17\.\d{2}\.\d{2}[a-z]?$/i,
        versionRegex: RE_IOS_XE,
        stable: "17.12.04",
        eolDate: "2028-01-31",
        lines: [
          { prefix: "17.12.", status: "current" },
          { prefix: "17.09.", status: "current" },
          { prefix: "17.06.", status: "aging" },
          { prefix: "17.07.", status: "aging" },
        ],
        fallbackStatus: "aging",
      },
      {
        key: "cisco-nx-os",
        label: "Cisco NX-OS",
        match: /^(9|10)\.\d\(\d+\)$/,
        versionRegex: RE_NXOS,
        stable: "10.3(2)",
        eolDate: "2027-07-31",
        lines: [
          { prefix: "10.", status: "current" },
          { prefix: "9.3(", status: "aging" },
        ],
        fallbackStatus: "aging",
      },
      {
        key: "cisco-ios",
        label: "Cisco IOS (classic)",
        match: /^\d{1,2}\.\d\(\d+\)[A-Z]?\d*$/i,
        versionRegex: RE_IOS,
        // Classic IOS cannot follow 17.x — the last 15.2(7)E maintenance
        // release is the right in-place target for EOL platforms.
        stable: "15.2(7)E4",
        eolDate: "2026-04-30",
        lines: [
          { prefix: "15.2(7)E4", status: "current" },
          { prefix: "15.2(7)", status: "eol" },
          { prefix: "15.", status: "eol" },
          { prefix: "12.", status: "eol" },
        ],
        fallbackStatus: "eol",
      },
    ],
  },
  {
    vendor: "fortinet",
    families: [
      {
        key: "fortios",
        label: "FortiOS",
        match: /^\d{1,2}\.\d\.\d{1,2}$/,
        versionRegex: RE_FORTIOS,
        stable: "7.4.5",
        eolDate: "2027-10-31",
        lines: [
          { prefix: "7.4.", status: "current" },
          { prefix: "7.2.", status: "aging" },
          { prefix: "7.0.", status: "eos" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
  {
    vendor: "sophos",
    families: [
      {
        key: "sfos",
        label: "Sophos SFOS",
        match: /^\d{2}\.\d(\.\d)?( MR\d+)?$/i,
        versionRegex: RE_SFOS,
        stable: "20.0 MR2",
        eolDate: "2026-12-31",
        lines: [
          { prefix: "20.", status: "current" },
          { prefix: "19.5 MR", status: "eos" },
          { prefix: "19.5", status: "aging" },
          { prefix: "18.", status: "eol" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
  {
    vendor: "hpe",
    families: [
      {
        key: "aos-cx",
        label: "HPE AOS-CX",
        match: /^\d{2}\.\d{2}\.\d{4}$/,
        versionRegex: RE_AOS_CX,
        // 10.13 is the line the demo change plan (CHG-2026-00401) targets.
        stable: "10.13.0008",
        eolDate: "2027-05-31",
        lines: [
          { prefix: "10.13.", status: "current" },
          { prefix: "10.12.", status: "current" },
          { prefix: "10.10.", status: "aging" },
          { prefix: "10.08.", status: "eos" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
  {
    vendor: "juniper",
    families: [
      {
        key: "junos",
        label: "Juniper Junos OS",
        match: /^\d{1,2}\.\dR\d+(-S\d+(\.\d+)?)?$/,
        versionRegex: RE_JUNOS,
        stable: "22.4R3-S2.9",
        eolDate: "2026-06-30",
        lines: [
          { prefix: "22.", status: "current" },
          { prefix: "21.4", status: "eos" },
          { prefix: "21.", status: "eol" },
          { prefix: "20.", status: "eol" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
  {
    vendor: "palo",
    families: [
      {
        key: "pan-os",
        label: "Palo Alto PAN-OS",
        match: /^\d{2}\.\d\.\d[a-z]?$/i,
        versionRegex: RE_PANOS,
        stable: "11.1.3",
        eolDate: "2028-02-28",
        lines: [
          { prefix: "11.1.", status: "current" },
          { prefix: "11.0.", status: "current" },
          { prefix: "10.2.", status: "aging" },
          { prefix: "10.1.", status: "eos" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
  {
    vendor: "generic",
    families: [
      {
        key: "generic",
        label: "Generic appliance",
        match: /.*/,
        versionRegex: RE_GENERIC,
        stable: "24.03",
        eolDate: "2027-12-31",
        lines: [
          { prefix: "24.", status: "current" },
          { prefix: "23.", status: "current" },
          { prefix: "22.", status: "aging" },
        ],
        fallbackStatus: "aging",
      },
    ],
  },
];

/** Permissive final fallback when no family regex exists to validate with. */
const RE_FALLBACK = /^[A-Za-z0-9][A-Za-z0-9.\-() ]{0,24}$/;

/** Find the family entry for a vendor + its current firmware string. */
function findFamily(
  vendorKey: string,
  firmware: string | null
): { family: FirmwareFamily; vendor: VendorLifecycle } | null {
  const vendor = FIRMWARE_LIFECYCLE.find(
    (v) => v.vendor === vendorKey.toLowerCase().trim()
  );
  if (!vendor || !firmware) return null;
  const family = vendor.families.find((f) => f.match.test(firmware.trim()));
  return family ? { family, vendor } : null;
}

/** English canonical detail sentences (the view localizes around them). */
const LIFECYCLE_DETAILS: Record<
  LifecycleStatus,
  (family: string, version: string, eolDate: string) => string
> = {
  current: (family) =>
    `${family}: on the recommended stable line (simulated vendor lifecycle data).`,
  aging: (family, version, eolDate) =>
    `${family}: ${version} is one or two trains behind the stable line — supported, plan the upgrade (simulated EOL ${eolDate}).`,
  eos: (family, version, eolDate) =>
    `${family}: ${version} reached end-of-sale — maintenance releases only (simulated EOL ${eolDate}).`,
  eol: (family, version, eolDate) =>
    `${family}: ${version} is past end-of-life (simulated date ${eolDate}) — upgrade as soon as a window allows.`,
};

/**
 * Classify a firmware string for a vendor. Returns null when the vendor is
 * unknown or the firmware is missing/recognises no family — callers render
 * a neutral "no data" state (never a guessed status).
 */
export function getLifecycle(
  vendorKey: string,
  firmware: string | null | undefined
): LifecycleDetail | null {
  if (!firmware) return null;
  const found = findFamily(vendorKey, firmware);
  if (!found) return null;
  const { family } = found;
  const version = firmware.trim();

  const line = [...family.lines]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((l) => version.startsWith(l.prefix));

  const status = line?.status ?? family.fallbackStatus;
  return {
    status,
    detail: LIFECYCLE_DETAILS[status](family.label, version, family.eolDate),
    family: family.label,
  };
}

/**
 * Suggested upgrade target for a device: the matched family's stable. Falls
 * back to the vendor's first family stable when the current firmware does
 * not match a family (never throws; null when the vendor is unknown).
 */
export function suggestTarget(
  vendorKey: string,
  firmware: string | null | undefined
): string | null {
  const vendor = FIRMWARE_LIFECYCLE.find(
    (v) => v.vendor === vendorKey.toLowerCase().trim()
  );
  if (!vendor) return null;
  const found = findFamily(vendorKey, firmware ?? null);
  return (found?.family ?? vendor.families[0]).stable;
}

/**
 * Validate an upgrade target version against the device's family format
 * (vendor-appropriate regex). Unknown vendors fall back to a permissive
 * technical-string format. The empty string is never valid.
 */
export function isValidTargetVersion(
  vendorKey: string,
  currentFirmware: string | null | undefined,
  target: string
): boolean {
  const candidate = target.trim();
  if (!candidate) return false;
  const found = findFamily(vendorKey, currentFirmware ?? null);
  const regex = found?.family.versionRegex ?? RE_FALLBACK;
  return regex.test(candidate);
}
