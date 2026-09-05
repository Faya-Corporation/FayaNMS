import {
  Archive,
  Ban,
  BellDot,
  BellOff,
  BellRing,
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleOff,
  CircleSlash,
  CircleX,
  Clock,
  CloudOff,
  Eye,
  FileDiff,
  FilePen,
  Info,
  LoaderCircle,
  OctagonX,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Skull,
  TriangleAlert,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Registry resolving the icon names stored in src/lib/domain/status.ts
 * to lucide components. Keeps status.ts dependency-free while giving
 * domain teams a single place to render status icons.
 */
const STATUS_ICONS: Record<string, LucideIcon> = {
  Archive,
  Ban,
  BellDot,
  BellOff,
  BellRing,
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleOff,
  CircleSlash,
  CircleX,
  Clock,
  CloudOff,
  Eye,
  FileDiff,
  FilePen,
  Info,
  LoaderCircle,
  OctagonX,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Skull,
  TriangleAlert,
  Undo2,
  Wrench,
};

export function StatusIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Icon = STATUS_ICONS[icon] ?? CircleHelp;
  return <Icon aria-hidden="true" className={cn("size-3.5", className)} />;
}
