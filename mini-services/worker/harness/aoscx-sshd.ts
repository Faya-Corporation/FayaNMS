/**
 * FayaNMS LIVE_SSH certification harness — HPE Aruba AOS-CX 10.13 persona.
 *
 * A REAL SSH server (via persona-sshd.ts) wearing an AOS-CX switch persona:
 * genuine SSH protocol, only the CLI text simulated. Mirrors the
 * live-ssh.ts hpe allowlist (`show running-config` — AOS-CX running config,
 * Aruba-style curly-free blocks separated by `!` comment lines).
 *
 * Exec surface (read-only):
 *   show running-config | show version
 * Anything else answers the authentic AOS-CX error line and exits 0.
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

export type AosCxHarness = PersonaHarness;

export const AOSCX_SHOW_VERSION = personaOutput([
  "------------------------------------------------------------------------------",
  "ArubaOS-CX",
  "(C) Copyright 2017-2026 Hewlett Packard Enterprise Development LP",
  "------------------------------------------------------------------------------",
  "Switch System Hostname   : HARNESS-CX-01",
  "System Description      : FL.10.13.1050",
  "Switch Software Version : GL.10.13.1050",
  "Build date              : 2026-04-18 11:22:31 UTC",
  "Up Time                 : 33 days, 7 hours, 2 minutes",
  "Memory                  : Total 8084564 kB, Free 4291312 kB",
  "CPU Utilization         : 12%",
  "Serial Number           : CN1234ABCD",
]);

export const AOSCX_SHOW_RUNNING = personaOutput([
  "hostname HARNESS-CX-01",
  "user netadmin group administrators password ciphertext AQBapQFayaNMSGh0c3Ryb25n",
  "!",
  "snmp-server community faya-readonly",
  "!",
  "vlan 1",
  "vlan 10",
  "   name USERS",
  "vlan 20",
  "   name VOICE",
  "vlan 99",
  "   name MANAGEMENT",
  "!",
  "interface 1/1/1",
  "   description UPLINK-CORE-SW-01",
  "   no shutdown",
  "   vlan trunk native 1 tag",
  "   vlan trunk allowed 10,20,99",
  "!",
  "interface 1/1/2",
  "   description ACCESS-PORT-A10",
  "   no shutdown",
  "   vlan access 10",
  "   spanning-tree portfast",
  "!",
  "interface lag 1",
  "   description MLAG-PEER",
  "!",
  "interface vlan 10",
  "   ip address 10.40.10.2/24",
  "!",
  "interface vlan 99",
  "   ip address 10.40.99.2/24",
  "!",
  "ip route 0.0.0.0/0 10.40.99.1",
  "!",
]);

const COMMAND_OUTPUTS: Record<string, string> = {
  "show running-config": AOSCX_SHOW_RUNNING,
  "show version": AOSCX_SHOW_VERSION,
};

export async function startAosCxSshHarness(
  opts: HarnessOptions = {},
): Promise<AosCxHarness> {
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    // Authentic AOS-CX behavior for an unrecognized command.
    invalidCommandLine: "% Invalid input: unrecognized command\n",
  };
  return startPersonaSshHarness(personaOpts);
}
