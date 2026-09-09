"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { useChanges } from "@/hooks/api/use-changes";
import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getStatusConfig, RISK_LEVEL } from "@/lib/domain/status";
import {
  lookupStatusConfig,
  CHANGE_STATUS_UI,
} from "@/components/views/status-extras";
import { useNavigationStore } from "@/stores/navigation";
import type { ChangeRow } from "@/lib/api-client";

/** Execution-window statuses shown on the calendar (planning-relevant). */
const CALENDAR_STATUSES = "APPROVED,SCHEDULED,EXECUTING,VALIDATING";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function windowOf(change: ChangeRow): { start: Date; end: Date } | null {
  if (!change.scheduledStart) return null;
  const start = new Date(change.scheduledStart);
  const end = change.scheduledEnd ? new Date(change.scheduledEnd) : start;
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: Number.isNaN(end.getTime()) ? start : end };
}

/** Overlap = start < other.end && end > other.start (same rule as the API). */
function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * Change calendar (Task 4-a): month grid with change chips on their
 * scheduledStart day, risk-colored via the RISK_LEVEL badge tokens, today
 * highlight, and a warning ring on days holding ≥2 overlapping changes.
 * Data comes from the changes list filtered server-side to the visible
 * grid's window (overlap semantics), then grouped client-side.
 */
