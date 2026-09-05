"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

export interface TokenColors {
  primary: string;
  accent: string;
  border: string;
  mutedForeground: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  neutral: string;
}

/**
 * Light-theme hexes matching the token defaults in globals.css; used until
 * the real CSS variable values can be read from the DOM (and as fallbacks).
 */
const FALLBACK: TokenColors = {
  primary: "#2563eb",
  accent: "#0891b2",
  border: "#e5e5e5",
  mutedForeground: "#525252",
  success: "#15803d",
  warning: "#b45309",
  danger: "#dc2626",
  info: "#2563eb",
  neutral: "#737373",
};

/**
 * Resolves FayaNMS CSS token variables to concrete color strings for
 * Recharts (SVG presentation attributes cannot resolve var()). Re-reads
 * whenever the active theme changes. SSR-safe: falls back to the light
 * token hexes until mounted.
 */
export function useTokenColors(): TokenColors {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<TokenColors>(FALLBACK);

  useEffect(() => {
    // Read after paint so the theme class is applied to the document root.
    const raf = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const read = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;
      setColors({
        primary: read("--primary", FALLBACK.primary),
        accent: read("--brand-accent", FALLBACK.accent),
        border: read("--border", FALLBACK.border),
        mutedForeground: read("--muted-foreground", FALLBACK.mutedForeground),
        success: read("--success", FALLBACK.success),
        warning: read("--warning", FALLBACK.warning),
        danger: read("--danger", FALLBACK.danger),
        info: read("--info", FALLBACK.info),
        neutral: read("--neutral", FALLBACK.neutral),
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [resolvedTheme]);

  return colors;
}
