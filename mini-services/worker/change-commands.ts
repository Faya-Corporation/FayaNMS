/**
 * FayaNMS worker — per-flavor command TEMPLATES for controlled changes
 * (Phase 23). The single source of truth for what the worker is willing
 * to send to a live device.
 *
 * The delta is one description/comment token under one validated anchor —
 * nothing else is expressible. Every value here comes from tokens already
 * validated by live-change.ts (parseChangePlan): anchor [A-Za-z0-9._/:-],
 * slug [A-Z0-9-] (apply) / [A-Za-z0-9 ._@-] (rollback) — so the command
 * strings below can never be tricked into containing newlines, quotes, or
 * additional verbs. These templates are exercised against the persona
 * harnesses on every push (certify.ts, controlled-change section).
 */

import type { ChangePlan } from "./live-change";

class TemplateError extends Error {
  constructor(vendor: string) {
    super(`No controlled-change command template for vendor "${vendor}"`);
    this.name = "TemplateError";
  }
}

/** Wrap the description token per flavor (FortiOS/sets want quotes). */
function quoted(value: string): string {
  return `"${value}"`;
}

/**
 * Build the vendor command list for a validated plan.
 * APPLY → set the description to the slug.
 * ROLLBACK → restore the original description, or remove the line when
 * the anchor carried none (slug === null).
 */
export function buildChangeCommands(vendor: string, plan: ChangePlan): string[] {
  const key = (vendor ?? "").trim().toLowerCase();
  const { kind, anchor, slug } = plan;

  switch (key) {
    case "cisco": {
      // IOS/IOS-XE: interface subcommand mode; explicit save to NVRAM.
      const description = kind === "APPLY" ? `description ${slug}` : slug ? `description ${slug}` : "no description";
      return [
        "configure terminal",
        `interface ${anchor}`,
        description,
        "end",
        "write memory",
      ];
    }
    case "fortinet": {
      // FortiOS: hierarchical edit blocks; `end` commits the VDOM config.
      const setLine = kind === "APPLY" || slug ? `set description ${quoted(slug ?? "")}` : "unset description";
      return [
        "config system interface",
        `edit ${quoted(anchor)}`,
        setLine,
        "next",
        "end",
      ];
    }
    case "hpe": {
      // AOS-CX: same shape as IOS.
      const description = kind === "APPLY" || slug ? `description ${slug}` : "no description";
      return ["configure", `interface ${anchor}`, description, "end", "write memory"];
    }
    case "juniper": {
      // Junos: set/delete under configure; commit atomically and leave.
      const setLine =
        kind === "APPLY" || slug
          ? `set interfaces ${anchor} description ${quoted(slug ?? "")}`
          : `delete interfaces ${anchor} description`;
      return ["configure", setLine, "commit and-quit"];
    }
    case "palo": {
      // PAN-OS: interface comments via set/delete; explicit commit.
      const setLine =
        kind === "APPLY" || slug
          ? `set network interface ethernet ${anchor} comment ${quoted(slug ?? "")}`
          : `delete network interface ethernet ${anchor} comment`;
      return ["configure", setLine, "commit", "exit"];
    }
    default:
      throw new TemplateError(vendor);
  }
}
