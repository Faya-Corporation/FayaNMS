/**
 * FayaNMS LIVE_SSH certification harness — a REAL SSH server (ssh2 server
 * mode) wearing a Cisco IOS 15.x device persona.
 *
 * What this IS: a genuine SSH protocol endpoint (ed25519 host key, real
 * handshake, real password authentication, real exec channels). The
 * adapter under certification exercises the genuine ssh2 client transport
 * against genuine ssh2 server machinery — only the DEVICE PERSONA (the
 * CLI text) is simulated. That makes this a TRANSPORT + COMMAND-MAPPING
 * certification, not a mock of the adapter itself.
 *
 * What this is NOT: physical hardware. Hardware certification (real
 * IOS/IOS-XE devices) stays open and is tracked in the README
 * honest-status block — the harness proves the code, not the wire to a
 * real switch.
 *
 * Exec surface (read-only, mirrors the live-ssh.ts cisco-ios allowlist):
 *   show running-config | show version | show ip interface brief
 * Anything else answers the authentic IOS error line and exits 0.
 */

import { Server, utils, type Connection } from "ssh2";

export interface HarnessOptions {
  /** ephemeral port when omitted (0) */
  port?: number;
  username?: string;
  password?: string;
}

export interface IOSHarness {
  port: number;
  close(): Promise<void>;
}

const SHOW_VERSION = [
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
];

const SHOW_RUNNING = [
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
];

const SHOW_IP_BRIEF = [
  "Interface              IP-Address      OK? Method Status                Protocol",
  "Vlan10                 10.20.10.3      YES manual up                    up",
  "Vlan99                 10.20.99.3      YES manual up                    up",
  "GigabitEthernet0/1     unassigned      YES unset  up                    up",
  "GigabitEthernet0/2     unassigned      YES unset  up                    up",
];

const COMMAND_OUTPUTS: Record<string, string> = {
  "show running-config": `${SHOW_RUNNING.join("\n")}\n`,
  "show version": `${SHOW_VERSION.join("\n")}\n`,
  "show ip interface brief": `${SHOW_IP_BRIEF.join("\n")}\n`,
};

const COMMAND_ALLOWLIST = new Set(Object.keys(COMMAND_OUTPUTS));

export async function startIosSshHarness(
  opts: HarnessOptions = {},
): Promise<IOSHarness> {
  const username = opts.username ?? "netadmin";
  const password = opts.password ?? "faya-harness";
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const connections = new Set<Connection>();

  const server = new Server({ hostKeys: [hostKey] }, (ctx) => {
    connections.add(ctx);
    ctx.on("close", () => connections.delete(ctx));
    ctx.on("authentication", (auth) => {
      if (auth.method !== "password") {
        auth.reject();
        return;
      }
      if (auth.username === username && auth.password === password) {
        auth.accept();
      } else {
        auth.reject();
      }
    });
    ctx.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        const command = (info.command ?? "").trim();
        if (COMMAND_ALLOWLIST.has(command)) {
          stream.stdout.write(COMMAND_OUTPUTS[command]);
        } else {
          // Authentic IOS behavior: unknown commands print the error line
          // and the exec channel exits 0.
          stream.stdout.write("% Invalid input detected at '^' marker.\n");
        }
        stream.exit(0);
        stream.end();
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) {
          try {
            conn.end();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      }),
  };
}
