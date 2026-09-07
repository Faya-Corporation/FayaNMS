/**
 * FayaNMS worker — scheduler loop.
 *
 * Every 30 s it pokes POST /api/v1/worker/tick so the Next.js side can
 * evaluate BackupPolicy cron schedules and enqueue CONFIG_BACKUP jobs.
 * One extra tick runs ~10 s after service start.
 *
 * Task 10-a hardening: the tick loop is self-scheduling (recursive
 * setTimeout; the next tick is always scheduled in `finally`) and backs off
 * exponentially while the backend is unreachable (30 s → 5 min cap), with
 * the consecutive-failure count exposed via getSchedulerState() for /health.
 */

import { nextPost, log } from "./next-client";

const TICK_INTERVAL_MS = 30_000;
const FIRST_TICK_DELAY_MS = 10_000;
/** Tick-loop exponential backoff cap (Task 10-a) — 5 minutes. */
const MAX_TICK_BACKOFF_MS = 300_000;

let consecutiveTickFailures = 0;

/** Exposed to /health as scheduler: { consecutiveTickFailures }. */
export function getSchedulerState() {
  return { consecutiveTickFailures };
}

function tickBackoffDelay(): number {
  return Math.min(TICK_INTERVAL_MS * 2 ** consecutiveTickFailures, MAX_TICK_BACKOFF_MS);
}

/** Runs one tick POST. Returns true when it succeeded. */
async function tick(): Promise<boolean> {
  const started = Date.now();
  try {
    const data = (await nextPost("/api/v1/worker/tick", {}, 20_000)) as {
      enqueued?: number;
    };
    await log(
      `scheduler tick ok in ${Date.now() - started}ms: enqueued=${data?.enqueued ?? "?"}`
    );
    return true;
  } catch (e) {
    consecutiveTickFailures += 1;
    const delay = tickBackoffDelay();
    await log(
      `scheduler tick failed (consecutive=${consecutiveTickFailures}, next retry in ${Math.round(delay / 1000)}s): ${(e as Error).message}`
    );
    return false;
  }
}

/**
 * Self-scheduling tick loop (Task 10-a): the next tick is ALWAYS scheduled
 * in `finally`, so no rejection can break the chain. A successful tick after
 * ≥1 failure logs a greppable recovery line and resets the counter.
 */
async function runTickCycle(): Promise<void> {
  let nextDelay = TICK_INTERVAL_MS;
  try {
    const ok = await tick();
    if (ok) {
      if (consecutiveTickFailures > 0) {
        await log(
          `scheduler backend recovered after ${consecutiveTickFailures} consecutive tick failures`
        );
      }
      consecutiveTickFailures = 0;
    } else {
      nextDelay = tickBackoffDelay();
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
