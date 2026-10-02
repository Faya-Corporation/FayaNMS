/**
 * F-044 (audit A2-12) — change-job budget arithmetic.
 *
 * The change driver used to race a STATIC 600 s worker timeout against a
 * step loop bounded by 40 iterations × 90 s per step call (+ inter-step
 * sleeps): any slow-but-healthy plan could exceed the race, the worker
 * reported the job FAILED and requeued it while the app-side engine kept
 * executing steps. The fix is the BACKLOG plan's preferred variant: the
 * job budget is DERIVED at claim time from the plan's own size —
 *
 *     budget = iterations × (stepTimeout + progressPost + maxSleep) + margin
 *     iterations = min(stepsTotal, CHANGE_MAX_STEP_CALLS)
 *
 * with a fail-safe fallback to the full driver loop bound when the claim
 * enrichment could not supply stepsTotal (legacy payload / vanished change
 * row) — the budget may be generous, never smaller than the loop it bounds.
 *
 * Every factor below is the EXACT constant the worker driver actually
 * spends per iteration (mini-services/worker/runner.ts imports them from
 * here, so the math and the loop cannot drift apart silently):
 *
 *   stepTimeout   — the per-step HTTP budget (nextPost to /worker/change-step)
 *   progressPost  — one reportProgress post per iteration (same timeout
 *                   constant as the shared reportProgress helper)
 *   maxSleep      — the inter-step beat upper bound (sleep(randInt(min,max)))
 *   margin        — the startup progress post + the final completion post
 *                   (15 s) + scheduling slack
 *
 * The same derivation feeds the scheduler tick's stale-job reaper: its
 * CHANGE_EXECUTE threshold is the derived budget + a grace window, so the
 * reaper can never race a live driver no matter how long the plan is
 * (the old hardcoded 15-minute threshold assumed the 10-minute budget).
 *
 * Pure and dependency-free: both the worker (runner.ts) and the app
 * (tick route) import it, and the pinning suite exercises the arithmetic
 * directly (tests/audit/open-findings-batch-16.test.ts).
 */

/** Per-step-call HTTP budget for POST /api/v1/worker/change-step (was an inline 90_000 literal). */
export const CHANGE_STEP_CALL_TIMEOUT_MS = 90_000;

/** Per-iteration progress post budget (reportProgress's nextPost timeout). */
export const CHANGE_PROGRESS_POST_TIMEOUT_MS = 8_000;

/** Inter-step "timeline reads like a real execution" beat bounds. */
export const CHANGE_INTER_STEP_SLEEP_MIN_MS = 300;
export const CHANGE_INTER_STEP_SLEEP_MAX_MS = 600;

/** Driver loop bound — the max number of step calls one attempt may make. */
export const CHANGE_MAX_STEP_CALLS = 40;

/**
 * Fixed overhead outside the per-iteration loop: the startup progress post
 * (8 s) + the final completion post (15 s) + clock/scheduling slack.
 */
export const CHANGE_BUDGET_MARGIN_MS = 30_000;

/** Worst-case cost of ONE driver iteration (step call + progress post + beat). */
export const CHANGE_PER_ITERATION_MS =
  CHANGE_STEP_CALL_TIMEOUT_MS + CHANGE_PROGRESS_POST_TIMEOUT_MS + CHANGE_INTER_STEP_SLEEP_MAX_MS;

/**
 * Derive the change-job budget for one driver attempt from the plan's step
 * count. A positive integer stepsTotal bounds the loop by the plan's size
 * (clamped to the driver's hard CHANGE_MAX_STEP_CALLS bound); anything else
 * (absent/legacy enrichment, malformed value) falls back to the FULL loop
 * bound — fail-safe generosity, the budget only ever over-covers.
 */
export function deriveChangeJobBudgetMs(stepsTotal: unknown): number {
  const iterations =
    typeof stepsTotal === "number" && Number.isInteger(stepsTotal) && stepsTotal >= 1
      ? Math.min(stepsTotal, CHANGE_MAX_STEP_CALLS)
      : CHANGE_MAX_STEP_CALLS;
  return iterations * CHANGE_PER_ITERATION_MS + CHANGE_BUDGET_MARGIN_MS;
}

/**
 * The tick reaper adds this grace over the derived budget: when the
 * worker's own raceTimeout fires the body's completion post lands within
 * seconds, so any threshold above the budget (+ latency slack) can never
 * reap a live driver mid-run.
 */
export const CHANGE_REAPER_GRACE_MS = 5 * 60_000;

/** Reaper threshold (ms) for a change job of the given plan size. */
export function deriveChangeReaperThresholdMs(stepsTotal: unknown): number {
  return deriveChangeJobBudgetMs(stepsTotal) + CHANGE_REAPER_GRACE_MS;
}

/**
 * The SMALLEST reaper threshold any change job can have (stepsTotal = 1;
 * the fallback derives even larger). The tick route uses it as the SQL
 * pre-filter bound before the per-job JS filtering — a monotonicity
 * guarantee, so the pre-filter can never drop a job its own threshold
 * would have reaped.
 */
export const MIN_CHANGE_REAPER_THRESHOLD_MS = deriveChangeReaperThresholdMs(1);

/**
 * Reaper threshold for a stored CHANGE_EXECUTE JobExecution row: extracts
 * stepsTotal from the stored payloadJson (the claim-time enrichment) and
 * derives. Malformed/absent payloads fall back to the full loop bound.
 */
export function changeReaperThresholdForPayload(payloadJson: string | null | undefined): number {
  let stepsTotal: unknown;
  if (payloadJson) {
    try {
      const parsed: unknown = JSON.parse(payloadJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        stepsTotal = (parsed as Record<string, unknown>).stepsTotal;
      }
    } catch {
      stepsTotal = undefined;
    }
  }
  return deriveChangeReaperThresholdMs(stepsTotal);
}

/**
 * The typed rejection raceTimeout raises when a job body exceeds its
 * budget. The change driver's catch classifies on exactly this type:
 * a budget exhaustion is DRIVER LOSS (the body stops being authoritative),
 * reported as a resumable "resumed" requeue — never a device-failure
 * FAILED. Every other job type keeps the generic failure path, so the
 * typed error is additive and harmless there.
 */
export class JobTimeoutError extends Error {
  readonly label: string;
  readonly budgetMs: number;

  constructor(label: string, budgetMs: number) {
    super(`${label} timed out after ${budgetMs} ms`);
    this.name = "JobTimeoutError";
    this.label = label;
    this.budgetMs = budgetMs;
  }
}
