import { expect, test } from "bun:test";
import {
  DEFAULT_FLOW_RETENTION,
  flowRetentionCutoff,
  flowRetentionSchema,
  isFlowRecordExpired,
  parseStoredFlowRetention,
  shouldPruneFlowRecords,
} from "../src/lib/flows/retention";

test("flow retention defaults to enabled 14-day storage and malformed settings fail safe", () => {
  expect(DEFAULT_FLOW_RETENTION).toEqual({ days: 14, enabled: true });
  expect(parseStoredFlowRetention(null)).toMatchObject({ days: 14, enabled: true });
  expect(parseStoredFlowRetention("not-json")).toMatchObject({ days: 14, enabled: true });
});

test("flow retention policy validates days and requires an explicit enabled flag", () => {
  expect(flowRetentionSchema.safeParse({ days: 1, enabled: false }).success).toBe(true);
  expect(flowRetentionSchema.safeParse({ days: 3650, enabled: true }).success).toBe(true);
  expect(flowRetentionSchema.safeParse({ days: 0, enabled: true }).success).toBe(false);
  expect(flowRetentionSchema.safeParse({ days: 3651, enabled: true }).success).toBe(false);
  expect(flowRetentionSchema.safeParse({ days: 14 }).success).toBe(false);
});

test("disabled flow retention is a no-op", () => {
  expect(shouldPruneFlowRecords({ days: 14, enabled: false })).toBe(false);
  expect(shouldPruneFlowRecords({ days: 14, enabled: true })).toBe(true);
});

test("cutoff is based on server received time and excludes records at or after it", () => {
  const now = new Date("2026-09-23T00:00:00.000Z");
  const cutoff = flowRetentionCutoff(now, 14);
  expect(cutoff.toISOString()).toBe("2026-09-09T00:00:00.000Z");
  expect(isFlowRecordExpired(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
  expect(isFlowRecordExpired(cutoff, cutoff)).toBe(false);
  expect(isFlowRecordExpired(new Date(cutoff.getTime() + 1), cutoff)).toBe(false);
});
