/**
 * FayaNMS LIVE_SSH certification harness — Fortinet FortiOS 7.4 persona.
 *
 * A REAL SSH server (via persona-sshd.ts) wearing a FortiGate persona:
 * genuine SSH protocol, only the CLI text simulated. Mirrors the
 * live-ssh.ts fortinet allowlist (`show full-configuration` — the classic
 * FortiGate full-config export command, vendor docs: "Display the full
 * running configuration including defaults").
 *
 * Exec surface (read-only):
 *   show full-configuration | get system status
 * Anything else answers the authentic FortiGate CLI error line and exits 0.
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

export type FortiosHarness = PersonaHarness;

export const FORTIOS_GET_SYSTEM_STATUS = personaOutput([
  "Version: FortiGate-60F v7.4.4,build2697,240514 (GA.F)",
  "Firmware Signature: certified",
  "Branch: 2697",
  "Firmware build: 2697",
  "Firmware MD5: 6A3E2C0D1B9F8E7A4D5C6B2A1F0E9D8C",
  "Log hard disk: Available",
  "Hostname: HARNESS-FTG-01",
  "Private-data-encryption: Disable",
  "Operation Mode: NAT",
  "Current virtual domain: root",
  "Max virtual domain: 10",
  "Virtual domains status: 1 in-use, 9 inactive",
  "Serial Number: FGT60FTK209999999",
  "HA Status: standalone",
  "Branch point: 2697",
  "Release Version Information: GA",
  "Firmware Type: GA",
  "Current Time: Mon Sep  8 09:12:44 2026",
  "Daylight Time Saving: No",
  "Time Zone: (UTC) Coordinated Universal Time",
  "Uptime: 12 days, 3 hours, 44 minutes",
]);

export const FORTIOS_SHOW_FULL_CONFIG = personaOutput([
  "#config-version=FGT60F-7.4.4-FW-build2697-240514:opmode=0:vitfver=1.2.0",
  "#conf_file_ver=1412200000",
  "#buildno=2697",
  "#global_vdom=1",
  "config system global",
  "    set admin-sport 8443",
  "    set hostname \"HARNESS-FTG-01\"",
  "    set timezone 04",
  "end",
  "config system interface",
  "    edit \"wan1\"",
  "        set ip 198.51.100.2 255.255.255.248",
  "        set allowaccess ping",
  "        set role wan",
  "    next",
  "    edit \"lan\"",
  "        set ip 10.30.10.1 255.255.255.0",
  "        set allowaccess ping https ssh",
  "        set role lan",
  "        set interface \"internal\"",
  "        set vlanid 10",
  "    next",
  "end",
  "config system dns",
  "    set primary 10.30.10.53",
  "    set secondary 198.51.100.53",
  "end",
  "config router static",
  "    edit 1",
  "        set gateway 198.51.100.1",
  "        set device \"wan1\"",
  "    next",
  "end",
  "config firewall address",
  "    edit \"LAN-NET\"",
  "        set subnet 10.30.10.0 255.255.255.0",
  "    next",
  "end",
  "config firewall policy",
  "    edit 1",
  "        set name \"LAN-to-WAN-ALLOW\"",
  "        set srcintf \"lan\"",
  "        set dstintf \"wan1\"",
  "        set srcaddr \"LAN-NET\"",
  "        set dstaddr \"all\"",
  "        set action accept",
  "        set schedule \"always\"",
  "        set service \"ALL\"",
  "        set logtraffic utm",
  "    next",
  "end",
  "config system snmp community",
  "    edit 1",
  "        set name \"faya-readonly\"",
  "        set status enable",
  "    next",
  "end",
]);

const COMMAND_OUTPUTS: Record<string, string> = {
  "show full-configuration": FORTIOS_SHOW_FULL_CONFIG,
  "get system status": FORTIOS_GET_SYSTEM_STATUS,
};

export async function startFortiosSshHarness(
  opts: HarnessOptions = {},
): Promise<FortiosHarness> {
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    // Authentic FortiGate CLI behavior for an unrecognized command.
    invalidCommandLine: "Command fail. Return code -3\n",
  };
  return startPersonaSshHarness(personaOpts);
}
