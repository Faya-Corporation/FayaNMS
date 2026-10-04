/**
 * FayaNMS LIVE_SSH certification harness — Juniper Junos OS persona.
 *
 * A REAL SSH server (via persona-sshd.ts) wearing a Junos OS persona:
 * genuine SSH protocol, only the CLI text simulated. Mirrors the
 * live-ssh.ts juniper allowlist (`show configuration` — hierarchical
 * curly-brace body, same style as the simulator's juniper-junos adapter).
 *
 * Exec surface (read-only):
 *   show configuration | show version
 * Anything else answers the authentic Junos CLI error line and exits 0.
 *
 * Shell surface (Phase 23 controlled-change plane): Junos CLI
 * (configure → set interfaces description → commit and-quit);
 * `set interfaces … description` MUTATES the persona config so a
 * post-apply fetch reflects the delta.
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

export type JunosHarness = PersonaHarness;

export const JUNOS_SHOW_VERSION = personaOutput([
  "Hostname: HARNESS-JN-01",
  "Model: srx1500",
  "Junos: 21.4R3-S4.9",
  "JUNOS OS Kernel 64-bit  [2026-01-19 08:44:21 UTC]",
  "JUNOS OS Crypto 64-bit [2026-01-19 08:44:21 UTC]",
  "JUNOS packet forwarding engine support (dims) [2026-01-19 08:44:21 UTC]",
  "",
  "  Uptime: 25d 04:12:44",
]);

/**
 * Hierarchical running configuration (show-configuration style). The
 * interfaces block is deliberately the simulator's layout: `interfaces {`
 * at column 0, interface names at 4-space indent with ` {` — the exact
 * shape the app-side anchor extractor (live-plan.ts) parses.
 */
export const JUNOS_SHOW_CONFIGURATION = personaOutput([
  "version 21.4R3-S4.9;",
  "system {",
  "    host-name HARNESS-JN-01;",
  "    time-zone Asia/Aden;",
  "    login {",
  "        user netadmin {",
  "            class super-user;",
  "        }",
  "    }",
  "    services {",
  "        ssh {",
  "            protocol-version v2;",
  "        }",
  "    }",
  "}",
  "interfaces {",
  "    ge-0/0/0 {",
  "        description WAN-UPLINK-ISP-A;",
  "        unit 0 {",
  "            family inet {",
  "                address 185.20.10.2/30;",
  "            }",
  "        }",
  "    }",
  "    ge-0/0/1 {",
  "        description LAN-CORE;",
  "        unit 0 {",
  "            family inet {",
  "                address 10.20.60.1/24;",
  "            }",
  "        }",
  "    }",
  "    ge-0/0/3 {",
  "        description RESERVED-SPARE;",
  "        disable;",
  "        unit 0 {",
  "            family inet;",
  "        }",
  "    }",
  "    fxp0 {",
  "        description OOB-MANAGEMENT;",
  "        unit 0 {",
  "            family inet {",
  "                address 10.20.255.12/24;",
  "            }",
  "        }",
  "    }",
  "}",
  "routing-options {",
  "    static {",
  "        route 0.0.0.0/0 next-hop 10.20.254.1;",
  "    }",
  "}",
  "protocols {",
  "    bgp {",
  "        group TRANSIT {",
  "            type external;",
  "            description TRANSIT-PEER;",
  "            peer-as 65010;",
  "            neighbor 185.20.10.1;",
  "        }",
  "    }",
  "}",
  "security {",
  "    zones {",
  "        security-zone TRUST {",
  "            interfaces {",
  "                ge-0/0/1.0;",
  "            }",
  "        }",
  "        security-zone UNTRUST {",
  "            interfaces {",
  "                ge-0/0/0.0;",
  "            }",
  "        }",
  "    }",
  "    policies {",
  "        from-zone TRUST to-zone UNTRUST {",
  "            policy ALLOW-OUTBOUND {",
  "                match {",
  "                    source-address any;",
  "                    destination-address any;",
  "                    application any;",
  "                }",
  "                then {",
  "                    permit;",
  "                }",
  "            }",
  "        }",
  "    }",
  "}",
  "snmp {",
  "    community FayaRO {",
  "        authorization read-only;",
  "    }",
  '    location "HQ-Sanaa-MDF";',
  '    contact "NOC <noc@faya.local>";',
  "}",
]);

const COMMAND_OUTPUTS: Record<string, string | (() => string)> = {
  "show configuration": JUNOS_SHOW_CONFIGURATION,
  "show version": JUNOS_SHOW_VERSION,
};

/* ─────────────── Phase 23: interactive config-mode shell ─────────────── */

type JunosMode = "op" | "config";

interface JunosShellState {
  mode: JunosMode;
  body: string;
}

/** Insert/replace/remove `description <value>;` inside one interface block. */
export function setJunosInterfaceDescription(
  body: string,
  ifName: string,
  description: string | null,
): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const blockStart = lines.findIndex((l) => l === "interfaces {");
  if (blockStart < 0) return body;
  const start = lines.findIndex(
    (l, i) => i > blockStart && l.trim() === `${ifName} {`,
  );
  if (start < 0) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // Next sibling block (4-space indent) or the interfaces block close.
    if (/^    \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let descIdx = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith("description ")) {
      descIdx = i;
      break;
    }
  }
  const next = description === null ? null : `        description ${description};`;
  if (descIdx >= 0) {
    if (next) lines[descIdx] = next;
    else lines.splice(descIdx, 1);
  } else if (next) {
    lines.splice(start + 1, 0, next);
  }
  return `${lines.join("\n")}\n`;
}

function junosShell(): { state: JunosShellState; shell: PersonaHarnessOptions["shell"] } {
  const state: JunosShellState = {
    mode: "op",
    body: JUNOS_SHOW_CONFIGURATION,
  };
  COMMAND_OUTPUTS["show configuration"] = () => state.body;
  const shell = {
    prompt: () => (state.mode === "op" ? "netadmin@HARNESS-JN-01> " : "netadmin@HARNESS-JN-01# "),
    handle: (line: string) => {
      const cmd = line.trim();
      if (state.mode === "op") {
        if (cmd === "configure") {
          state.mode = "config";
          return { output: "Entering configuration mode\n" };
        }
        if (cmd === "show configuration") return { output: state.body };
        return { error: true };
      }
      const set = /^set interfaces (\S+) description "(.*)" *$/.exec(cmd);
      if (set) {
        state.body = setJunosInterfaceDescription(state.body, set[1], set[2].trim());
        return {};
      }
      const del = /^delete interfaces (\S+) description$/.exec(cmd);
      if (del) {
        state.body = setJunosInterfaceDescription(state.body, del[1], null);
        return {};
      }
      if (cmd === "commit and-quit") {
        state.mode = "op";
        return { output: "commit complete\nExiting configuration mode\n" };
      }
      if (cmd === "show configuration") return { output: state.body };
      return { error: true };
    },
  };
  return { state, shell };
}

export async function startJunosSshHarness(
  opts: HarnessOptions = {},
): Promise<JunosHarness> {
  const { shell } = junosShell();
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    shell,
    // Authentic Junos CLI behavior for an unrecognized command.
    invalidCommandLine: "syntax error.\n",
  };
  return startPersonaSshHarness(personaOpts);
}
