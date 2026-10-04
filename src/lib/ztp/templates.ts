/**
 * FayaNMS ZTP base-config templates (Phase 14-b).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED VENDOR BOOTSTRAP CONFIGS                         │
 * │ The templates below are vendor-authentic ZERO-TOUCH-PROVISIONING         │
 * │ bootstrap configurations for the FayaNMS demo fleet. Syntax follows each │
 * │ vendor's real onboarding config (Cisco IOS classic, FortiOS, Junos OS    │
 * │ set-style) but the addresses, communities and credentials are invented   │
 * │ for the simulator — do NOT apply them to real hardware.                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Static, dependency-free, server- AND client-safe (the view renders the
 * preview with the same module the API validates against — one source).
 *
 * Each entry carries:
 *   - id          — stable template id (persisted on ZtpClaim.templateId),
 *   - vendorKey   — the seeded Vendor.key it provisions (must match at
 *                   claim time; enforced by POST /api/v1/ztp/claims),
 *   - name/description — human metadata (English canonical; the view
 *                   localizes around them),
 *   - lines       — config body lines. Exactly three variables exist:
 *                     {{hostname}}  claim hostname (RFC-ish, 3..63)
 *                     {{siteCode}}  site code, e.g. "BR1-HOD"
 *                     {{mgmtIp}}    management IPv4 the claim will take
 *
 * renderZtpConfig() substitutes ONLY the three known variables after
 * sanitising their values (control characters/newlines stripped, length
 * capped) — a crafted hostname can never inject extra config lines, and an
 * unknown {{placeholder}} is left verbatim so authoring mistakes stay
 * visible instead of silently rendering empty.
 */

export const ZTP_VARIABLES = ["hostname", "siteCode", "mgmtIp"] as const;

export type ZtpVariable = (typeof ZTP_VARIABLES)[number];

export interface ZtpTemplateVars {
  hostname: string;
  siteCode: string;
  mgmtIp: string;
}

export interface ZtpTemplate {
  id: string;
  /** Seeded Vendor.key this template provisions. */
  vendorKey: string;
  name: string;
  description: string;
  lines: string[];
}

export const ZTP_TEMPLATES: ZtpTemplate[] = [
  {
    id: "cisco-ztp",
    vendorKey: "cisco",
    name: "Cisco IOS — ZTP bootstrap",
    description:
      "Classic IOS onboarding: hostname, VLAN 1 management SVI, SNMP, NTP, syslog and SSH access.",
    lines: [
      "! FayaNMS ZTP bootstrap — template cisco-ztp — device {{hostname}}",
      "!",
      "service timestamps log datetime msec localtime",
      "service password-encryption",
      "!",
      "hostname {{hostname}}",
      "!",
      "no ip domain-lookup",
      "ip domain-name faya.local",
      "!",
      "vlan 1",
      " name MANAGEMENT",
      "!",
      "interface Vlan1",
      " description MANAGEMENT-INLINE-POWER",
      " ip address {{mgmtIp}} 255.255.255.0",
      " no ip redirects",
      " no shutdown",
      "!",
      "ip default-gateway 10.0.0.1",
      "!",
      "snmp-server community FayaRO RO",
      "snmp-server location {{siteCode}}",
      "snmp-server contact netops@faya.local",
      "!",
      "ntp server 10.20.255.1 prefer",
      "ntp server 10.30.255.1",
      "!",
      "logging host 10.20.255.9",
      "logging facility local6",
      "logging trap informational",
      "!",
      "ip ssh version 2",
      "ip ssh time-out 60",
      "ip ssh authentication-retries 3",
      "!",
      "line vty 0 4",
      " transport input ssh",
      " exec-timeout 30 0",
      "!",
      "end",
    ],
  },
  {
    id: "fortigate-ztp",
    vendorKey: "fortinet",
    name: "FortiOS — ZTP bootstrap",
    description:
      "FortiGate onboarding: system global identity, management interface, NTP, SNMP community and syslog.",
    lines: [
      "# FayaNMS ZTP bootstrap — template fortigate-ztp — device {{hostname}}",
      "#",
      "config system global",
      '    set hostname "{{hostname}}"',
      '    set alias "{{hostname}}"',
      '    set timezone "03"',
      "    set admin-sport 443",
      "end",
      "",
      "config system interface",
      '    edit "mgmt"',
      "        set ip {{mgmtIp}} 255.255.255.0",
      "        set allowaccess ping https ssh snmp",
      '        set description "MANAGEMENT-{{siteCode}}"',
      "        set role lan",
      "    next",
      "end",
      "",
      "config system ntp",
      '    set server "10.20.255.1" "10.30.255.1"',
      "    set syncinterval 300",
      "end",
      "",
      "config system snmp community",
      "    edit 1",
      '        set name "FayaRO"',
      "        set status enable",
      '        set hosts "10.20.255.9"',
      "    next",
      "end",
      "",
      "config log syslogd setting",
      "    set status enable",
      '    set server "10.20.255.9"',
      "    set facility local6",
      "end",
    ],
  },
  {
    id: "juniper-ztp",
    vendorKey: "juniper",
    name: "Junos OS — ZTP bootstrap",
    description:
      "Junos set-style onboarding: system identity, SSH services, NTP, syslog, SNMP and management interface.",
    lines: [
      "# FayaNMS ZTP bootstrap — template juniper-ztp — device {{hostname}}",
      "#",
      "set system host-name {{hostname}}",
      "set system domain-name faya.local",
      'set system root-authentication encrypted-password "$6$FayaNMS-Demo$"',
      "set system services ssh protocol-version v2",
      "set system services ssh root-login deny",
      "set system services netconf ssh",
      "set system ntp server 10.20.255.1 prefer",
      "set system ntp server 10.30.255.1",
      "set system syslog host 10.20.255.9 any info",
      "set system syslog host 10.20.255.9 match !(!)",
      "set system syslog user * any emergency",
      "set snmp community FayaRO authorization read-only",
      "set snmp community FayaRO clients 10.20.255.9/32",
      "set snmp location {{siteCode}}",
      "set snmp contact netops@faya.local",
      "set interfaces me0 unit 0 description MANAGEMENT-{{siteCode}}",
      "set interfaces me0 unit 0 family inet address {{mgmtIp}}/24",
      "set routing-options static route 0.0.0.0/0 next-hop 10.0.0.1",
    ],
  },
];

