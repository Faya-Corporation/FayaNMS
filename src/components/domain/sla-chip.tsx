"use client";

import { cn } from "@/lib/utils";
import { formatSlaCountdown } from "@/lib/incidents/lifecycle";
import type { IncidentSlaState } from "@/lib/api-client";

/**
 * SLA chip (Task 5-b): renders the computed incident SLA state.
 *  - open:      countdown coloring — green >50% of the window remaining,
 *               amber ≤50%, red when breached; shows the due-in countdown.
 *  - resolved:  MET (success) / BREACHED (danger) pill.
 *  - untracked: neutral "No SLA".
 */
export function SlaChip({
  sla,
  className,
}: {
  sla: IncidentSlaState;
  className?: string;
}) {
  if (!sla.tracked) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-full border border-neutral/25 bg-neutral-subtle px-2 py-0.5 text-[11px] font-medium text-neutral",
          className
        )}
      >
        No SLA
      </span>
    );
  }

  if (sla.outcome) {
    const met = sla.outcome === "MET";
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
          met
            ? "border-success/25 bg-success-subtle text-success"
            : "border-danger/25 bg-danger-subtle text-danger",
          className
        )}
      >
        SLA {sla.outcome === "MET" ? "met" : "breached"}
      </span>
    );
  }

  const breached = sla.breached;
  const low = !breached && (sla.remainingPct ?? 0) <= 50;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
        breached
          ? "border-danger/25 bg-danger-subtle text-danger"
          : low
            ? "border-warning/25 bg-warning-subtle text-warning"
            : "border-success/25 bg-success-subtle text-success",
        className
      )}
      title={`${sla.targetLabel ?? "SLA"} — ${breached ? "breached" : `${sla.remainingPct ?? 0}% of the window remaining`}`}
    >
      {breached ? "Breached" : formatSlaCountdown(sla.dueInMs ?? 0)}
    </span>
  );
}
