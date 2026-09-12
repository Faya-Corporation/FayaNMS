import type { LucideIcon } from "lucide-react";

import { FayanmsIcon } from "@/components/icons/fayanms-icon";
import type { NavIcon } from "@/lib/icons/types";
import { cn } from "@/lib/utils";

export interface DomainIconProps {
  /** Governed navigation glyph union (lucide component | fayanms name). */
  icon: NavIcon;
  className?: string;
}

/**
 * Renders either side of the NavIcon union at the shared 20px nav size.
 * Lucide keeps generic controls/status chrome; FayaNMS glyphs carry domain
 * identity. Both branches inherit currentColor, so active/hover/muted
 * states keep working unchanged.
 */
export function DomainIcon({ icon, className }: DomainIconProps) {
  if (icon.kind === "lucide") {
    const Icon: LucideIcon = icon.icon;
    return <Icon className={cn("size-5 shrink-0", className)} aria-hidden="true" />;
  }
  return <FayanmsIcon className={className} name={icon.name} size={20} />;
}
