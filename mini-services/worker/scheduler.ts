/**
 * FayaNMS worker — scheduler loop.
 *
 * Every 30 s it pokes POST /api/v1/worker/tick so the Next.js side can
 * evaluate BackupPolicy cron schedules and enqueue CONFIG_BACKUP jobs. It
 * also drains the durable normalized protocol-event handoff in bounded
 * batches. One extra tick runs ~10 s after service start.
 *
 * Task 10-a hardening: the tick loop is self-scheduling (recursive
 * setTimeout; the next tick is always scheduled in `finally`) and backs off
 * exponentially while the backend is unreachable (30 s → 5 min cap), with
 * the consecutive-failure count exposed via getSchedulerState() for /health.
 */

import { nextPost, log, PostHttpError } from "./next-client";
import { IDENTITY_FAULT_BACKOFF_MS, isIdentityFaultStatus, jitterBackoff } from "./backoff";

const TICK_INTERVAL_MS = 30_000;
const FIRST_TICK_DELAY_MS = 10_000;
/** Tick-loop exponential backoff cap (Task 10-a) — 5 minutes. */
const MAX_TICK_BACKOFF_MS = 300_000;
const PROTOCOL_DRAIN_LIMIT = 32;

let consecutiveTickFailures = 0;

/** Exposed to /health as scheduler: { consecutiveTickFailures }. */
export function getSchedulerState() {
  return { consecutiveTickFailures };
}

/**
 * Exponential tick backoff base (Task 10-a) — 30 s → 5 min cap. F-6: the
 * caller applies the identity-fault classification and the ±20% jitter so
 * the logged delay and the scheduled delay are the SAME value.
 */
function tickBackoffDelay(): number {
  return Math.min(TICK_INTERVAL_MS * 2 ** consecutiveTickFailures, MAX_TICK_BACKOFF_MS);
}

/** Outcome of one tick: whether it succeeded + the delay to schedule next. */
interface TickOutcome {
  ok: boolean;
  /** The ACTUAL delay the caller must schedule (already classified/jittered). */
  nextDelayMs: number;
}

/** Runs one tick POST (tick + protocol-event drain). */
async function tick(): Promise<TickOutcome> {
  const started = Date.now();
  try {
    const data = (await nextPost("/api/v1/worker/tick", {}, 20_000)) as {
      enqueued?: number;
    };
    let drainSummary = "protocol queue drain unavailable";
    try {
      const drain = (await nextPost(
        "/api/v1/worker/protocol-events/drain",
        { limit: PROTOCOL_DRAIN_LIMIT },
        20_000,
      )) as {
        claimed?: number;
        delivered?: number;
        requeued?: number;
        deadLettered?: number;
        queueDepth?: number;
        flowRecordsPersisted?: number;
      };
      drainSummary =
        `protocolQueue claimed=${drain?.claimed ?? "?"} delivered=${drain?.delivered ?? "?"} flowRecordsPersisted=${drain?.flowRecordsPersisted ?? "?"} requeued=${drain?.requeued ?? "?"} dead=${drain?.deadLettered ?? "?"} depth=${drain?.queueDepth ?? "?"}`;
    } catch (error) {
      await log(
        `protocol queue drain failed (tick remains healthy): ${(error as Error).message}`,
      );
    }
    await log(
      `scheduler tick ok in ${Date.now() - started}ms: enqueued=${data?.enqueued ?? "?"}; ${drainSummary}`,
    );
    return { ok: true, nextDelayMs: TICK_INTERVAL_MS };
  } catch (e) {
    consecutiveTickFailures += 1;
    // F-6 — classify the failure: a 401/403 is a CONFIG fault (the service
    // identity was rejected — keys rotated/absent), answered with a fixed
    // slow cadence + a distinct greppable log line; 5xx/timeouts keep the
    // jittered exponential curve.
    const err = e as Error;
    const isIdentityFault =
      err instanceof PostHttpError && isIdentityFaultStatus(err.status);
    const delay = isIdentityFault
      ? IDENTITY_FAULT_BACKOFF_MS
      : jitterBackoff(tickBackoffDelay());
    await log(
      isIdentityFault
        ? `service identity rejected — check keys (F-6): scheduler tick failed: ${err.message} — retrying on a fixed ${IDENTITY_FAULT_BACKOFF_MS / 1000}s cadence`
        : `scheduler tick failed (consecutive=${consecutiveTickFailures}, next retry in ${Math.round(delay / 1000)}s): ${err?.message ?? String(e)}`
    );
    return { ok: false, nextDelayMs: delay };
  }
}

/**
 * Self-scheduling tick loop (Task 10-a): the next tick is ALWAYS scheduled
 * in `finally`, so no rejection can break the chain. A successful tick after
 * ≥1 failure logs a greppable recovery line and resets the counter.
 * F-6: the failure delay is classified (identity fault → fixed cadence) and
 * jittered ±20% by tick() itself, so the logged "next retry in" and the
 * scheduled delay always agree.
 */
async function runTickCycle(): Promise<void> {
  let nextDelay = TICK_INTERVAL_MS;
  try {
    const outcome = await tick();
    nextDelay = outcome.nextDelayMs;
    if (outcome.ok) {
      if (consecutiveTickFailures > 0) {
        await log(
          `scheduler backend recovered after ${consecutiveTickFailures} consecutive tick failures`
        );
      }
      consecutiveTickFailures = 0;
    }
  } catch {
    // tick() contains its own errors; belt-and-braces so the chain never dies.
  } finally {
    setTimeout(() => void runTickCycle(), nextDelay);
  }
}

export function startScheduler(): void {
  log(
    `scheduler started: first tick in ${FIRST_TICK_DELAY_MS / 1000}s, then every ${
      TICK_INTERVAL_MS / 1000
    }s (exponential backoff up to ${MAX_TICK_BACKOFF_MS / 1000}s on backend outage)`
  );
  setTimeout(() => void runTickCycle(), FIRST_TICK_DELAY_MS);
}