export function ChangesCalendarView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()));

  const gridStart = useMemo(() => startOfWeek(startOfMonth(month)), [month]);
  const gridEnd = useMemo(() => endOfWeek(endOfMonth(month)), [month]);

  const changes = useChanges({
    status: CALENDAR_STATUSES,
    pageSize: 100,
    // Overlap fetch: any change whose window intersects the visible grid.
    scheduledFrom: gridStart.toISOString(),
    scheduledTo: gridEnd.toISOString(),
  });

  const rows = useMemo(() => changes.data?.data ?? [], [changes.data]);

  const days = useMemo(
    () => eachDayOfInterval({ start: gridStart, end: gridEnd }),
    [gridStart, gridEnd]
  );

  /** scheduledStart-day index → changes; plus per-day overlap detection. */
  const byDay = useMemo(() => {
    const map = new Map<string, ChangeRow[]>();
    for (const change of rows) {
      const window = windowOf(change);
      if (!window) continue;
      const key = format(window.start, "yyyy-MM-dd");
      const list = map.get(key) ?? [];
      list.push(change);
      map.set(key, list);
    }
    return map;
  }, [rows]);

  const conflictDays = useMemo(() => {
    const conflicted = new Set<string>();
    for (const [key, dayChanges] of byDay) {
      if (dayChanges.length < 2) continue;
      const windows = dayChanges
        .map(windowOf)
        .filter((w): w is NonNullable<typeof w> => w !== null);
      outer: for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
          if (overlaps(windows[i], windows[j])) {
            conflicted.add(key);
            break outer;
          }
        }
      }
    }
    return conflicted;
  }, [byDay]);

  const isLoading = changes.isLoading;
  const isError = changes.isError;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Scheduled changes by day — warning ring marks overlapping windows"
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous month"
              onClick={() => setMonth((m) => subMonths(m, 1))}
              size="icon"
              variant="outline"
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button onClick={() => setMonth(startOfMonth(new Date()))} size="sm" variant="outline">
              Today
            </Button>
            <Button
              aria-label="Next month"
              onClick={() => setMonth((m) => addMonths(m, 1))}
              size="icon"
              variant="outline"
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        }
        title={`Change Calendar — ${format(month, "MMMM yyyy")}`}
      />

      <SectionCard
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).map((level) => (
              <ChangeRiskBadge key={level} value={level} />
            ))}
          </div>
        }
        contentClassName="p-0"
        title="Scheduled windows"
      >
        {isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void changes.refetch()}
              reason={changes.error.message}
              title="Calendar data could not be loaded"
            />
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <div className="h-16 animate-pulse rounded-md bg-muted/60" key={index} />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              {/* Sticky weekday header */}
              <div className="sticky top-0 z-10 grid grid-cols-7 border-b bg-card">
                {WEEKDAYS.map((weekday) => (
                  <div
                    className="px-2 py-2 text-center text-xs font-medium text-muted-foreground"
                    key={weekday}
                  >
                    {weekday}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {days.map((day) => {
                  const key = format(day, "yyyy-MM-dd");
                  const dayChanges = byDay.get(key) ?? [];
                  const conflicted = conflictDays.has(key);
                  const inMonth = isSameMonth(day, month);
                  const today = isToday(day);

                  const dayContent = (
                    <div
                      className={cn(
                        "flex h-24 flex-col gap-1 border-b border-e p-1.5 lg:h-28",
                        !inMonth && "bg-surface-subtle/40 text-muted-foreground",
                        conflicted && "border-warning ring-1 ring-inset ring-warning/50"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={cn(
                            "flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                            today
                              ? "bg-primary text-primary-foreground"
                              : inMonth
                                ? "text-foreground"
                                : "text-muted-foreground"
                          )}
                        >
                          {format(day, "d")}
                        </span>
                        {dayChanges.length > 2 && (
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            +{dayChanges.length - 2}
                          </span>
                        )}
                      </div>
                      {dayChanges.slice(0, 2).map((change) => {
                        const riskConfig = getStatusConfig(RISK_LEVEL, change.riskLevel);
                        return (
                          <button
                            className={cn(
                              "truncate rounded px-1.5 py-0.5 text-start text-[11px] font-medium hover:brightness-95",
                              riskConfig.badgeClass
                            )}
                            key={change.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveView("changes.change-detail", { changeId: change.id });
                            }}
                            title={`${change.number} — ${change.title}`}
                            type="button"
                          >
                            <span className="font-tech ltr-technical">{change.number}</span>{" "}
                            <span className="opacity-80">{change.title}</span>
                          </button>
                        );
                      })}
                      {dayChanges.length > 2 && (
                        <span className="px-1.5 text-[10px] text-muted-foreground">
                          {dayChanges.length - 2} more…
                        </span>
                      )}
                    </div>
                  );

                  return dayChanges.length > 0 ? (
                    <Popover key={key}>
                      <PopoverTrigger asChild>{dayContent}</PopoverTrigger>
                      <PopoverContent align="start" className="w-80">
                        <p className="mb-2 text-sm font-medium">
                          {format(day, "EEEE, MMM d")}
                        </p>
                        <ul className="flex flex-col gap-2">
                          {dayChanges.map((change) => (
                            <li key={change.id}>
                              <button
                                className="w-full rounded-lg border p-2 text-start hover:bg-accent"
                                onClick={() =>
                                  setActiveView("changes.change-detail", {
                                    changeId: change.id,
                                  })
                                }
                                type="button"
                              >
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="font-tech text-xs ltr-technical">
                                    {change.number}
                                  </span>
                                  <StatusBadge
                                    config={lookupStatusConfig(
                                      CHANGE_STATUS_UI,
                                      change.status
                                    )}
                                  />
                                  <ChangeRiskBadge value={change.riskLevel} />
                                </span>
                                <span className="mt-1 block truncate text-sm">
                                  {change.title}
                                </span>
                                <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                                  {change.scheduledStart
                                    ? format(new Date(change.scheduledStart), "HH:mm")
                                    : "—"}
                                  {change.scheduledEnd
                                    ? ` → ${format(new Date(change.scheduledEnd), "HH:mm")}`
                                    : ""}{" "}
                                  · {change.site?.code ?? "no site"}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <div key={key}>{dayContent}</div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {rows.length === 0 && !isLoading && !isError && (
        <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <CalendarDays aria-hidden="true" className="size-4" />
          No approved, scheduled or executing changes in this month.
        </p>
      )}
    </div>
  );
}
