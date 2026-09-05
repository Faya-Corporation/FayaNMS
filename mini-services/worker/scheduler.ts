/**
 * FayaNMS worker — scheduler loop.
 *
 * Every 30 s it pokes POST /api/v1/worker/tick so the Next.js side can
 * evaluate BackupPolicy cron schedules and enqueue CONFIG_BACKUP jobs.
 * One extra tick runs ~10 s after service start. Ticks are fire-and-forget:
 * failures are logged and never crash the service.
 */

import { nextPost, log } from "./next-client";

const TICK_INTERVAL_MS = 30_000;
const FIRST_TICK_DELAY_MS = 10_000;

async function tick(): Promise<void> {
  const started = Date.now();
  try {
    const data = (await nextPost("/api/v1/worker/tick", {}, 20_000)) as {
      enqueued?: number;
    };
    await log(
      `scheduler tick ok in ${Date.now() - started}ms: enqueued=${data?.enqueued ?? "?"}`
    );
  } catch (e) {
    await log(`scheduler tick failed: ${(e as Error).message}`);
  }
}

export function startScheduler(): void {
  log(
    `scheduler started: first tick in ${FIRST_TICK_DELAY_MS / 1000}s, then every ${
      TICK_INTERVAL_MS / 1000
    }s`
  );
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  setInterval(() => void tick(), TICK_INTERVAL_MS);
}
