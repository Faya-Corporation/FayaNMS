/**
 * FayaNMS LIVE_SSH certification harness — Palo Alto PAN-OS persona.
 *
 * A REAL SSH server (via persona-sshd.ts) wearing a PAN-OS persona:
 * genuine SSH protocol, only the CLI text simulated. Mirrors the
 * live-ssh.ts palo allowlist (`show config running` — set-style body,
 * same style as the simulator's palo-panos adapter).
 *
 * Exec surface (read-only):
 *   show config running | show system info
 * Anything else answers the authentic PAN-OS error line and exits 0.
 *
 * Shell surface (Phase 23 controlled-change plane): PAN-OS CLI
 * (configure → set interface comment → commit → exit);
 * `set network interface ethernet … comment` MUTATES the persona config
 * so a post-apply fetch reflects the delta.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED DEVICE PERSONA                                  │
 * │ The config text below (including the demo SNMP community FayaRO) is     │
 * │ INVENTED persona content for the LIVE_SSH certification harness —       │
 * │ not real device secrets. Pinned by                                      │
 * │ tests/audit/open-findings-batch-19.test.ts (F-045 grep-guard).          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import {
  personaOutput,
  startPersonaSshHarness,
  type PersonaHarness,
  type PersonaHarnessOptions,
} from "./persona-sshd";

export interface HarnessOptions {
  /** ephemeral port when omitted (0) */
  port?: number;
  username?: string;
  password?: string;
}

export type PanosHarness = PersonaHarness;

export const PANOS_SHOW_SYSTEM_INFO = personaOutput([
  "hostname: HARNESS-PA-01",
  "model: PA-5410",
  "serial: 014701002301542",
  "sw-version: 11.0.4",
  "vm-license: BNFB-2CND-BLXW-CM3H-T3WA-KF3H",
  "uptime: 21 days, 3:44:12",
  "",
  "operational-mode: normal",
  "panorama: CONNECTED",
]);

/**
 * PAN-OS running configuration in set style (show config running).
 * Mirrors the simulator's paloBody layout: deviceconfig system plane,
 * network interface/zone/virtual-router, rulebase security.
 */
export const PANOS_SHOW_CONFIG_RUNNING = personaOutput([
  "set deviceconfig system hostname HARNESS-PA-01",
  "set deviceconfig system timezone Asia/Aden",
  "set deviceconfig system domain faya.local",
  "set deviceconfig system ip-address 10.30.255.8",
  "set deviceconfig system netmask 255.255.255.0",
  "set deviceconfig system default-gateway 10.30.255.254",
  "set deviceconfig system dns-setting servers primary 10.20.10.10",
  "set deviceconfig system ntp-servers primary-ntp-server ntp-server-address 10.20.10.10",
  'set deviceconfig system snmp-setting location "DC-Aden-Rack-B2"',
  'set deviceconfig system snmp-setting contact "NOC <noc@faya.local>"',
  "set shared snmpserver profile FayaNMS version v2c community FayaRO",
  "set network interface ethernet ethernet1/1 link-state auto",
  "set network interface ethernet ethernet1/1 layer3 ip 10.30.254.2/30",
  'set network interface ethernet ethernet1/1 comment "WAN-UPLINK"',
  "set network interface ethernet ethernet1/2 layer3 ip 10.30.0.1/24",
  'set network interface ethernet ethernet1/2 comment "LAN-CORE"',
  "set network interface ethernet ethernet1/3 layer3 ip 10.30.100.1/24",
  'set network interface ethernet ethernet1/3 comment "DMZ-SEGMENT"',
  "set network interface ethernet ethernet1/8 comment \"HA-LINK\"",
  "set network virtual-router default interface [ ethernet1/1 ethernet1/2 ethernet1/3 ]",
  "set network virtual-router default static-route DEFAULT destination 0.0.0.0/0 nexthop ip-address 10.30.254.1",
  "set zone UNTRUST network layer3 ethernet1/1",
  "set zone TRUST network layer3 ethernet1/2",
  "set zone DMZ network layer3 ethernet1/3",
  "set rulebase security rules LAN-to-WAN from TRUST",
  "set rulebase security rules LAN-to-WAN to UNTRUST",
  "set rulebase security rules LAN-to-WAN source any",
  "set rulebase security rules LAN-to-WAN destination any",
  "set rulebase security rules LAN-to-WAN application any",
  "set rulebase security rules LAN-to-WAN service any",
  "set rulebase security rules LAN-to-WAN action allow",
  "set rulebase security rules DMZ-to-WAN from DMZ",
  "set rulebase security rules DMZ-to-WAN to UNTRUST",
  "set rulebase security rules DMZ-to-WAN source any",
  "set rulebase security rules DMZ-to-WAN destination any",
  "set rulebase security rules DMZ-to-WAN service any",
  "set rulebase security rules DMZ-to-WAN action allow",
]);

