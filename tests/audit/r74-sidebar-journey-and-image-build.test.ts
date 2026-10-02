/**
 * R74 — CI bring-up iteration 5: sidebar-group journey + image build-arg.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §10):
 * run 35420764756 @ 7a9a34f — gate GREEN (third consecutive), e2e GREEN
 * (second consecutive), trivy fs GREEN (the R73 skip-files proven on the
 * wire) — and the two remaining failures both moved to deeper never-executed
 * layers:
 *   - browser: the D-file's signIn fix held (no more about:blank timeouts);
 *     all six journeys then waited for the "Devices" button, which is
 *     rendered INSIDE the collapsible "Network" sidebar group — auto-open
 *     only while the group owns the active view (dashboard after sign-in ⇒
 *     closed; sidebar-nav.tsx `openGroups[group.id] ?? containsActive`).
 *     FIX: openAddDeviceSheet expands the group (scoped to the sidebar nav)
 *     before clicking the item — the same journey an operator performs.
 *   - scan: the image-build step's FIRST execution was refused by the
 *     Dockerfile's own T1 guard (the then-mandatory NEXT_PUBLIC_SITE_URL
 *     build-arg); the fix passed an IETF-reserved example.com origin for
 *     the SCAN-TARGET images. HISTORY NOTE: F-026 (batch 9) retired the
 *     whole build-time origin contract — the origin is the RUNTIME
 *     SITE_URL (per-request resolution), the build passes NO site-URL
 *     arg, and the client bundles ship origin-free.
 *
 * These pins freeze the group-expansion journey, the build-arg provenance,
 * and the run record. They never execute the harness or docker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DETECTION = read("tests/browser/detection-journeys.test.ts");
const CI = read(".github/workflows/ci.yml");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R74-A: the Devices journey expands the sidebar group like an operator", () => {
  test("openAddDeviceSheet opens the Network group when Devices is not visible", () => {
    const fn = DETECTION.slice(
      DETECTION.indexOf("async function openAddDeviceSheet"),
      DETECTION.indexOf("const detectButton =")
    );
    expect(fn).toContain('getByRole("button", { name: "Network", exact: true })');
    expect(fn).toContain('getByRole("button", { name: "Devices", exact: true })');
    // the group expansion is scoped to the sidebar nav, not the whole page
    expect(fn).toContain('locator("nav").first()');
    // the expansion happens BEFORE the Devices click, guarded by visibility
    const visibleGuard = fn.indexOf("isVisible()");
    const networkClick = fn.indexOf('name: "Network", exact: true');
    const devicesClick = fn.indexOf("devices.first().click()");
    expect(visibleGuard, "visibility guard exists").toBeGreaterThan(-1);
    expect(visibleGuard < networkClick, "guard before Network click").toBeTrue();
    expect(networkClick < devicesClick, "Network click before Devices click").toBeTrue();
  });

  test("the second-iteration record is in the file header (run id + why)", () => {
    expect(DETECTION).toContain("35420764756");
    expect(DETECTION).toContain("collapsible");
    expect(DETECTION).toContain("openGroups[group.id] ?? containsActive");
  });
});

describe("R74-B: the CI image build satisfies the production origin guard honestly", () => {
  test("the app image build passes NO site-URL arg (F-026 runtime-only origin)", () => {
    const step = CI.slice(
      CI.indexOf("- name: Build runtime images (app + worker)"),
      CI.indexOf("- name: Image scan — app")
    );
    expect(step).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(step).toContain("--build-arg FAYANMS_SOURCE_SHA=$GITHUB_SHA");
    // The worker has no origin guard, but still carries source provenance.
    expect(step).toMatch(/docker build -f Dockerfile\.worker\b[^\r\n]*--build-arg FAYANMS_SOURCE_SHA=\$GITHUB_SHA[^\r\n]*-t fayanms-worker:ci \./);
  });

  test("the triage note records the guard provenance and the F-026 retirement", () => {
    expect(CI).toContain("35420764756");
    // F-026 (batch 9): the build-time origin guard era is recorded as
    // HISTORY and its retirement is stated in the CI comment itself.
    expect(CI).toContain("src/lib/brand/site-url.ts");
    expect(CI).toContain("F-026 (batch 9) retired that contract");
    // the example.com origin must NOT appear as any runtime default elsewhere
    const identity = read("src/lib/brand/identity.ts");
    expect(identity).not.toContain("ci-gate.fayanms.example.com");
  });
});

describe("R74-C: the run record is frozen in the audit doc", () => {
  test("iteration-5 facts recorded (gate ×3, e2e ×2, trivy green, two deeper layers)", () => {
    expect(DOC).toContain("## 10. R74 ADDENDUM");
    expect(DOC).toContain("35420764756");
    expect(DOC).toContain("third consecutive");
    expect(DOC).toContain("containsActive");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["detection-journeys", DETECTION],
      ["ci.yml", CI],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
