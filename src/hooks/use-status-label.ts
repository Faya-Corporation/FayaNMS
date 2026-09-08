"use client";

import { useCallback } from "react";

import { useTranslations } from "next-intl";

import type { StatusBadgeConfig } from "@/lib/domain/status";

/**
 * Resolves a StatusBadgeConfig's display label in the active locale.
 *
 * Configs built by src/lib/domain/status.ts carry a `labelKey` pointing
 * into the "status" namespace (e.g. "status.device.ONLINE"); the English
 * `label` remains the canonical fallback, so server-side consumers and any
 * configs without a labelKey (src/components/views/status-extras.ts) keep
 * rendering English. The translator is rooted at the MESSAGES root (no
 * namespace argument) because labelKey already includes the "status."
 * prefix — with `useTranslations("status")` the key would be resolved
 * relative to that namespace (status.status.*) and always miss. `t.has()`
 * returns false without logging when the key (or the whole namespace) is
 * missing, and the try/catch is a final safety net — a dropped namespace
 * can never throw during render. The resolver is memoized with useCallback
 * (t is stable per locale/messages) so views that call it inside useMemo
 * (filter chips, chart data) keep their memoization intact.
 */
export function useStatusLabel() {
  const t = useTranslations();
  return useCallback(
    (config: StatusBadgeConfig): string => {
      try {
        if (config.labelKey && t.has(config.labelKey)) {
          return t(config.labelKey);
        }
      } catch {
        /* missing namespace → fall through to the English label */
      }
      return config.label;
    },
    [t]
  );
}