/* ────────────────────────────── lookups ────────────────────────────── */

export function getZtpTemplate(templateId: string): ZtpTemplate | null {
  const needle = templateId.trim();
  return ZTP_TEMPLATES.find((t) => t.id === needle) ?? null;
}

/** Templates available for a vendor key (empty for vendors without a ZTP flow). */
export function templatesForVendor(vendorKey: string): ZtpTemplate[] {
  const needle = vendorKey.trim().toLowerCase();
  return ZTP_TEMPLATES.filter((t) => t.vendorKey === needle);
}

/* ───────────────────────────── rendering ───────────────────────────── */

/** Variable sanity caps — generous enough for real values, tight enough to matter. */
const VAR_MAX_LENGTH: Record<ZtpVariable, number> = {
  hostname: 63,
  siteCode: 32,
  mgmtIp: 45, // IPv6 worst case; IPv4 fits comfortably
};

/**
 * Strip control characters and line breaks, trim, and cap the length — a
 * variable can never smuggle a second config line into the rendered body.
 */
function sanitizeVar(variable: ZtpVariable, raw: unknown): string {
  const value = typeof raw === "string" ? raw : String(raw ?? "");
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned.slice(0, VAR_MAX_LENGTH[variable]);
}

/** {{var}} with optional surrounding whitespace, e.g. "{{ hostname }}". */
function placeholderFor(variable: ZtpVariable): RegExp {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — `variable` is an internal template key from the ZTP_VARIABLES constant tuple ("hostname"|"siteCode"|"mgmtIp"), rendered server-side over operator-defined templates — never raw user input, so no injection/ReDoS surface.
  return new RegExp(`\\{\\{\\s*${variable}\\s*\\}\\}`, "g");
}

/**
 * Render a template's config body. Returns null when the templateId is
 * unknown — callers surface that as validation feedback, never a guess.
 * Only the three documented variables are substituted (safe substitution);
 * anything else stays as a visible {{placeholder}}.
 */
export function renderZtpConfig(
  templateId: string,
  vars: Partial<ZtpTemplateVars>
): string | null {
  const template = getZtpTemplate(templateId);
  if (!template) return null;
  return template.lines
    .map((line) => {
      let out = line;
      for (const variable of ZTP_VARIABLES) {
        if (!out.includes("{{")) break;
        // Missing/empty variables are LEFT AS the visible {{placeholder}} —
        // e.g. the new-claim form preview has no management address until the
        // worker assigns one, so the placeholder stays honest.
        const raw = vars[variable];
        if (typeof raw !== "string") continue;
        const value = sanitizeVar(variable, raw);
        if (!value) continue;
        out = out.replace(placeholderFor(variable), value);
      }
      return out;
    })
    .join("\n");
}
