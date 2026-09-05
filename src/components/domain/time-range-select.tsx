"use client";

import { Clock } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const TIME_RANGES = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
] as const;

export type TimeRangeValue = (typeof TIME_RANGES)[number]["value"];

interface TimeRangeSelectProps {
  value: string;
  onChange: (value: TimeRangeValue) => void;
  className?: string;
  disabled?: boolean;
}

/** Shared time-range control used across dashboards and performance views. */
export function TimeRangeSelect({
  value,
  onChange,
  className,
  disabled,
}: TimeRangeSelectProps) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as TimeRangeValue)}
      value={value}
    >
      <SelectTrigger
        aria-label="Time range"
        className={cn("h-8 w-[9.5rem] gap-1.5 text-xs", className)}
        size="sm"
      >
        <Clock aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <SelectValue placeholder="Time range" />
      </SelectTrigger>
      <SelectContent>
        {TIME_RANGES.map((range) => (
          <SelectItem key={range.value} value={range.value}>
            {range.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
