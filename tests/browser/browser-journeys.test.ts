/**
 * TASK-BROWSER-E2E — rendering-layer browser journeys.
 *
 * The HTTP-level E2E journeys (tests/e2e/, R39) prove the topology without
 * a browser. THIS suite adds the layer an operator actually touches: real
 * headless-Chromium journeys against the SAME real production topology
 * (tests/e2e/e2e-server.ts — standalone production build + worker +
 * PostgreSQL + simulator plane, zero mocks):
 *
 *   B1  sign-in journey — the sign-in gate renders, real credentials go
 *       through the REAL NextAuth client flow, the app shell takes over,
 *       and sign-out returns to the gate;
 *   B2  dashboard render — the authenticated shell's primary controls are
 *       actually present and visible in a real viewport;
 *   B3  axe-core accessibility scans (wcag2a/aa + best-practice) of the
 *       sign-in page AND the authenticated dashboard — no critical or
 *       serious violations. A journey whose browser process wedges
 *       mid-flight (probe-confirmed unresponsive) is re-run ONCE on a
 *       fresh browser (the environment-wedge path — a COMPLETED journey's
 *       verdict is never retried or masked);
 *   B4  keyboard-only sweeps — focus moves through the sign-in form and
 *       across the dashboard shell without ever falling back to <body>;
 *   B5  RTL sweep — switching the locale to العربية flips <html dir> to
 *       rtl in a live browser and the dashboard reflows without horizontal
 *       overflow, then back to English/ltr.
 *
 * Gating: the suite runs ONLY under FAYANMS_BROWSER_E2E=1 (the hermetic
 * unit gate never depends on a browser); CI carries a dedicated `browser`
 * job for it (runner-blocked today like every CI job — CI-001, recorded
 * honestly per push). Governance pins: tests/audit/browser-e2e-governance.test.ts.
 *
 * Requirements to run:
 *   FAYANMS_BROWSER_E2E=1 bun test tests/browser/     # after `bun run build:gate`
 *   (a PostgreSQL at DATABASE_URL with CREATEDB — shared harness rules apply)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createRequire } from "node:module";

import { chromium, type Browser, type Page } from "playwright";

import { boundedBrowserClose, boundedClose, boundedNewPage, closeJourneyPage, pressB, probeBrowserHealthy } from "./harness-bounds";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  APP_BASE,
  bootE2E,
  teardownE2E,
} from "../e2e/e2e-server";

const BROWSER_E2E_FLAG = "FAYANMS_BROWSER_E2E";

/** axe-core injected from the declared devDependency (never a CDN). */
const require_ = createRequire(import.meta.url);
const AXE_SOURCE = require_.resolve("axe-core/axe.min.js");

interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
  any: { id: string; data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } }[];
}
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: AxeNode[];
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * Bounded axe scan. The bound lives on the NODE side of page.evaluate — an
 * in-page timer cannot rescue a frozen renderer (it lives in the renderer).
 * A starved scan now rejects at 60 s and the page is closed to reclaim the
 * renderer, failing the journey fast instead of hanging until the test-runner
 * watchdog kills the shared e2e stack and cascades the rest of the file.
 * Real violations are NEVER retried or masked: a completed scan's verdict is
 * final; only the bound-expiry path is typed. Journeys run through
 * runJourneyWithWedgeRetry, which re-runs the WHOLE journey once when the
 * wedge probe confirms the browser PROCESS went unresponsive mid-flight.
 */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  const AXE_BOUND_MS = 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // addScriptTag MUST live inside the raced region: it has NO timeout
      // concept at all, and injecting the script goes through the renderer —
      // a starved renderer hangs it indefinitely (the surviving B3b 240s
      // burn: run 13 local; the F-068 commit message claimed this was moved
      // inside the race, but the code had it still outside — this IS the
      // move). The whole inject+scan now shares one 60s node-side bound.
      (async () => {
        await page.addScriptTag({ path: AXE_SOURCE });
        return await page.evaluate(async (tags: string[]) => {
          // axe is injected as a global script (no module system on the page).
          // Signature: axe.run(context, options) — the tag filter rides in
          // runOnly, NEVER as the context argument.
          const axeGlobal = (
            window as unknown as {
              axe: {
                run: (
                  context: Document,
                  options: { runOnly: { type: string; values: string[] } }
                ) => Promise<{ violations: AxeViolation[] }>;
              };
            }
          ).axe;
          const results = await axeGlobal.run(document, {
            runOnly: { type: "tags", values: tags },
          });
          return results.violations;
        }, TAGS);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timer = undefined;
          void boundedClose(page).catch(() => undefined);
          reject(new Error("axe.run exceeded the node-side bound; page reclaimed"));
        }, AXE_BOUND_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatViolations(violations: AxeViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.impact ?? "unknown"}: ${v.id} — ${v.help}\n` +
        v.nodes
          .map((n) => {
            const contrast = n.any?.find((c) => typeof c.data?.contrastRatio === "number")?.data;
            return `  · ${n.target.join(" ")} | ${n.html.slice(0, 140)}${
              contrast ? ` | ratio ${contrast.contrastRatio?.toFixed(2)} fg ${contrast.fgColor} bg ${contrast.bgColor}` : ""
            }`;
          })
          .join("\n")
    )
    .join("\n");
}

/** Fill + submit the real sign-in form and wait for the app shell. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sign-in-email", { state: "visible", timeout: 20_000 });
  await page.fill("#sign-in-email", ADMIN_EMAIL);
  await page.fill("#sign-in-password", ADMIN_PASSWORD);
  await page.click("button[type=submit]");
  // The shell takes over client-side: the header user menu appears and the
  // sign-in gate disappears.
  await page.waitForSelector('header [aria-label="User menu"]', {
    state: "visible",
    timeout: 20_000,
  });
}

let browser: Browser | undefined;

/**
 * Bounded evaluate. page.evaluate has NO timeout: a starved or crashed
 * renderer hangs the journey forever, which the test-runner watchdog then
 * punishes by killing the shared e2e stack — cascading every later journey
 * to CONNECTION_REFUSED. Race a Node timer instead; on timeout, close the
 * page to reclaim the renderer and fail the journey fast.
 */
async function evalB<T>(page: Page, fn: () => T | Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`page.evaluate exceeded the ${ms}ms bound`)),
          ms
        );
      }),
    ]);
  } catch (error) {
    if (String((error as Error)?.message ?? "").includes("exceeded the")) {
      await boundedClose(page).catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function newJourneyPage(options: {
  viewport: { width: number; height: number };
}): Promise<Page> {
  // Bounded: newPage has NO timeout of its own and setDefaultTimeout only
  // covers the page it creates — a wedged browser process would hang the
  // journey here. The helper also bounds every action/navigation of the
  // returned page at 30 s (Playwright actions default to UNLIMITED — on a
  // starved renderer a single wedged click would hang the journey until the
  // watchdog kill cascades the stack).
  const page = await boundedNewPage(browser!, options);
  page.on("crash", () => {
    console.error("[browser] Playwright page crash detected");
  });
  return page;
}

/**
 * Journey browser launch — shared by beforeEach AND the wedge retry
 * (the retry must be able to relaunch a browser that died with its wedged
 * renderer). The retry path passes a tighter bound: a launch that cannot
 * come up in 60s on the loaded runner fails fast with a named bound
 * instead of eating the whole test budget.
 */
function launchJourneyBrowser(timeoutMs = 120_000): Promise<Browser> {
  return chromium.launch({
    headless: true,
    // Bounded launch: a starved driver must fail this hook fast (the next
    // journey's fresh launch takes over) instead of hanging it to the hook
    // timeout. 120s, not less: a full-suite run shares the box with the
    // app, worker, postgres AND the other browser file's Chromium — a
    // locally-observed launch under that load exceeded 60s (the 60s bound
    // fired → B4 hook fail; the same journey in isolation launches in ~2s).
    // 120s still
    // leaves >2x headroom inside the 300s hook budget. dev-shm: CI runners
    // have tiny /dev/shm. The backgrounding/throttling disables keep
    // headless renderers from being deprioritized mid-scan — renderer
    // starvation was the observed indefinite page.evaluate hang in every
    // real CI run so far.
    timeout: timeoutMs,
    args: [
      "--disable-dev-shm-usage",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
  });
}

/**
 * Journey-level wedge retry: run `body` on a fresh journey page; if it
 * throws AND a bounded probe shows the browser PROCESS unresponsive,
 * force-reclaim that browser, launch a fresh one, and re-run the whole
 * body ONCE.
 *
 * CI evidence (runs 36805529852, 36909917240): exactly ONE journey per
 * suite attempt fails late (journey ≈9–12 of the process lifetime) with a
 * typed bound — the axe 60s node-side bound (B3b attempt 1 / B3a attempt 2
 * in the first run), or waitForSelector's 20s timeout followed by
 * `page.close` (10s) AND `browser.close` (12s) wedging (B5 attempt 1 in
 * the second). In the second run the page-level retry (28f165f) fired
 * correctly and still failed: its `browser.newPage` hung the FULL 60s
 * bound in the SAME browser. The wedge is therefore browser-PROCESS-level,
 * not per-renderer — and a fresh browser launch is always healthy (B4/B5
 * passed 1–2s immediately after the force-close in both runs).
 *
 * The probe is the honesty discriminator: a COMPLETED journey is final and
 * never re-run; a journey whose browser ANSWERS the probe failed for real
 * (product regression, assertion, healthy-renderer timeout) and its error
 * propagates verbatim; only a probe-confirmed unresponsive browser — an
 * environment wedge, never a product verdict — triggers the one re-run.
 * Deterministic product failures still fail both CI attempts.
 *
 * Budgets (realistic wedge path = failing body + close ≤15s + probe 15s +
 * reclaim/relaunch ≤17s + healthy body re-run): B1/B2/B4 ≈100–130s < 180s;
 * B3a ≈160s < 180s (the 60s scan bound dominates); B3b ≈200s < 240s; B5's
 * own 90s operator-retry sweep re-runs too → budget 240s→300s.
 */
async function runJourneyWithWedgeRetry(
  label: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // If the browser is gone entirely (crash, previous force-close),
    // replace it before the journey starts.
    if (!browser || !browser.isConnected()) {
      await boundedBrowserClose(browser);
      browser = await launchJourneyBrowser();
    }
    const currentBrowser: Browser = browser;
    const page = await newJourneyPage({ viewport: { width: 1440, height: 900 } });
    let bodyError: unknown;
    try {
      await body(page);
      return; // COMPLETED journey — the verdict is final, never retried.
    } catch (error) {
      bodyError = error;
    } finally {
      await closeJourneyPage(page, currentBrowser);
    }
    if (attempt === 2) throw bodyError;
    // Wedge probe (see probeBrowserHealthy): answers → the body error is
    // the real verdict; unresponsive → environment wedge, re-run once.
    if (await probeBrowserHealthy(currentBrowser, 15_000)) throw bodyError;
    console.error(
      `[browser] ${label}: browser process wedge CONFIRMED (probe unresponsive) — ` +
        "force-reclaiming and re-running the journey once on a fresh browser"
    );
    await boundedBrowserClose(currentBrowser);
    browser = await launchJourneyBrowser(60_000);
  }
  /* unreachable: attempt 2 either returns or throws */
  throw new Error("unreachable: journey wedge-retry loop exited");
}

const enabled = process.env[BROWSER_E2E_FLAG] === "1";

/** Modifier that skips each journey unless the flag is set (hermetic default). */
const browserTest = test.skipIf(!enabled);

describe("TASK-BROWSER-E2E: rendering-layer journeys (real Chromium × real topology)", () => {
  beforeAll(async () => {
    if (!enabled) return;
    await bootE2E();
  }, 300_000);

  // Journey isolation is DOUBLE: each journey gets a FRESH Chromium (the
  // repo's validated design — a wedged browser can never poison the next
  // journey) and a liveness-checked stack. A shared browser was tried and
  // rejected locally: its occasional mid-file death ("Target page, context
  // or browser has been closed") reproduced the very cascade this file
  // guards against.
  beforeEach(async () => {
    if (!enabled) return;
    // Self-healing: the previous journey's timeout kill may have taken the
    // e2e app down with it (watchdog dangling-process cleanup). bootE2E is
    // liveness-aware and idempotent — one /api/v1/meta fetch when alive, a
    // full re-boot when not — so no journey ever starts against a dead stack
    // and one failure can never cascade into CONNECTION_REFUSED noise.
    await bootE2E();
    browser = await launchJourneyBrowser();
  }, 300_000);

  afterEach(async () => {
    // Bounded + force-kill reclaim: a wedged driver used to burn the full
    // 60s hook timeout and linger until bun's dangling-kill reaped the
    // children — together with the shared e2e app (run 36799654823:
    // `[e2e:app] exited 143` collateral, leaked spinners degrading the CI
    // re-run). Fresh-browser-per-journey makes SIGKILL reclaim safe.
    await boundedBrowserClose(browser);
    browser = undefined;
  }, 60_000);

  afterAll(async () => {
    await boundedBrowserClose(browser);
    // bun test files are sequential: the HTTP journeys re-boot through the
    // liveness-aware bootE2E() if this suite ran first and tore down.
    if (enabled) await teardownE2E();
  }, 60_000);

  browserTest(
    "B1: sign-in journey — gate renders, real credentials sign in, sign-out returns",
    async () => {
      await runJourneyWithWedgeRetry("B1", async (page) => {
        await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#sign-in-title", { state: "visible", timeout: 20_000 });
        expect(await page.locator("#sign-in-email").isVisible()).toBe(true);

        // Wrong credentials → the honest generic error, still on the gate.
        await page.fill("#sign-in-email", ADMIN_EMAIL);
        await page.fill("#sign-in-password", "definitely-wrong");
        await page.click("button[type=submit]");
        await page.waitForSelector("text=Invalid email or password.", { timeout: 15_000 });

        // Real credentials through the REAL NextAuth client flow.
        await signIn(page);
        expect(await page.locator("#sign-in-title").count()).toBe(0);

        // Sign out through the real user menu → back to the gate.
        await page.click('header [aria-label="User menu"]');
        await page.waitForSelector("text=Sign out", { state: "visible", timeout: 15_000 });
        await page.click("text=Sign out");
        await page.waitForSelector("#sign-in-title", { state: "visible", timeout: 20_000 });
      });
    },
    180_000
  );

  browserTest(
    "B2: dashboard render — the authenticated shell exposes its primary controls",
    async () => {
      await runJourneyWithWedgeRetry("B2", async (page) => {
        await signIn(page);
        expect(
          await page.isVisible('header [aria-label="Search (opens command palette)"]')
        ).toBe(true);
        expect(await page.isVisible('header [aria-label="Open job center"]')).toBe(true);
        expect(await page.isVisible('header [aria-label="Switch language"]')).toBe(true);
        // The sidebar navigation is really rendered (not just mounted).
        expect(await page.locator("nav").first().isVisible()).toBe(true);
      });
    },
    180_000
  );

  browserTest(
    "B3a: axe scan — sign-in page has no critical/serious accessibility violations",
    async () => {
      await runJourneyWithWedgeRetry("B3a", async (page) => {
        await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#sign-in-title", { state: "visible", timeout: 20_000 });
        const violations = (await runAxe(page)).filter(
          (v) => v.impact === "critical" || v.impact === "serious"
        );
        expect(formatViolations(violations) || "(none)").toBe("(none)");
      });
    },
    180_000
  );

  browserTest(
    "B3b: axe scan — authenticated dashboard has no critical/serious violations",
    async () => {
      await runJourneyWithWedgeRetry("B3b", async (page) => {
        await signIn(page);
        // networkidle has NO default timeout in Playwright (waits forever) —
        // unbounded it burned B3b's whole 240s budget when the dashboard's
        // react-query polling never let the network go idle (run 11 local,
        // run 36799654823 B3b class). The settle is best-effort by design;
        // bound it so it can only ever cost 15s.
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        const violations = (await runAxe(page)).filter(
          (v) => v.impact === "critical" || v.impact === "serious"
        );
        expect(formatViolations(violations) || "(none)").toBe("(none)");
      });
    },
    240_000
  );

  browserTest(
    "B4: keyboard-only sweep — focus flows through the form and the shell, never lost",
    async () => {
      await runJourneyWithWedgeRetry("B4", async (page) => {
        await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#sign-in-email", { state: "visible", timeout: 20_000 });

        // First Tab from the body lands on an interactive element.
        await pressB(page, "Tab");
        const first = await evalB(page, () => document.activeElement?.tagName ?? "BODY");
        expect(first).not.toBe("BODY");

        // From the email field, the submit button is keyboard-reachable
        // (the Tab path may pass the show-password toggle and demo-account
        // quick-fill buttons — what matters is focus RETAINS and the form
        // is operable without a pointer).
        await page.focus("#sign-in-email");
        let reachedSubmit = false;
        for (let i = 0; i < 6 && !reachedSubmit; i++) {
          await pressB(page, "Tab");
          reachedSubmit = await evalB(page, () => {
            const el = document.activeElement;
            return el?.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit";
          });
        }
        expect(reachedSubmit).toBe(true);

        // Sign in and sweep the shell: 12 Tabs always retain focus on an
        // interactive element (BUTTON/A/INPUT/... — never the body).
        await page.fill("#sign-in-email", ADMIN_EMAIL);
        await page.fill("#sign-in-password", ADMIN_PASSWORD);
        await page.click("button[type=submit]");
        await page.waitForSelector('header [aria-label="User menu"]', {
          state: "visible",
          timeout: 20_000,
        });
        await evalB(page, () => (document.activeElement as HTMLElement | null)?.blur());
        for (let i = 0; i < 12; i++) {
          await pressB(page, "Tab");
          const state = await evalB(page, () => {
            const el = document.activeElement;
            const interactive =
              el !== null &&
              ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
            return { tag: el?.tagName ?? "BODY", interactive };
          });
          expect(state.tag).not.toBe("BODY");
          expect(state.interactive).toBe(true);
        }
      });
    },
    180_000
  );

  browserTest(
    "B5: RTL sweep — العربية flips <html dir> to rtl with no horizontal overflow (and back)",
    async () => {
      await runJourneyWithWedgeRetry("B5", async (page) => {
        await signIn(page);

        const overflowOf = (): Promise<{ scroll: number; client: number; dir: string; lang: string }> =>
          evalB(page, () => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            dir: document.documentElement.dir,
            lang: document.documentElement.lang,
          }));

        const ltr = await overflowOf();
        expect(ltr.dir).toBe("ltr");
        expect(ltr.scroll).toBeLessThanOrEqual(ltr.client + 1);

        await page.click('header [aria-label="Switch language"]');
        await page.waitForSelector('div[role="menu"]', { state: "visible", timeout: 20_000 });
        await page.click('div[role="menuitem"]:has-text("العربية")');
        await page.waitForFunction(() => document.documentElement.dir === "rtl", undefined, {
          timeout: 20_000,
        });

        const rtl = await overflowOf();
        expect(rtl.dir).toBe("rtl");
        expect(rtl.scroll).toBeLessThanOrEqual(rtl.client + 1);

        // Back to English — the sweep leaves the preferences clean. The
        // switcher's aria-label is LOCALIZED (it now reads the Arabic
        // string), which is itself an i18n honesty pin. The RTL flip
        // re-renders the header, so the menu is opened via KEYBOARD
        // (focus + Enter) — a pointer click races the re-mount and can be
        // dropped. Under load the renderer can also starve the open OR the
        // click's stability wait (CI run 36799654823 + local full-suite
        // reproductions: the popper repositions and the menuitem churns;
        // idle-box probes show the product is FINE — menu stable, item
        // click settles in 114ms). An operator presses again: the whole
        // reopen→click interaction retries once with per-step bounds; the
        // strict final verification (dir must flip back to ltr) stays
        // OUTSIDE the loop and still fails the journey if the sweep cannot
        // complete. Worst case ≈ 90s + 30s verification, inside the 180s
        // test budget.
        let backToEnglish = false;
        for (let attempt = 1; attempt <= 2 && !backToEnglish; attempt++) {
          try {
            await page.focus('[aria-label="تغيير اللغة"]', { timeout: 12_000 });
            await pressB(page, "Enter");
            await page.waitForSelector('div[role="menu"]', {
              state: "visible",
              timeout: 8_000,
            });
            await page.click('div[role="menuitem"]:has-text("English")', {
              timeout: 15_000,
            });
            backToEnglish = true;
          } catch (error) {
            if (attempt === 2) throw error;
            console.error(
              `[browser] B5 back-to-English attempt ${attempt} failed (` +
                String((error as Error)?.message ?? "").split("\n")[0] +
                ") — retrying like an operator would"
            );
            // Escape any half-open menu before retrying.
            await pressB(page, "Escape").catch(() => undefined);
          }
        }
        await page.waitForFunction(() => document.documentElement.dir === "ltr", undefined, {
          timeout: 20_000,
        });
      });
    },
    // Budget fits the resized bounds AND the journey-level wedge retry
    // (runJourneyWithWedgeRetry): the body's own worst case ≈ 90s operator
    // sweep + 30s verification; the wedge path re-runs the body once more
    // after close ≤15s + probe 15s + reclaim/relaunch ≤17s => ≈ 247s, so
    // 240s → 300s. The sweep's and the retry's re-runs are interaction /
    // environment recovery, not assertion weakening.
    300_000
  );
});
