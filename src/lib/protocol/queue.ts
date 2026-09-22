export const PROTOCOL_QUEUE_DEFAULT_MAX_ATTEMPTS = 5;
export const PROTOCOL_QUEUE_MAX_BACKOFF_MS = 15 * 60 * 1_000;

const INITIAL_BACKOFF_MS = 5 * 1_000;

export type ProtocolQueueFailureDecision = {
  status: "QUEUED" | "DEAD";
  nextAttemptAt: Date;
  lastError: string;
};

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Bounded exponential retry for the durable protocol-event handoff.
 * The attempt number is one-based: the first failed delivery waits 5 seconds.
 */
export function protocolQueueRetryDelayMs(attempt: number): number {
  const normalizedAttempt = positiveInteger(attempt, 1);
  return Math.min(
    PROTOCOL_QUEUE_MAX_BACKOFF_MS,
    INITIAL_BACKOFF_MS * 2 ** Math.min(normalizedAttempt - 1, 18),
  );
}

/**
 * Keep operational error text useful without allowing control characters or
 * unbounded exception strings into the queue row.
 */
export function sanitizeProtocolQueueError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "protocol event delivery failed";
  return (
    message
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || "protocol event delivery failed"
  );
}

export function protocolQueueFailure(
  attempt: number,
  maxAttempts: number,
  now: Date,
  error: unknown,
): ProtocolQueueFailureDecision {
  const normalizedAttempt = positiveInteger(attempt, 1);
  const normalizedMaxAttempts = positiveInteger(
    maxAttempts,
    PROTOCOL_QUEUE_DEFAULT_MAX_ATTEMPTS,
  );
  const dead = normalizedAttempt >= normalizedMaxAttempts;
  return {
    status: dead ? "DEAD" : "QUEUED",
    nextAttemptAt: new Date(
      now.getTime() + (dead ? 0 : protocolQueueRetryDelayMs(normalizedAttempt)),
    ),
    lastError: sanitizeProtocolQueueError(error),
  };
}
