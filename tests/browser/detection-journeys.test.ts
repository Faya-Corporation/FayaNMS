/**
 * R50.8 — detection-panel browser journeys (roadmap §10.5, the "Browser
 * tests" group of the R50 test matrix).
 *
 * The HTTP-level detection contract (R50.4) and the pure UI logic layer
 * (R50.6, tests/audit/r50-detection-ui.test.ts) are pinned hermetically;
 * the R50.4–R50.7 live/browser evidence exercised the golden path against
 * real SSH personas. THIS suite adds the layer between them: the operator
 * journeys through the REAL Add-Device sheet in a real browser against the
 * SAME real production topology as tests/browser/browser-journeys.test.ts
 * (standalone build + worker + PostgreSQL + simulator plane, zero mocks):
 *
 *   D6  empty hostname            — Detect is structurally disabled until
 *                                   a hostname exists;
 *   D7  no credential selected /
 *       DNS-only success          — the vendor stage reports its skip
 *                                   honestly and the address stage still
 *                                   resolves (partial success on the wire);
 *   D8  loading state             — Detect is disabled while a detection is
 *                                   in flight (route-delayed for
 *                                   determinism);
 *   D9  duplicate click prevention — the same disabled-pending state makes a
 *                                   second submit structurally impossible
 *                                   (exactly ONE request leaves the page);
 *   D10 typed error toast         — a loopback literal is refused by the
 *                                   target policy BEFORE any credential/
 *                                   trust/network work; the operator sees
 *                                   the honest refusal toast;
 *   D11 field conflict (T062)     — a value the operator typed is never
 *                                   overwritten silently: the Use / Keep-mine
 *                                   chip appears, Keep-mine holds the field;
 *   D12 vendor-stage typed error  — a credential whose vault secret the
 *                                   worker cannot resolve fails with the
 *                                   STABLE code (CREDENTIAL_UNRESOLVED) in
 *                                   the panel while the address stage still
 *                                   succeeds (T061 partial success).
 *
 * Roadmap disposition (docs/audits/FayaNMS-R50.8-Test-Matrix-2026-09-17.md):
 * 7 of the 9 browser cells are pinned HERE (CI-executable in the `browser`
 * job). The remaining two — "successful detection" (a full vendor match) and
 * "vendor-only success" — need a policy-allowed SSH persona on the wire,
 * which the shared e2e topology does not carry; they are covered by the
 * R50.5 five-vendor live wire matrix + browser evidence (verify-r505-*.png)
 * and the R50.6 stage-filter matrix, and are marked LIVE-EVIDENCE in the
 * matrix.
 *
 * Gating: runs ONLY under FAYANMS_BROWSER_E2E=1 (the hermetic unit gate
 * never depends on a browser); CI carries a dedicated `browser` job for it.
 * Execution history (honest): authored R50.8 but never executed green
 * anywhere until CI bring-up unblocked the runners — FIRST real execution
 * was run 35417127704 @ feafb0d, which failed 6/6 on a genuine defect the
 * sandbox could never see (signIn filled #sign-in-email on a never-navigated
 * about:blank page — the goto lived only in openAddDeviceSheet, which runs
 * AFTER sign-in). FIXED R73: signIn navigates first, byte-mirroring the
 * proven TASK-BROWSER-E2E flow that passed 6/6 in the same run.
 *
 * Second iteration (run 35420764756): the fix held — sign-in succeeded —
 * and the failure moved one step deeper, which is WHY the sidebar journey
 * in openAddDeviceSheet expands the "Network" group before clicking
 * "Devices": nav items live inside collapsible groups that auto-open only
 * while they own the active view (dashboard after sign-in ⇒ closed).
 *
 * Third iteration (run 35421797082): 9/12 green (D6, D8+D9, D10 joined the
 * B-suite). The three remaining failures were JOURNEY bugs, fixed here:
 * D7's toast wait used substring matching (strict mode: the live-region
 * wrapper's text contains the title — two resolves) → exact match; D11
 * assumed one chip survives both buttons (using either resolves the
 * conflict) → two passes, Use then Keep-mine; D12 asserted the
 * sandbox-specific CREDENTIAL_UNRESOLVED code, but the CI harness wires
 * the worker to the app's resolver so the probe proceeds and the
 * target-policy plane refuses the loopback dial → the journey now asserts
 * the topology-honest INVARIANT (typed code from the R50 catalog, never a
 * raw stack).
 *
 * Requirements to run:
 *   FAYANMS_BROWSER_E2E=1 bun test tests/browser/detection-journeys.test.ts
 *   # after `bun run build:gate` (shared harness rules apply)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chromium, type Browser, type Page } from "playwright";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  APP_BASE,
  bootE2E,
  teardownE2E,
} from "../e2e/e2e-server";

const BROWSER_E2E_FLAG = "FAYANMS_BROWSER_E2E";
const enabled = process.env[BROWSER_E2E_FLAG] === "1";
const browserTest = test.skipIf(!enabled);

let browser: Browser | null = null;

const AUTO_DETECT_PATH = "/api/v1/devices/auto-detect";

async function signIn(page: Page): Promise<void> {
  // R73 defect fix (run 35417127704): a fresh page is at about:blank — the
  // gate MUST be navigated to BEFORE any fill, exactly like the proven
  // TASK-BROWSER-E2E signIn (tests/browser/browser-journeys.test.ts).
  await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sign-in-email", { state: "visible", timeout: 60_000 });
  await page.fill("#sign-in-email", ADMIN_EMAIL);
  await page.fill("#sign-in-password", ADMIN_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForSelector("#sign-in-title", { state: "detached", timeout: 60_000 });
}

/** Open the authenticated app on the Devices view with the Add sheet up. */
async function openAddDeviceSheet(page: Page): Promise<void> {
  await page.goto(`${APP_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sign-in-title", { state: "detached", timeout: 60_000 });
  // R74 iteration (run 35420764756): "Devices" lives INSIDE the collapsible
  // "Network" sidebar group, which auto-opens only while it owns the active
  // view (sidebar-nav.tsx: `openGroups[group.id] ?? containsActive`). After
  // sign-in the active view is the dashboard, so the group starts CLOSED and
  // the item is not rendered — the same discovery an operator makes. Expand
  // the group (scoped to the sidebar nav), then click the item.
  const nav = page.locator("nav").first();
  const devices = nav.getByRole("button", { name: "Devices", exact: true });
  if (!(await devices.isVisible().catch(() => false))) {
    await nav.getByRole("button", { name: "Network", exact: true }).first().click();
  }
  await devices.first().click();
  await page.getByRole("button", { name: "Add Device" }).first().click();
  await page.waitForSelector("#device-hostname", { state: "visible", timeout: 30_000 });
}

const detectButton = (page: Page) =>
  page.getByRole("button", { name: "Detect vendor and management IP" });

const detectionPanel = (page: Page) => page.locator('div[role="status"][aria-live="polite"]');

describe("R50.8: detection-panel journeys (roadmap §10.5 browser cells)", () => {
  beforeAll(async () => {
    if (!enabled) return;
    await bootE2E();
    browser = await chromium.launch({ headless: true });
  }, 300_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    // bun test files are sequential: later suites re-boot through the
    // liveness-aware bootE2E() if this suite tore the topology down.
    if (enabled) await teardownE2E();
  }, 60_000);

  browserTest(
    "D6: empty hostname — Detect is disabled until a hostname exists",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        expect(await detectButton(page).isDisabled()).toBe(true);
        await page.fill("#device-hostname", "hq-core-sw-01");
        expect(await detectButton(page).isDisabled()).toBe(false);
      } finally {
        await page.close();
      }
    },
    180_000
  );

  browserTest(
    "D7: no credential selected — vendor skip is honest, address still resolves",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        await page.fill("#device-hostname", "localhost");
        await detectButton(page).click();
        // The panel is a live region — wait for the address row verdict.
        await page.getByText("Management address — 127.0.0.1").waitFor({
          state: "visible",
          timeout: 30_000,
        });
        // The vendor stage reports WHY it did not run (T060/T061 honesty).
        await page
          .getByText("Skipped — no credential profile selected")
          .waitFor({ state: "visible", timeout: 10_000 });
        // The success toast names what RAN. (R75: exact match — the toast
        // title div also sits inside a live-region wrapper whose text
        // CONTAINS the title, so substring matching resolves two elements
        // and Playwright strict mode rightly refuses.)
        await page.getByText("Hostname resolved", { exact: true }).waitFor({
          state: "visible",
          timeout: 10_000,
        });
        // T062: an EMPTY field auto-applies the detected value (only a
        // field the operator typed gets the explicit Use / Keep-mine chip).
        expect(await page.inputValue("#device-mgmt-ip")).toBe("127.0.0.1");
      } finally {
        await page.close();
      }
    },
    180_000
  );

  browserTest(
    "D8+D9: loading state + duplicate click prevention — one request per run",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      let detectRequests = 0;
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        // Delay the API so the pending window is observable.
        await page.route(`**${AUTO_DETECT_PATH}`, async (route) => {
          detectRequests += 1;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await route.continue();
        });
        await page.fill("#device-hostname", "localhost");
        await detectButton(page).click();
        // Loading state: the button is disabled WHILE the run is in flight.
        await page
          .getByText("Resolving management address…")
          .waitFor({ state: "visible", timeout: 10_000 });
        expect(await detectButton(page).isDisabled()).toBe(true);
        // Duplicate prevention: the disabled control cannot submit again —
        // the request counter stays at exactly ONE.
        await page.waitForTimeout(1500);
        await page
          .getByText("Management address — 127.0.0.1")
          .waitFor({ state: "visible", timeout: 30_000 });
        expect(detectRequests).toBe(1);
      } finally {
        await page.unroute(`**${AUTO_DETECT_PATH}`).catch(() => undefined);
        await page.close();
      }
    },
    180_000
  );

  browserTest(
    "D10: typed error toast — loopback literal refused by the target policy",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        await page.fill("#device-hostname", "127.0.0.1");
        await detectButton(page).click();
        await page.getByText("Auto-detect failed").waitFor({ state: "visible", timeout: 30_000 });
        // The honest, typed refusal copy (not a raw stack or a generic 500).
        await page
          .getByText("refused by the target network policy", { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 10_000 });
      } finally {
        await page.close();
      }
    },
    180_000
  );

  browserTest(
    "D11: field conflict (T062) — Use applies, Keep-mine holds the operator's value",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        await page.fill("#device-hostname", "localhost");
        await page.fill("#device-mgmt-ip", "10.99.99.99");
        await detectButton(page).click();
        // The detected value must NOT silently overwrite the typed one —
        // the explicit pick chip appears instead. ONE chip carries BOTH
        // buttons and using either resolves the conflict (the chip goes
        // away), so the two T062 semantics are exercised in two passes:
        // first Use applies the staged value…
        const chip = page.getByText("Detected Management IP:", { exact: false });
        await chip.waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: "Use", exact: true }).click();
        expect(await page.inputValue("#device-mgmt-ip")).toBe("127.0.0.1");
        // …then Keep-mine holds the operator's value.
        await page.fill("#device-mgmt-ip", "10.99.99.99");
        await detectButton(page).click();
        await chip.waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: "Keep mine", exact: true }).click();
        expect(await page.inputValue("#device-mgmt-ip")).toBe("10.99.99.99");
      } finally {
        await page.close();
      }
    },
    180_000
  );

  browserTest(
    "D12: vendor-stage typed error — stable code in the panel, address still succeeds",
    async () => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await signIn(page);
        await openAddDeviceSheet(page);
        await page.fill("#device-hostname", "localhost");
        // Select the seeded SSH_PASSWORD profile; the e2e worker carries no
        // vault secret for it, so the vendor probe fails TYPED.
        await page.getByLabel("Credential profile").click();
        await page.getByRole("option", { name: /Network Admin/ }).first().click();
        await detectButton(page).click();
        // Vendor row: the failure leads with the typed code.
        await page.getByText("Vendor detection failed").waitFor({
          state: "visible",
          timeout: 30_000,
        });
        // Vendor row: the failure leads with a TYPED code. WHICH stable code
        // is topology-honest (R75, run 35421797082): the sandbox premise
        // (CREDENTIAL_UNRESOLVED — the worker cannot resolve the vault
        // secret) holds only where the worker is walled off from resolution;
        // the CI harness wires the worker to the app's resolver, so the
        // probe proceeds and the TARGET-POLICY plane refuses the loopback
        // dial (no lab hatch in CI, by design). Both are stable codes from
        // the R50 catalog — the journey asserts the INVARIANT (typed
        // refusal, never a raw stack), not one sandbox-specific code.
        await page
          .locator('div[role="status"][aria-live="polite"]')
          .getByText(/(CREDENTIAL_UNRESOLVED|SSH_TARGET_POLICY_REFUSED|SSH_UNREACHABLE)/)
          .first()
          .waitFor({ state: "visible", timeout: 10_000 });
        // T061 partial success: the OTHER stage's truth is still visible.
        await page.getByText("Management address — 127.0.0.1").waitFor({
          state: "visible",
          timeout: 10_000,
        });
      } finally {
        await page.close();
      }
    },
    240_000
  );
});
