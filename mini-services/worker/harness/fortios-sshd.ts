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
 *
 * Shell surface (Phase 23 controlled-change plane): FortiOS hierarchical
 * CLI (config system interface → edit → set description → next → end).
 * `set description` MUTATES the persona config so a post-apply fetch
 * reflects the delta.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED DEVICE PERSONA                                  │
 * │ The config text below (including the demo SNMP community name           │
 * │ "faya-readonly") is INVENTED persona content for the LIVE_SSH           │
 * │ certification harness — not real device secrets. Pinned by              │
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

const COMMAND_OUTPUTS: Record<string, string | (() => string)> = {
  "show full-configuration": FORTIOS_SHOW_FULL_CONFIG,
  "get system status": FORTIOS_GET_SYSTEM_STATUS,
};

/* ─────────────── Phase 23: interactive config-mode shell ─────────────── */

type FortiosMode = "root" | "interface" | "edit";

interface FortiosShellState {
  mode: FortiosMode;
  editName: string;
  body: string;
}

/**
 * Insert/replace/remove `set description "<value>"` inside the given edit
 * block (only blocks under `config system interface` are considered).
 */
export function setFortiosInterfaceDescription(
  body: string,
  editName: string,
  description: string | null,
): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const blockStart = lines.findIndex((l) => l.trim() === "config system interface");
  if (blockStart < 0) return body;
  const start = lines.findIndex(
    (l, i) => i > blockStart && l.trim() === `edit "${editName}"`,
  );
  if (start < 0) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === "next" || t === "end" || t.startsWith('edit "')) {
      end = i;
      break;
    }
  }
  let descIdx = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith("set description ")) {
      descIdx = i;
      break;
    }
  }
  const next = description === null ? null : `        set description "${description}"`;
  if (descIdx >= 0) {
    if (next) lines[descIdx] = next;
    else lines.splice(descIdx, 1);
  } else if (next) {
    // Insert directly before the block's terminating line (next/end).
    lines.splice(end, 0, next);
  }
  return `${lines.join("\n")}\n`;
}

function fortiosShell(): { state: FortiosShellState; shell: PersonaHarnessOptions["shell"] } {
  const state: FortiosShellState = {
    mode: "root",
    editName: "",
    body: FORTIOS_SHOW_FULL_CONFIG,
  };
  COMMAND_OUTPUTS["show full-configuration"] = () => state.body;
  const shell = {
    prompt: () =>
      state.mode === "root"
        ? "HARNESS-FTG-01 # "
        : state.mode === "interface"
          ? "HARNESS-FTG-01 (interface) # "
          : "HARNESS-FTG-01 (interface) # ",
    handle: (line: string) => {
      const cmd = line.trim();
      if (state.mode === "root") {
        if (cmd === "config system interface") {
          state.mode = "interface";
          return {};
        }
        if (cmd === "end") return {};
        return { error: true };
      }
      if (state.mode === "interface") {
        const match = /^edit "([^"]+)"$/.exec(cmd);
        if (match) {
          state.mode = "edit";
          state.editName = match[1];
          return {};
        }
        if (cmd === "end") {
          state.mode = "root";
          return {};
        }
        return { error: true };
      }
      const description = /^set description "(.*)" *$/.exec(cmd);
      if (description) {
        state.body = setFortiosInterfaceDescription(
          state.body,
          state.editName,
          description[1].trim(),
        );
        return {};
      }
      if (cmd === "unset description") {
        state.body = setFortiosInterfaceDescription(state.body, state.editName, null);
        return {};
      }
      if (cmd === "next") {
        state.mode = "interface";
        return {};
      }
      if (cmd === "end") {
        state.mode = "root";
        return {};
      }
      if (cmd === "abort") {
        state.mode = "interface";
        return {};
      }
      return { error: true };
    },
  };
  return { state, shell };
}

export async function startFortiosSshHarness(
  opts: HarnessOptions = {},
): Promise<FortiosHarness> {
  const { shell } = fortiosShell();
  const personaOpts: PersonaHarnessOptions = {
    ...opts,
    commands: COMMAND_OUTPUTS,
    shell,
    // Authentic FortiGate CLI behavior for an unrecognized command.
    invalidCommandLine: "Command fail. Return code -3\n",
  };
  return startPersonaSshHarness(personaOpts);
}
