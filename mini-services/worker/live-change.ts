/**
 * FayaNMS worker — CONTROLLED change plane for live devices (Phase 23).
 *
 * This module is the ONLY code path that can mutate a live device, and it
 * is deliberately narrow:
 *
 *   1.  The APP can never send commands. The change engine sends a PLAN —
 *       { kind, anchor, slug } — where every field is a validated token
 *       (no whitespace tricks, no newlines, no quotes). The command list
 *       is built HERE, worker-side, from per-flavor templates. Arbitrary
 *       command injection from the control plane is structurally
 *       impossible.
 *   2.  The delta is a single, low-risk, fully reversible line: a
 *       description/comment under the anchor interface (or its removal on
 *       rollback). Nothing else is expressible — no reload/reboot/erase
 *       verb even exists in the template space.
 *   3.  Execution goes through the bounded CLI session driver
 *       (sshCliSession) with stop-on-first-rejection: a rejected
 *       configuration command aborts the plan instead of pushing a
 *       half-valid stack. The change engine owns recovery (rollback).
 *
 * Certified against the in-repo persona harnesses (REAL SSH servers with
 * config-mode shells that MUTATE their running-config, so a post-apply
 * fetch reflects the delta). Hardware certification stays open — README
 * honest-status block.
 */

import { buildChangeCommands } from "./change-commands";
import { sshCliSession, type CliCommandResult, type CliSessionSpec } from "./ssh-transport";
import { resolveLiveSshFlavor } from "./live-ssh";
import type { SshCredentials } from "./ssh-transport";

export class LiveChangeError extends Error {
  constructor(
    public readonly code: "PLAN_INVALID" | "FLAVOR_NOT_CHANGEABLE",
    message: string,
  ) {
    super(message);
    this.name = "LiveChangeError";
  }
}

/** Anchor token: interface names like GigabitEthernet0/1, ge-0/0/1, ethernet1/1, 1/1/1. */
const ANCHOR_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,63}$/;
/** Description set by FayaNMS (derived from the change title, kebab). */
const SLUG_RE = /^[A-Z0-9][A-Z0-9-]{0,47}$/;
/** Description being RESTORED (may be any pre-existing value we accept). */
const ORIGINAL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;

export type ChangePlanKind = "APPLY" | "ROLLBACK";

export interface ChangePlan {
  kind: ChangePlanKind;
  /** validated anchor token (interface / interface-path on the device) */
  anchor: string;
  /** validated description token — null removes the description (rollback of none) */
  slug: string | null;
}

/**
 * Parse + validate the plan carried in the /live/apply body. Throws
 * LiveChangeError(PLAN_INVALID) BEFORE any connection is attempted — a
 * malformed plan can never reach a device.
 */
export function parseChangePlan(raw: unknown): ChangePlan {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LiveChangeError(
      "PLAN_INVALID",
      "plan must be an object { kind: \"APPLY\"|\"ROLLBACK\", anchor: string, slug: string|null } — the worker builds the commands itself; the control plane can never send command text",
    );
  }
  const plan = raw as Record<string, unknown>;
  const kind = typeof plan.kind === "string" ? plan.kind.trim().toUpperCase() : "";
  if (kind !== "APPLY" && kind !== "ROLLBACK") {
    throw new LiveChangeError(
      "PLAN_INVALID",
      `plan.kind must be "APPLY" or "ROLLBACK" (received "${kind || String(plan.kind)}")`,
    );
  }
  const anchor = typeof plan.anchor === "string" ? plan.anchor.trim() : "";
  if (!anchor || !ANCHOR_RE.test(anchor)) {
    throw new LiveChangeError(
      "PLAN_INVALID",
      `plan.anchor is not a validated interface token: ${JSON.stringify(
        String(plan.anchor ?? ""),
      ).slice(0, 80)}`,
    );
  }
  let slug: string | null;
  if (plan.slug === null || plan.slug === undefined) {
    slug = null;
  } else if (typeof plan.slug === "string" && plan.slug.trim()) {
    const candidate = plan.slug.trim();
    // APPLY slugs are engine-generated kebab tokens; ROLLBACK slugs are
    // restored originals (slightly wider charset, still quote-free).
    slug = kind === "APPLY" ? candidate.toUpperCase() : candidate;
    const pattern = kind === "APPLY" ? SLUG_RE : ORIGINAL_RE;
    if (!pattern.test(slug)) {
      throw new LiveChangeError(
        "PLAN_INVALID",
        `plan.slug (${kind}) is not a validated description token: ${JSON.stringify(
          candidate,
        ).slice(0, 80)}`,
      );
    }
  } else {
    throw new LiveChangeError(
      "PLAN_INVALID",
      "plan.slug must be a non-empty string or null (null = remove the description)",
    );
  }
  return { kind, anchor, slug };
}