const COMMAND_OUTPUTS: Record<string, string | (() => string)> = {
  "show config running": PANOS_SHOW_CONFIG_RUNNING,
  "show system info": PANOS_SHOW_SYSTEM_INFO,
};

/* ─────────────── Phase 23: interactive config-mode shell ─────────────── */

type PanosMode = "op" | "config";

interface PanosShellState {
  mode: PanosMode;
  body: string;
}

/** Insert/replace/remove the `comment "<value>"` set-line for one interface. */
export function setPanosInterfaceComment(
  body: string,
  ifName: string,
  comment: string | null,
): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const prefix = `set network interface ethernet ${ifName} comment `;
  const commentIdx = lines.findIndex((l) => l.startsWith(`${prefix}"`));
  const next = comment === null ? null : `${prefix}"${comment}"`;
  if (commentIdx >= 0) {
    if (next) lines[commentIdx] = next;
    else lines.splice(commentIdx, 1);
    return `${lines.join("\n")}\n`;
  }
  if (next) {
    // No existing comment line — append after the interface's last set-line.
    const ifacePrefix = `set network interface ethernet ${ifName} `;
    let last = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith(ifacePrefix)) last = i;
    }
    if (last >= 0) lines.splice(last + 1, 0, next);
    else lines.push(next);
  }
  return `${lines.join("\n")}\n`;
}

function panosShell(): { state: PanosShellState; shell: PersonaHarnessOptions["shell"] } {
  const state: PanosShellState = {
    mode: "op",
    body: PANOS_SHOW_CONFIG_RUNNING,
  };
  COMMAND_OUTPUTS["show config running"] = () => state.body;
  const shell = {
    prompt: () => (state.mode === "op" ? "netadmin@HARNESS-PA-01> " : "netadmin@HARNESS-PA-01# "),
    handle: (line: string) => {
      const cmd = line.trim();
      if (state.mode === "op") {
        if (cmd === "configure") {
          state.mode = "config";
          return {};
        }
        if (cmd === "show config running") return { output: state.body };
        return { error: true };
      }
      const set = /^set network interface ethernet (\S+) comment "(.*)" *$/.exec(cmd);
      if (set) {
        state.body = setPanosInterfaceComment(state.body, set[1], set[2].trim());
        return {};
      }
      const del = /^delete network interface ethernet (\S+) comment$/.exec(cmd);
      if (del) {
        state.body = setPanosInterfaceComment(state.body, del[1], null);
        return {};
      }
      if (cmd === "commit") {
        return { output: "Configuration committed successfully\n" };
      }
      if (cmd === "exit") {
        state.mode = "op";
        return {};
      }
      if (cmd === "show config running") return { output: state.body };
      return { error: true };
    },
  };
  return { state, shell };
}

export async function startPanosSshHarness(
  opts: HarnessOptions = {},
): Promise<PanosHarness> {
  const { shell } = panosShell();
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    shell,
    // Authentic PAN-OS CLI behavior for an unrecognized command.
    invalidCommandLine: "Invalid syntax.\n",
  };
  return startPersonaSshHarness(personaOpts);
}
