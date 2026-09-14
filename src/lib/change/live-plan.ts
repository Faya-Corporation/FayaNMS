/**
 * FayaNMS — live-device change planning (Phase 23, app-side half).
 *
 * The change engine (src/app/api/v1/worker/change-step) routes LIVE_SSH
 * devices through the worker's controlled-change plane. The WORKER builds
 * the commands (live-change.ts + change-commands.ts) — the app only:
 *   1. derives the sanitized description token from the change title
 *      (the same slug rule the simulator plane applies);
 *   2. extracts the ANCHOR (interface/interface-path token) and the
 *      ORIGINAL description from the pre-change snapshot so the plan is
 *      deterministic and reversible;
 *   3. builds the post-change marker the VALIDATE step asserts against a
 *      real re-fetch.
 *
 * Pure functions only — no worker calls, no DB. The worker re-validates
 * every token it receives (parseChangePlan) and never accepts command
 * text, so these helpers cannot inject anything into a device.
 */

/** vendor code → configFlavor for the certified live vendors (live-ssh.ts). */
export const VENDOR_CONFIG_FLAVORS: Record<string, string> = {
  cisco: "cisco-ios",
  fortinet: "fortios",
  hpe: "aos-cx",
  juniper: "junos",
  palo: "panos",
};

/* ─────────── SAFE-007: typed operation kind + live-restore guard ─────────── */

/** Typed executable intent for a ChangeRequest (ChangeRequest.operationKind). */
export const CHANGE_OPERATION_KINDS = ["GENERIC", "RESTORE_SNAPSHOT"] as const;
export type ChangeOperationKind = (typeof CHANGE_OPERATION_KINDS)[number];

/**
 * Engine refusal for restore-flow changes on the LIVE plane (SAFE-007/008).
 * Since SAFE-008 the simulator plane commits the approved snapshot EXACTLY
 * (sha-verified echo), but the live SSH transport's certified surface is
 * bounded description-marker deltas only — a full-config push against real
 * vendor hardware is NOT vendor-certified. A restore change over LIVE_SSH
 * devices is therefore still refused fail-closed BEFORE any device contact;
 * refusing stays truthful until the per-flavor full-config certification
 * ships (a separate gate — do not widen the transport silently).
 */
export const LIVE_RESTORE_NOT_CERTIFIED =
  "LIVE_RESTORE_NOT_CERTIFIED — snapshot-exact restore is implemented on the simulator plane only " +
  "(SAFE-008/009); the live SSH transport is certified for bounded description-marker deltas, not " +
  "full-config restores, so restore-flow changes are refused fail-closed; no device was contacted";

/**
 * Whether a change carries the restore-snapshot operation intent. GENERIC
 * (null/undefined/unknown included) never blocks — the guard requires the
 * explicitly stamped kind so legacy rows keep executing exactly as before.
 */
export function isRestoreOperation(
  operationKind: string | null | undefined
): boolean {
  return (operationKind ?? "GENERIC") === "RESTORE_SNAPSHOT";
}

/**
 * Sanitized change slug — mirrors the worker simulator's changeSlug rule
 * (uppercase kebab, ≤48 chars) so simulator and live deltas stay uniform
 * and the worker's SLUG_RE validation always passes.
 */
