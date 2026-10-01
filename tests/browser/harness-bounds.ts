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

/** browser.newPage with a node-side bound + bounded per-action defaults. */
export async function boundedNewPage(
  browser: Browser,
  options: Parameters<Browser["newPage"]>[0],
  ms = 30_000
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
 * keyboard.press with a node-side bound. Keyboard input is NOT covered by
 * setDefaultTimeout (no timeout option exists at all) — on a wedged browser
 * process a single press hangs the journey until the test budget burns.
 * B4's sweep presses keys 19 times, so one wedged press is 1/19 of the
 * journey but 100% of its hang.
 */
export function pressB(page: Page, key: string, ms = 10_000): Promise<void> {
  return raceBounded(() => page.keyboard.press(key), ms, `keyboard.press("${key}")`);
}
