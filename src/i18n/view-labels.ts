"use client";

import { useCallback } from "react";
import { useMessages } from "next-intl";

import { getViewMeta, type NavGroup } from "@/lib/navigation/registry";
import type { ViewKey } from "@/stores/navigation";

/**
 * Localized navigation labels (Task 8-a).
 *
 * The registry (src/lib/navigation/registry.ts) stays the English source of
 * truth and declares an optional `labelKey` per entry pointing at the
 * `nav.items` namespace in messages/*.json. These hooks resolve the key at
 * render time and FALL BACK to the registry's English strings whenever the
 * key is missing from the active dictionary or the provider is absent — so
 * breadcrumbFor()/getViewMeta() consumers never break.
 */

/** View metadata with human-facing fields localized. */
export interface LocalizedViewMeta {
  title: string;
  /** Localized group display name (not the NavGroup union — a string). */
  group: string;
  description: string;
  phase: string;
}

/** Registry NavGroup (English label) → nav.groups key. */
const GROUP_KEYS: Record<NavGroup, string> = {
  Overview: "overview",
  Network: "network",
  Configurations: "configurations",
  Changes: "changes",
  Operations: "operations",
  Performance: "performance",
  Reports: "reports",
  Administration: "administration",
};

/** Minimal dotted-path getter over the plain-JSON messages tree. */
function resolveMessage(
  messages: unknown,
  path: string[]
): string | undefined {
  let current: unknown = messages;
  for (const segment of path) {
    if (
      current &&
      typeof current === "object" &&
      segment in (current as Record<string, unknown>)
    ) {
      // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop — the walked tree is the server-loaded i18n dictionary (plain-JSON messages/*.json) and the segments are INTERNAL constants from the label schema (registry labelKey paths + hardcoded nav keys), never user input; the resolved value must also land on a string leaf to be returned, so prototype keys cannot flow out.
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function resolveOr(
  messages: unknown,
  path: string[],
  fallback: string
): string {
  try {
    return resolveMessage(messages, path) ?? fallback;
  } catch {
    // Provider absent — keep the English registry label.
    return fallback;
  }
}

/**
 * Returns a resolver that maps a ViewKey to its metadata with `title` and
 * `group` localized through the nav namespace (English fallback).
 */
export function useLocalizedViewMeta(): (view: ViewKey) => LocalizedViewMeta {
  const messages = useMessages();
  return useCallback(
    (view: ViewKey) => {
      const meta = getViewMeta(view);
      const titlePath = meta.labelKey
        ? meta.labelKey.split(".")
        : ["nav", "items", ...view.split(".")];
      // Dictionaries nest the human label under a `title` leaf
      // (nav.items.network.devices.title); tolerate plain-string leaves too.
      const title =
        resolveMessage(messages, [...titlePath, "title"]) ??
        resolveMessage(messages, titlePath) ??
        meta.title;
      return {
        title,
        group: resolveOr(
          messages,
          ["nav", "groups", GROUP_KEYS[meta.group] ?? meta.group],
          meta.group
        ),
        description: meta.description,
        phase: meta.phase,
      };
    },
    [messages]
  );
}

/**
 * Sidebar group titles. Sidebar ids ("network", "operations", …) double as
 * nav.groups keys; falls back to the English label from sidebar-config.
 */
export function useLocalizedGroupLabel(): (
  groupId: string,
  fallback: string
) => string {
  const messages = useMessages();
  return useCallback(
    (groupId: string, fallback: string) =>
      resolveOr(messages, ["nav", "groups", groupId], fallback),
    [messages]
  );
}
