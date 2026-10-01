/**
 * Bounded wrappers around Playwright driver calls that have NO timeout of
 * their own — `browser.newPage()`, `page.close()`, and `page.addScriptTag()`
 * sit OUTSIDE every action/wait bound (setDefaultTimeout covers actions and
 * navigations only; explicit timeouts exist only where the journey passes
 * one). A wedged browser process or a starved renderer would therefore hang
 * the calling journey/hook until the test-runner timeout burns the full
 * budget (observed: run 36779703553 B3b hook 300s; local full-suite B3b
 * hook 300s reproduced with the stack re-boot path blocked). Race every
 * such call against a node-side timer — the node timer always wins because
 * it does not live in the (possibly frozen) renderer.
 *
 * `boundedNewPage` also applies the 30s default to all of the page's
 * actions/navigations (Playwright actions default to UNLIMITED otherwise —
 * one wedged click would hang the journey until the watchdog kill).
 */
import type { Browser, Page } from "playwright";

async function raceBounded<T>(op: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the ${ms}ms node-side bound`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * browser.newPage with a node-side bound + bounded per-action defaults.
 * 60s, not 30s: on a fully loaded 2-vCPU runner a just-launched browser can
 * legitimately take longer than 30s to spawn its first renderer
 * (run 36799654823 attempt 2, B5: the 30s bound fired on a degraded box
 * while the SAME journey passed elsewhere in the same run). 60s stays
 * under the 120s launch bound and the 180s per-test budget.
 */
export async function boundedNewPage(
  browser: Browser,
  options: Parameters<Browser["newPage"]>[0],
  ms = 60_000
): Promise<Page> {
  const page = await raceBounded(() => browser.newPage(options), ms, "browser.newPage");
  page.setDefaultTimeout(30_000);
  return page;
}

/** page.close with a node-side bound — reclaiming must never hang. */
export async function boundedClose(page: Page, ms = 10_000): Promise<void> {
  await raceBounded(() => page.close(), ms, "page.close");
}

/**
 * Force-terminate a wedged browser. Playwright 1.62's public Browser API has
 * NO process handle (no process()/kill(); verified at runtime — the browser
 * object is a proxy over the driver connection), but a BROWSER-LEVEL CDP
 * session is handled by the browser process itself and does NOT wait for
 * wedged renderers to acknowledge their own shutdown — exactly the wedge
 * that makes graceful close hang. Verified locally: CDP Browser.close
 * disconnects a live headless Chromium in ~1.7s and a subsequent graceful
 * close() resolves idempotently. NEVER touches the shared e2e stack
 * (app/worker/postgres) — those are owned by the e2e-server harness.
 */
async function cdpForceClose(browser: Browser): Promise<void> {
  try {
    const session = await raceBounded(
      () => browser.newBrowserCDPSession(),
      5_000,
      "browser.newBrowserCDPSession"
    );
    await raceBounded(() => session.send("Browser.close"), 5_000, "CDP Browser.close");
  } catch {
    /* best effort — the browser is already lost or gone */
  }
}

/**
 * browser.close with a node-side bound and a CDP force-close fallback. A
 * wedged driver used to burn the FULL 60s hook timeout in afterEach/afterAll
 * and then linger until bun's dangling-process kill reaped the children —
 * together with the shared e2e app (run 36799654823: two 60s burns per
 * attempt, `[e2e:app] exited 143` collateral, and the leaked spinners
 * degraded the CI re-run's first journeys). The journey design launches a
 * FRESH browser every time, so force-closing this one reclaims the CPU
 * immediately and safely; the next journey launches a new one. Never
 * throws for wedge timeouts — non-wedge close errors still surface.
 */
export async function boundedBrowserClose(
  browser: Browser | null | undefined,
  ms = 12_000
): Promise<void> {
  if (!browser) return;
  try {
    await raceBounded(() => browser.close(), ms, "browser.close");
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (!message.includes("exceeded the")) throw error;
    console.error(`[browser] ${message} — force-closing the browser via CDP to reclaim`);
    await cdpForceClose(browser);
  }
}

/**
 * Journey-finally page close. A bound-fired close is a CLEANUP-side wedge:
 * the journey's assertions have already run, so the verdict must stand on
 * them — a renderer too starved to acknowledge a close() says nothing
 * about the product. Log loudly, force-close the journey's own browser via
 * CDP when one is passed (safe: fresh browser per journey in
 * browser-journeys.test.ts; omit the browser argument for files that share
 * one), and swallow. This also fixes verdict MASKING: previously a
 * finally-side close timeout REPLACED a body error, hiding the real
 * product failure. Body errors and non-bound close errors still propagate.
 */
export async function closeJourneyPage(
  page: Page,
  browser?: Browser | null,
  ms = 10_000
): Promise<void> {
  try {
    await boundedClose(page, ms);
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (!message.includes("exceeded the")) throw error;
    console.error(
      `[browser] ${message} — cleanup-side wedge; the journey verdict stands on its assertions`
    );
    if (browser) await cdpForceClose(browser);
  }
}

/**
 * keyboard.press with a node-side bound. Keyboard input is NOT covered by
 * setDefaultTimeout (no timeout option exists at all) — on a wedged browser
 * process a single press hangs the journey until the test budget burns.
 * B4's sweep presses keys 19 times, so one wedged press is 1/19 of the
 * journey but 100% of its hang.
 */
export function pressB(page: Page, key: string, ms = 5_000): Promise<void> {
  return raceBounded(() => page.keyboard.press(key), ms, `keyboard.press("${key}")`);
}
