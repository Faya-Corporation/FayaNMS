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
 *     iterations = min(min(stepsTotal, CHANGE_MAX_STEP_CALLS)
 *                      + CHANGE_ROLLBACK_STEP_PAD, CHANGE_MAX_STEP_CALLS)
 *
 * CHANGE_ROLLBACK_STEP_PAD (wave-6): on APPLY/VALIDATE failure the engine
 * appends 3 rollback steps and the closing observe call adds a 4th — the
 * driver can legitimately make stepsTotal + 4 step calls, so the plan-sized
 * budget pads by 4 iterations (still capped by the driver's hard loop
 * bound) or every healthy rollback tail races the budget near its worst
 * case and mislabels driver loss.
 *
 * A fail-safe fallback covers the claim enrichment could not supply
 * stepsTotal (legacy payload / vanished change row): the budget may be
 * generous, never smaller than the loop it bounds.
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
 *
 * Wave-8 (F-4): this module now also derives the worker's per-type OUTER
 * race budgets for the evaluate-in-Next drivers (deriveWorkerJobBudgetMs)
 * — the runner's raceTimeout used to undercut those drivers' own inner
 * HTTP budgets; see the wave-8 section below.
 */

/** Per-step-call HTTP budget for POST /api/v1/worker/change-step (was an inline 90_000 literal). */
export const CHANGE_STEP_CALL_TIMEOUT_MS = 90_000;

/** Per-iteration progress post budget (reportProgress's nextPost timeout). */
export const CHANGE_PROGRESS_POST_TIMEOUT_MS = 8_000;

/** Inter-step "timeline reads like a real execution" beat bounds. */
export const CHANGE_INTER_STEP_SLEEP_MIN_MS = 300;
export const CHANGE_INTER_STEP_SLEEP_MAX_MS = 600;

/**
 * Step calls a driver attempt can make BEYOND the plan's own stepsTotal:
 * 3 appended rollback steps (on APPLY/VALIDATE failure) + the closing
 * observe call. Wave-6: the derived budget pads by this so a healthy
 * rollback tail can never exhaust the budget (worst-case deficit was
 * ≈ 4 iterations − margin ≈ 6 minutes).
 */
export const CHANGE_ROLLBACK_STEP_PAD = 4;

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
 * plus the rollback pad (clamped to the driver's hard CHANGE_MAX_STEP_CALLS
 * bound); anything else (absent/legacy enrichment, malformed value) falls
 * back to the FULL loop bound — fail-safe generosity, the budget only ever
 * over-covers.
 */
export function deriveChangeJobBudgetMs(stepsTotal: unknown): number {
  const iterations =
    typeof stepsTotal === "number" && Number.isInteger(stepsTotal) && stepsTotal >= 1
      ? Math.min(Math.min(stepsTotal, CHANGE_MAX_STEP_CALLS) + CHANGE_ROLLBACK_STEP_PAD, CHANGE_MAX_STEP_CALLS)
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
 * ── Wave-8 (F-4): per-type OUTER race budgets for the evaluate-in-Next drivers ──
 *
 * The runner's per-job raceTimeout used to be a FLAT 30 s for every
 * non-change type while six of those drivers spend a 60 s inner HTTP
 * budget on their evaluate-in-Next call (alerts/evaluate, metrics/rollup,
 * reports/execute, the three retention prunes). On budget fire the worker
 * reported FAILED → the app requeued → a second concurrent attempt
 * re-fired the same server-side work while attempt #1 was still executing.
 *
 * The fix mirrors the F-044 derivation style: the budget is DERIVED from
 * the factors the driver actually spends, and every factor is the EXACT
 * constant the runner imports (the math and the loop cannot drift apart):
 *
 *     budget = innerHttpTimeout            (the evaluate-in-Next call)
 *            + 2 × progressPostBudget      (bracketing progress posts)
 *            + margin                      (startup + completion + slack)
 *
 * CHANGE_EXECUTE keeps its own claim-time derivation
 * (deriveChangeJobBudgetMs) untouched — that arithmetic is plan-sized and
 * pinned by tests/audit/open-findings-batch-16.test.ts.
 */

/**
 * The inner HTTP budget every evaluate-in-Next driver spends on its single
 * long call (was a 60_000 literal at each call site in runner.ts — now the
 * runner imports this constant so the outer budget can never undercut it).
 */
export const WORKER_INNER_HTTP_TIMEOUT_MS = 60_000;

/**
 * Fixed overhead outside the inner call: the bracketing reportProgress
 * posts (each bounded by CHANGE_PROGRESS_POST_TIMEOUT_MS — the SAME
 * constant the runner's reportProgress helper spends) and the completion
 * post + scheduling slack (same margin constant as the change budget).
 */
export const WORKER_JOB_BUDGET_MARGIN_MS = CHANGE_BUDGET_MARGIN_MS;
/** Number of progress posts a evaluate-in-Next driver makes around the call. */
export const WORKER_JOB_PROGRESS_POSTS = 2;

/**
 * The job types whose outer race budget is DERIVED (they carry the 60 s
 * inner HTTP budget). Every other type keeps the runner's flat budget.
 */
export const WORKER_DERIVED_BUDGET_TYPES = [
  "ALERT_EVALUATION",
  "METRIC_RETENTION",
  "FLOW_RETENTION",
  "ROLLUP_AGGREGATION",
  "PROTOCOL_QUEUE_RETENTION",
  "REPORT_RUN",
] as const;

export type WorkerDerivedBudgetType = (typeof WORKER_DERIVED_BUDGET_TYPES)[number];

/**
 * Derive the runner's outer race budget for a job type: the inner HTTP
 * budget + the bracketing progress posts + margin — always STRICTLY
 * GREATER than the inner timeout (a healthy slow call must finish inside
 * its own race, never fire the premature FAILED/requeue/re-fire cycle).
 * Returns 0 for types outside WORKER_DERIVED_BUDGET_TYPES (the caller
 * falls back to its flat budget — SNMP_POLL/CONFIG_BACKUP keep theirs).
 */
export function deriveWorkerJobBudgetMs(type: string): number {
  if (!(WORKER_DERIVED_BUDGET_TYPES as readonly string[]).includes(type)) {
    return 0;
  }
  return (
    WORKER_INNER_HTTP_TIMEOUT_MS +
    WORKER_JOB_PROGRESS_POSTS * CHANGE_PROGRESS_POST_TIMEOUT_MS +
    WORKER_JOB_BUDGET_MARGIN_MS
  );
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
