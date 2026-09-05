import { cn } from "@/lib/utils";
import type { StatusToken } from "@/lib/domain/status";

const DOT_BG: Record<StatusToken, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  "danger-orange": "bg-danger-orange",
  info: "bg-info",
  neutral: "bg-neutral",
};

interface StatusDotProps {
  /** Token color key from src/lib/domain/status.ts. */
  token?: StatusToken;
  /** Gentle pulse for running/active states. */
  pulse?: boolean;
  /** Accessible label; without it the dot is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

/**
 * Colored status dot for dense contexts (table rows, KPI strips, timelines).
 * Always pair it with a visible text label nearby — a dot is never the only
 * carrier of status meaning.
 */
export function StatusDot({
  token = "neutral",
  pulse = false,
  label,
  className,
}: StatusDotProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn("relative inline-flex size-2 shrink-0", className)}
      role={label ? "img" : undefined}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            DOT_BG[token]
          )}
        />
      )}
      <span
        aria-hidden="true"
        className={cn("relative inline-flex size-2 rounded-full", DOT_BG[token])}
      />
    </span>
  );
}