/**
 * Per-vendor CLI session contract + change-ability. Mirrors the certified
 * read-only flavors (live-ssh.ts) 1:1 — a vendor is changeable iff it is
 * certified read-only first.
 */
export interface LiveChangeFlavor {
  adapter: string;
  configFlavor: string;
  session: CliSessionSpec;
  notes: string;
}

export const LIVE_CHANGE_FLAVORS: Record<string, LiveChangeFlavor> = {
  cisco: {
    adapter: "cisco-ios-live",
    configFlavor: "cisco-ios",
    // Prompt: "CORE-01#" / "CORE-01(config)#" / "CORE-01(config-if)#".
    session: {
      promptPattern: /[\w.)-]{2,}[#>]\s*$/,
      errorPatterns: [
        /% Invalid input/,
        /% Ambiguous command/,
        /% Incomplete command/,
        /% Invalid command/,
      ],
    },
    notes:
      "Cisco IOS/IOS-XE controlled change (configure terminal → interface → description → end → write memory).",
  },
  fortinet: {
    adapter: "fortinet-fortios-live",
    configFlavor: "fortios",
    // Prompt: "FGT-01 # " / "FGT-01 (interface) # ".
    session: {
      promptPattern: / #\s*$/,
      errorPatterns: [/Command fail/, /command parse error/, /Unknown action/],
    },
    notes:
      "Fortinet FortiOS controlled change (config system interface → edit → set description → next → end).",
  },
  hpe: {
    adapter: "hpe-aos-cx-live",
    configFlavor: "aos-cx",
    // Prompt: "SW-01#" / "SW-01(config)#" / "SW-01(config-if)#".
    session: {
      promptPattern: /[\w.)-]{2,}#\s*$/,
      errorPatterns: [/% Invalid input/, /% Ambiguous keyword/],
    },
    notes:
      "HPE Aruba AOS-CX controlled change (configure → interface → description → end → write memory).",
  },
  juniper: {
    adapter: "juniper-junos-live",
    configFlavor: "junos",
    // Prompt: "netadmin@JN-01> " / "netadmin@JN-01# ".
    session: {
      promptPattern: /@[\w.-]+[#>]\s*$/,
      errorPatterns: [/syntax error/, /error: /, /unknown command/],
    },
    notes:
      "Juniper Junos OS controlled change (configure → set interfaces description → commit and-quit).",
  },
  palo: {
    adapter: "palo-panos-live",
    configFlavor: "panos",
    // Prompt: "netadmin@PA-01> " (op mode) / "netadmin@PA-01# " (config mode).
    session: {
      promptPattern: /@[\w.-]+[>#]\s*$/,
      errorPatterns: [/Invalid syntax/, /unknown command/],
    },
    notes:
      "Palo Alto PAN-OS controlled change (configure → set interface comment → commit → exit).",
  },
};

/** A vendor is changeable iff it is certified (read-only first) AND change-registered. */
export function resolveLiveChangeFlavor(vendor: string): LiveChangeFlavor {
  const key = (vendor ?? "").trim().toLowerCase();
  const flavor = LIVE_CHANGE_FLAVORS[key];
  if (!flavor) {
    // Distinguish "not certified at all" from "certified read-only but no
    // change plane yet" — both fail closed, with different guidance.
    resolveLiveSshFlavor(vendor); // throws FLAVOR_UNSUPPORTED when uncertified
    throw new LiveChangeError(
      "FLAVOR_NOT_CHANGEABLE",
      `Vendor "${vendor}" is certified read-only but has no controlled-change plane yet (changeable: ${Object.keys(
        LIVE_CHANGE_FLAVORS,
      ).join(", ")})`,
    );
  }
  return flavor;
}

export interface LiveChangeResult {
  adapter: string;
  configFlavor: string;
  plan: ChangePlan;
  commands: string[];
  results: CliCommandResult[];
  /** true iff every executed command was accepted by the device CLI */
  applied: boolean;
}

/**
 * Execute a validated plan against a live device over the bounded CLI
 * session. Commands are built HERE from the per-flavor templates
 * (change-commands.ts) — the caller only ever passed tokens.
 */
export async function applyLiveChangePlan(
  vendor: string,
  creds: SshCredentials,
  plan: ChangePlan,
): Promise<LiveChangeResult> {
  const flavor = resolveLiveChangeFlavor(vendor);
  const commands = buildChangeCommands(vendor, plan);
  const results = await sshCliSession(creds, commands, flavor.session, 25_000);
  return {
    adapter: flavor.adapter,
    configFlavor: flavor.configFlavor,
    plan,
    commands,
    results,
    applied: results.every((r) => r.ok),
  };
}
