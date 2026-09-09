import { expectedRangeFor } from "@/lib/reports/generate";

/**
 * Shared ReportSchedule serializer (Task 9-a / Task 18 fix).
 *
 * Mirrors the JSON contract used by BOTH /api/v1/reports/schedules and
 * /api/v1/reports/schedules/[id] (PATCH response) so a serialized schedule
 * is byte-identical regardless of which endpoint produced it. Extracted
 * from the list route when the [id] route was added so the two surfaces
 * cannot drift.
 */

const DAY_MS = 86_400_000;

/** Frequency → indicative interval used for the next-run estimate. */
export const FREQUENCY_INTERVAL_DAYS: Record<string, number> = {
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 30,
  QUARTERLY: 90,
};

export function serializeSchedule(schedule: {
  id: string;
  name: string;
  reportType: string;
  frequency: string;
  format: string;
  recipientsJson: string;
  isActive: boolean;
  lastRunAt: Date | null;
}) {
  let recipients: string[] = [];
  try {
    const parsed = JSON.parse(schedule.recipientsJson);
    if (Array.isArray(parsed)) {
      recipients = parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    recipients = [];
  }
  const intervalDays = FREQUENCY_INTERVAL_DAYS[schedule.frequency] ?? 7;
  return {
    id: schedule.id,
    name: schedule.name,
    reportType: schedule.reportType,
    frequency: schedule.frequency,
    format: schedule.format,
    recipients,
    isActive: schedule.isActive,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    expectedRange: expectedRangeFor(schedule.reportType, schedule.frequency),
    nextEstimatedRunAt: schedule.isActive
      ? new Date(
          (schedule.lastRunAt?.getTime() ?? Date.now()) +
            intervalDays * DAY_MS
        ).toISOString()
      : null,
  };
}
