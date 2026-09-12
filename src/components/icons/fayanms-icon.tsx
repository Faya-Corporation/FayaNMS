import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import type { FayanmsIconName } from "@/lib/icons/types";

/**
 * Named sizes align with the design system's icon scale; numeric sizes are
 * allowed for one-off optical fits (e.g. inside dense badges).
 */
const SIZES = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 } as const;

export interface FayanmsIconProps {
  /** Registry name — the SVG file name under /icons/fayanms (no extension). */
  name: FayanmsIconName;
  size?: keyof typeof SIZES | number;
  className?: string;
  /**
   * Accessible name. When provided the glyph becomes role="img" with this
   * name as BOTH the primary `aria-label` (the accessibility-name API) and
   * the native `title` (hover affordance only — never rely on it for naming).
   * When omitted the glyph is decorative (aria-hidden) — the default, since
   * FayaNMS glyphs almost always sit next to a text label. Icon-only buttons
   * must carry their own aria-label at the control level; do not depend on
   * the icon's title to name the action.
   */
  title?: string;
  style?: CSSProperties;
}

/**
 * FayaNMS custom glyph renderer (server-safe — no hooks, no client JS).
 *
 * Implementation is CSS-mask based: the span paints `currentColor` and the
 * SVG is used as the mask, so the glyph inherits the surrounding text color
 * (perfect theme adaptation incl. dark mode) at zero JS bundle cost.
 */
export function FayanmsIcon({
  name,
  size = "md",
  className,
  title,
  style,
}: FayanmsIconProps) {
  const px = typeof size === "number" ? size : SIZES[size];
  return (
    <span
      className={cn("inline-block shrink-0 align-middle", className)}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      style={{
        width: px,
        height: px,
        backgroundColor: "currentColor",
        mask: `url(/icons/fayanms/${name}.svg) center / contain no-repeat`,
        WebkitMask: `url(/icons/fayanms/${name}.svg) center / contain no-repeat`,
        ...style,
      }}
    />
  );
}
