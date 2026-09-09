"use client";

import { X } from "lucide-react";

import { cn } from "@/lib/utils";

interface FilterChipProps {
  /** Filter field, e.g. "Vendor". */
  label: string;
  /** Filter value, e.g. "Cisco". */
  value: string;
  onRemove?: () => void;
  className?: string;
}

/** Removable active-filter chip rendered as "Vendor: Cisco ×". */
export function FilterChip({ label, value, onRemove, className }: FilterChipProps) {
  const removeLabel = `Remove filter ${label}: ${value}`;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card py-1 pe-1 ps-2 text-xs shadow-xs",
        className
      )}
    >
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="max-w-[24ch] truncate font-medium text-foreground" title={value}>
        {value}
      </span>
      {onRemove && (
        <button
          aria-label={removeLabel}
          className="relative rounded-sm p-0.5 text-muted-foreground transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-muted hover:text-foreground"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  );
}
