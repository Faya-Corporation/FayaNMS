/**
 * FayaNMS LIVE_SSH certification harness — Cisco IOS 15.x persona.
 *
 * A REAL SSH server (ssh2 server mode, via the persona factory in
 * persona-sshd.ts) wearing an IOS device persona. Certification semantics
 * are unchanged from slice 1: genuine SSH protocol end-to-end, only the
 * CLI text is simulated; hardware certification stays open (README
 * honest-status block).
 *
 * Exec surface (read-only, mirrors the live-ssh.ts cisco allowlist):
 *   show running-config | show version | show ip interface brief
 * Anything else answers the authentic IOS error line and exits 0.
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

/** Preserve the slice-1 public type so certify.ts callers stay stable. */
export type IOSHarness = PersonaHarness;

export const IOS_SHOW_VERSION = personaOutput([
  "Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc3)",
  "Technical Support: http://www.cisco.com/techsupport",
  "Copyright (c) 1986-2018 by Cisco Systems, Inc.",
  "Compiled Fri 15-Jun-18 15:30 by prod_rel_team",
  "",
  "ROM: Bootstrap program is C2960 boot loader",
  "",
  "HARNESS-IOS-01 uptime is 42 days, 6 hours, 17 minutes",
  "System returned to ROM by power-on",
  "System restarted at 09:12:04 UTC Mon Aug 3 2026",
  "System image file is \"flash:c2960-lanbasek9-mz.152-4.E7.bin\"",
  "",
  "cisco WS-C2960X-24TS-L (APM86XXX) processor (revision B0) with 131072K bytes of memory.",
  "Processor board ID FOC1932X0AB",
  "Last reset from power-on",
  "1 Virtual Ethernet interface",
  "24 Gigabit Ethernet interfaces",
  "The password-recovery mechanism is enabled.",
  "",
  "Configuration register is 0xF",
]);

export const IOS_SHOW_RUNNING = personaOutput([
  "Building configuration...",
  "",
  "Current configuration : 3184 bytes",
  "!",
  "! Last configuration change at 09:41:22 UTC Mon Sep 7 2026 by netadmin",
  "! NVRAM config last updated at 09:41:23 UTC Mon Sep 7 2026 by netadmin",
  "!",
  "version 15.2",
  "no service pad",
  "service timestamps debug datetime msec localtime",
  "service timestamps log datetime msec localtime",
  "service password-encryption",
  "!",
  "hostname HARNESS-IOS-01",
  "!",
  "enable secret 5 $1$mERr$hx9mF6oP4mB9uJYZ0jzYV0",
  "!",
  "aaa new-model",
  "aaa authentication login default local",
  "aaa authorization exec default local",
  "!",
  "ip domain-name faya.local",
  "ip cef",
  "!",
  "spanning-tree mode rapid-pvst",
  "spanning-tree extend system-id",
  "!",
  "vlan 10",
  " name USERS",
  "!",
  "vlan 20",
  " name VOICE",
  "!",
  "vlan 99",
  " name MANAGEMENT",
  "!",
  "interface GigabitEthernet0/1",
  " description UPLINK-CORE-SW-01",
  " switchport mode trunk",
  "!",
  "interface GigabitEthernet0/2",
  " description ACCESS-PORT-A10",
  " switchport access vlan 10",
  " switchport voice vlan 20",
  " spanning-tree portfast",
  "!",
  "interface Vlan10",
  " ip address 10.20.10.3 255.255.255.0",
  "!",
  "interface Vlan99",
  " ip address 10.20.99.3 255.255.255.0",
  "!",
  "router ospf 1",
  " router-id 10.20.99.3",
  " network 10.20.10.0 0.0.0.255 area 0",
  " network 10.20.99.0 0.0.0.255 area 0",
  "!",
  "ip default-gateway 10.20.99.1",
  "snmp-server community faya-readonly RO",
  "snmp-server location HARNESS-RACK-A01",
  "!",
  "line con 0",
  " logging synchronous",
  "line vty 0 4",
  " transport input ssh",
  "line vty 5 15",
  " transport input ssh",
  "!",
  "end",
]);

export const IOS_SHOW_IP_BRIEF = personaOutput([
  "Interface              IP-Address      OK? Method Status                Protocol",
  "Vlan10                 10.20.10.3      YES manual up                    up",
  "Vlan99                 10.20.99.3      YES manual up                    up",
  "GigabitEthernet0/1     unassigned      YES unset  up                    up",
  "GigabitEthernet0/2     unassigned      YES unset  up                    up",
]);

const COMMAND_OUTPUTS: Record<string, string> = {
  "show running-config": IOS_SHOW_RUNNING,
  "show version": IOS_SHOW_VERSION,
  "show ip interface brief": IOS_SHOW_IP_BRIEF,
};

export async function startIosSshHarness(
  opts: HarnessOptions = {},
): Promise<IOSHarness> {
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    invalidCommandLine: "% Invalid input detected at '^' marker.\n",
  };
  return startPersonaSshHarness(personaOpts);
}
