import { expect, test } from "bun:test";
import {
  PROTOCOL_QUEUE_MAX_BACKOFF_MS,
  protocolQueueFailure,
  protocolQueueRetryDelayMs,
  sanitizeProtocolQueueError,
} from "../src/lib/protocol/queue";

test("protocol queue uses bounded exponential retry", () => {
  expect(protocolQueueRetryDelayMs(1)).toBe(5_000);
  expect(protocolQueueRetryDelayMs(2)).toBe(10_000);
  expect(protocolQueueRetryDelayMs(3)).toBe(20_000);
  expect(protocolQueueRetryDelayMs(99)).toBe(PROTOCOL_QUEUE_MAX_BACKOFF_MS);
});

test("protocol queue failure requeues with bounded, sanitized error text", () => {
  const now = new Date("2026-09-22T00:00:00.000Z");
  const decision = protocolQueueFailure(
    2,
    5,
    now,
    new Error("temporary\nbackend\u0000 failure"),
  );
  expect(decision.status).toBe("QUEUED");
  expect(decision.nextAttemptAt.toISOString()).toBe("2026-09-22T00:00:20.000Z");
  expect(decision.lastError).toBe("temporary backend failure");
  expect(decision.lastError.length).toBeLessThanOrEqual(500);
});

test("protocol queue dead-letters at the configured attempt limit", () => {
  const now = new Date("2026-09-22T00:00:00.000Z");
  const decision = protocolQueueFailure(5, 5, now, "terminal failure");
  expect(decision.status).toBe("DEAD");
  expect(decision.nextAttemptAt).toEqual(now);
  expect(sanitizeProtocolQueueError({})).toBe("protocol event delivery failed");
});
