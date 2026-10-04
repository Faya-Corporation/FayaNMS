/**
 * z-ai-web-dev-sdk access layer (Phase 12-a — AI-assisted operations).
 *
 * BACKEND ONLY — this module must never be imported from client code.
 *
 * Design:
 *   - One lazy ZAI instance per process (module-level singleton; the first
 *     successful ZAI.create() is cached forever).
 *   - Every completion call is guarded by a hard timeout (45 s) so a stalled
 *     upstream can never hang an API route.
 *   - One automatic retry with a 1 s backoff when the call fails or returns
 *     an empty response (transient upstream hiccups are common).
 *   - Failures surface as typed errors so routes can answer with clean
 *     envelope errors (AI_UNAVAILABLE / AI_BAD_RESPONSE) instead of leaking
 *     SDK internals.
 */

import ZAI from "z-ai-web-dev-sdk";

/** Mirror of the SDK's ChatMessage (keeps our call sites strictly typed). */
export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Hard wall-clock budget for a single completion round-trip. */
export const AI_TIMEOUT_MS = 45_000;

/** Milliseconds to wait before the single automatic retry. */
const AI_RETRY_DELAY_MS = 1_000;

/**
 * The AI service could not be reached, timed out, or returned nothing
 * usable. Maps to a 503 AI_UNAVAILABLE envelope error at the route layer.
 */
export class AiUnavailableError extends Error {
  constructor(message = "The AI service is unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/**
 * The AI answered, but the content did not meet the caller's contract
 * (e.g. not parseable JSON). Carries the raw text for diagnostics — the
 * route truncates it before it reaches the wire. Maps to a 502
 * AI_BAD_RESPONSE envelope error.
 */
export class AiBadResponseError extends Error {
  readonly raw: string;

  constructor(raw: string, message = "The AI response could not be used.") {
    super(message);
    this.name = "AiBadResponseError";
    this.raw = raw;
  }
}

/* ------------------------------------------------------------------ */
/* Lazy per-process singleton                                          */
/* ------------------------------------------------------------------ */

type ZaiInstance = Awaited<ReturnType<typeof ZAI.create>>;

const globalForZai = globalThis as unknown as {
  fayaZaiInstance?: ZaiInstance;
  fayaZaiPromise?: Promise<ZaiInstance>;
};

/**
 * Resolve the shared ZAI client. The in-flight promise is cached too, so
 * concurrent requests during warm-up share one ZAI.create() call; a failed
 * warm-up clears the cache so the next request can retry.
 */
async function getZai(): Promise<ZaiInstance> {
  if (globalForZai.fayaZaiInstance) return globalForZai.fayaZaiInstance;
  if (!globalForZai.fayaZaiPromise) {
    globalForZai.fayaZaiPromise = ZAI.create()
      .then((instance) => {
        globalForZai.fayaZaiInstance = instance;
        return instance;
      })
      .catch((error: unknown) => {
        globalForZai.fayaZaiPromise = undefined;
        console.error("[ai] ZAI.create failed", error);
        throw new AiUnavailableError(
          "The AI service client could not be initialized."
        );
      });
  }
  return globalForZai.fayaZaiPromise;
}

/* ------------------------------------------------------------------ */
/* Completion with timeout guard + one retry                           */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeOnce(
  messages: AiChatMessage[],
  timeoutMs: number
): Promise<string> {
  const zai = await getZai();

  // The SDK call does not accept an AbortSignal, so enforce the budget with
  // a racing timer. The losing request is simply abandoned (best-effort).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages,
        thinking: { type: "disabled" },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AiUnavailableError(
                `The AI service did not respond within ${Math.round(timeoutMs / 1000)}s.`
              )
            ),
          timeoutMs
        );
      }),
    ])) as { choices?: { message?: { content?: unknown } }[] | null };

    const content = completion?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new AiUnavailableError(
        "The AI service returned an empty response."
      );
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a chat completion with the timeout guard and exactly one retry
 * (1 s backoff) on failure. Throws AiUnavailableError when both attempts
 * fail; never throws SDK-typed errors outward.
 */
export async function aiChat(
  messages: AiChatMessage[],
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(AI_RETRY_DELAY_MS);
    try {
      return await completeOnce(messages, timeoutMs);
    } catch (error) {
      lastError = error;
      // Constant format string + positional args — the variable parts are a
      // loop counter and an error value, never format-string input.
      console.error(
        "[ai] completion attempt failed:",
        attempt + 1,
        "of 2:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (lastError instanceof AiUnavailableError) throw lastError;
  throw new AiUnavailableError(
    "The AI service could not be reached. Please try again in a moment."
  );
}
