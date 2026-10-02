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
 *
 * Shell surface (Phase 23 controlled-change plane): AOS-CX CLI
 * (configure → interface → description → end → write memory);
 * `description` MUTATES the persona config so a post-apply fetch reflects
 * the delta.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED DEVICE PERSONA                                  │
 * │ The config text below (including the demo SNMP community                │
 * │ faya-readonly and the demo password-ciphertext value) is INVENTED       │
 * │ persona content for the LIVE_SSH certification harness — not real       │
 * │ device secrets. Pinned by tests/audit/open-findings-batch-19.test.ts    │
 * │ (F-045 grep-guard).                                                     │
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

const COMMAND_OUTPUTS: Record<string, string | (() => string)> = {
  "show running-config": AOSCX_SHOW_RUNNING,
  "show version": AOSCX_SHOW_VERSION,
};

/* ─────────────── Phase 23: interactive config-mode shell ─────────────── */

type AosCxMode = "exec" | "config" | "config-if";

interface AosCxShellState {
  mode: AosCxMode;
  ifName: string;
  body: string;
}

/** Insert/replace/remove `description <value>` inside one interface block. */
export function setAosCxInterfaceDescription(
  body: string,
  ifName: string,
  description: string | null,
): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const idx = lines.findIndex((l) => l.trim() === `interface ${ifName}`);
  if (idx < 0) return body;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith("interface ") || t === "!") {
      end = i;
      break;
    }
  }
  let descIdx = -1;
  for (let i = idx + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith("description ")) {
      descIdx = i;
      break;
    }
  }
  const next = description === null ? null : `   description ${description}`;
  if (descIdx >= 0) {
    if (next) lines[descIdx] = next;
    else lines.splice(descIdx, 1);
  } else if (next) {
    lines.splice(idx + 1, 0, next);
  }
  return `${lines.join("\n")}\n`;
}

function aosCxShell(): {
  state: AosCxShellState;
  shell: PersonaHarnessOptions["shell"];
} {
  const state: AosCxShellState = {
    mode: "exec",
    ifName: "",
    body: AOSCX_SHOW_RUNNING,
  };
  COMMAND_OUTPUTS["show running-config"] = () => state.body;
  const shell = {
    prompt: () =>
      state.mode === "exec"
        ? "HARNESS-CX-01#"
        : state.mode === "config"
          ? "HARNESS-CX-01(config)#"
          : `HARNESS-CX-01(config-if)#`,
    handle: (line: string) => {
      const cmd = line.trim();
      if (state.mode === "exec") {
        if (cmd === "configure") {
          state.mode = "config";
          return {};
        }
        if (cmd === "write memory") return { output: "Copying configuration... [OK]\n" };
        if (cmd === "end" || cmd === "exit") return {};
        return { error: true };
      }
      if (state.mode === "config") {
        const match = /^interface (\S+)$/.exec(cmd);
        if (match) {
          state.mode = "config-if";
          state.ifName = match[1];
          return {};
        }
        if (cmd === "end") {
          state.mode = "exec";
          return {};
        }
        return { error: true };
      }
      const description = /^description (.+)$/.exec(cmd);
      if (description) {
        state.body = setAosCxInterfaceDescription(
          state.body,
          state.ifName,
          description[1].trim(),
        );
        return {};
      }
      if (cmd === "no description") {
        state.body = setAosCxInterfaceDescription(state.body, state.ifName, null);
        return {};
      }
      if (cmd === "end") {
        state.mode = "exec";
        return {};
      }
      return { error: true };
    },
  };
  return { state, shell };
}

export async function startAosCxSshHarness(
  opts: HarnessOptions = {},
): Promise<AosCxHarness> {
  const { shell } = aosCxShell();
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    shell,
    // Authentic AOS-CX behavior for an unrecognized command.
    invalidCommandLine: "% Invalid input: unrecognized command\n",
  };
  return startPersonaSshHarness(personaOpts);
}