export function changeSlugFromTitle(title: string): string {
  return (
    (title ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "CONFIG-UPDATE"
  );
}

/**
 * Extract the anchor token (first interface of the flavor) from the raw
 * pre-change config. null ⇒ the engine refuses to apply blind — the
 * change step fails closed.
 */
export function extractLiveAnchor(configFlavor: string, rawText: string): string | null {
  switch (configFlavor) {
    case "cisco-ios":
    case "aos-cx": {
      const match = /^\s*interface (\S+)\s*$/m.exec(rawText);
      return match ? match[1] : null;
    }
    case "fortios": {
      // The first edit block INSIDE config system interface (not router
      // static / firewall policy / snmp community).
      const block = /config system interface\s*\n\s*edit "([^"]+)"/.exec(rawText);
      if (block) return block[1];
      return null;
    }
    case "junos": {
      // Column-0 `interfaces {` (top-level — the security-zone sub-blocks
      // are indented and must not match), then the first 4-space name.
      const blockStart = rawText.search(/^interfaces \{\s*$/m);
      if (blockStart < 0) {
        const setStyle = /^set interfaces (\S+)/m.exec(rawText);
        return setStyle ? setStyle[1] : null;
      }
      const after = rawText.slice(blockStart);
      const name = /^ {4}([\w/:-]+) \{/m.exec(after);
      return name ? name[1] : null;
    }
    case "panos": {
      const match = /^set network interface ethernet (\S+) /m.exec(rawText);
      return match ? match[1] : null;
    }
    default:
      return null;
  }
}

/**
 * Extract the anchor's CURRENT description (for the rollback plan).
 * null ⇒ the anchor carried none — the rollback removes the line.
 * Unextractable anchors surface as a sentinel so the engine can skip the
 * device's rollback instead of pushing a removal against nothing.
 */
export const LIVE_NO_ANCHOR = "\u0000no-anchor";

export function extractOriginalDescription(
  configFlavor: string,
  rawText: string,
  anchor: string,
): string | null {
  const lines = rawText.replace(/\s+$/, "").split("\n");
  switch (configFlavor) {
    case "cisco-ios":
    case "aos-cx": {
      const idx = lines.findIndex((l) => l.trim() === `interface ${anchor}`);
      if (idx < 0) return LIVE_NO_ANCHOR;
      for (let i = idx + 1; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (t.startsWith("interface ") || t === "!" || t === "#" || t === "end") break;
        const description = /^description (.+)$/.exec(t);
        if (description) return description[1].trim();
      }
      return null;
    }
    case "fortios": {
      const idx = lines.findIndex((l) => l.trim() === `edit "${anchor}"`);
      if (idx < 0) return LIVE_NO_ANCHOR;
      for (let i = idx + 1; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (t === "next" || t === "end" || t.startsWith('edit "')) break;
        const description = /^set description "(.*)" *$/.exec(t);
        if (description) return description[1].trim();
      }
      return null;
    }
    case "junos": {
      // Set-style first (some devices return | display set), hierarchical
      // otherwise.
      const setStyle = new RegExp(`^set interfaces ${escapeRegExp(anchor)} description (.+?);?\\s*$`, "m").exec(rawText);
      if (setStyle) return setStyle[1].trim().replace(/^"|"$/g, "");
      const blockStart = lines.findIndex((l) => l === "interfaces {");
      if (blockStart < 0) return LIVE_NO_ANCHOR;
      const idx = lines.findIndex(
        (l, i) => i > blockStart && l.trim() === `${anchor} {`,
      );
      if (idx < 0) return LIVE_NO_ANCHOR;
      for (let i = idx + 1; i < lines.length; i += 1) {
        if (/^ {4}\S/.test(lines[i])) break; // next sibling / block close
        const description = /^description (.*?);\s*$/.exec(lines[i].trim());
        if (description) return description[1].trim();
      }
      return null;
    }
    case "panos": {
      const match = new RegExp(
        `^set network interface ethernet ${escapeRegExp(anchor)} comment "(.*)" *$`,
        "m",
      ).exec(rawText);
      if (match) return match[1].trim();
      // No comment line at all is a legitimate "none" — but only when the
      // interface exists at all.
      return new RegExp(`^set network interface ethernet ${escapeRegExp(anchor)} `, "m").test(rawText)
        ? null
        : LIVE_NO_ANCHOR;
    }
    default:
      return LIVE_NO_ANCHOR;
  }
}

/**
 * The normalized-config marker the VALIDATE step asserts after a real
 * re-fetch: the applied description must be present in the running config.
 */
export function expectedDescriptionMarker(configFlavor: string, slug: string): string {
  switch (configFlavor) {
    case "fortios":
      return `set description "${slug}"`;
    case "panos":
      return `comment "${slug}"`;
    case "junos":
      return `description ${slug};`;
    default:
      return `description ${slug}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
