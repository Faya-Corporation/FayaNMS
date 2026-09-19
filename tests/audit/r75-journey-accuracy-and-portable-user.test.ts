/**
 * R75 — CI bring-up iteration 6: journey-accurate D-tests + portable
 * non-root user in the app image.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §11):
 * run 35421797082 @ af91847 — gate GREEN fourth consecutive, e2e GREEN third
 * consecutive, browser 9/12 (D6, D8+D9, D10 joined the green B-suite), scan
 * reached the image build again:
 *   - D7 (2.4 s): Playwright STRICT-mode refusal — the toast-title wait used
 *     substring matching and the live-region wrapper's text CONTAINS the
 *     title, so getByText resolved TWO elements. The app behaved correctly.
 *     FIX: exact match on the title.
 *   - D11 (30 s): the test assumed one conflict chip survives both buttons;
 *     the component resolves the conflict with EITHER button (the chip then
 *     goes away), so "Keep mine then Use" on one chip is impossible by
 *     design. FIX: two passes — Use applies the staged value, then re-type +
 *     re-detect and Keep-mine holds the operator's value.
 *   - D12 (12.9 s): the journey asserted the sandbox-specific
 *     CREDENTIAL_UNRESOLVED code; the CI harness wires the worker to the
 *     app's resolver, so the probe proceeds and the target-policy plane
 *     refuses the loopback dial (no lab hatch in CI). FIX: assert the
 *     topology-honest invariant — a typed code from the R50 catalog, never a
 *     raw stack — while keeping the T061 partial-success assertion.
 *   - scan: the app image build died at `addgroup: not found` (exit 127) —
 *     the digest-pinned oven/bun slim base ships neither adduser nor
 *     addgroup, and the runtime stage had never executed before R74. FIX:
 *     register the pinned uid/gid 10001 directly via /etc/passwd +
 *     /etc/group appends (same non-root result, no packages, no network).
 *
 * These pins freeze the journey fixes and the portable user registration.
 * They never execute the harness, docker, or a browser.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DETECTION = read("tests/browser/detection-journeys.test.ts");
const DOCKERFILE = read("Dockerfile");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R75-A: the D-journeys match the UI's real conflict semantics", () => {
  test("D7 waits on the toast title with an exact match (strict-mode safe)", () => {
    const d7 = DETECTION.slice(
      DETECTION.indexOf('"D7: no credential selected'),
      DETECTION.indexOf('"D8+D9:')
    );
    expect(d7).toContain('getByText("Hostname resolved", { exact: true })');
    expect(d7).not.toContain('getByText("Hostname resolved")');
  });

  test("D11 exercises Use and Keep-mine in two passes, not one impossible chip", () => {
    const d11 = DETECTION.slice(
      DETECTION.indexOf('"D11: field conflict'),
      DETECTION.indexOf('"D12: vendor-stage')
    );
    const use = d11.indexOf('name: "Use", exact: true');
    const keep = d11.indexOf('name: "Keep mine", exact: true');
    const refill = d11.indexOf('page.fill("#device-mgmt-ip", "10.99.99.99")');
    expect(use, "Use click exists").toBeGreaterThan(-1);
    expect(keep, "Keep-mine click exists").toBeGreaterThan(-1);
    expect(use < keep, "Use pass BEFORE Keep-mine pass").toBeTrue();
    expect(refill, "re-type between the passes").toBeGreaterThan(-1);
    expect(d11).toContain("two passes");
  });

  test("D12 asserts the typed-code invariant, not one sandbox-specific code", () => {
    // D12 is the LAST test — slice from its name to the end of file (the
    // describe block opens BEFORE D6, so the describe line cannot bound it).
    const d12 = DETECTION.slice(DETECTION.indexOf('"D12: vendor-stage'));
    expect(d12).toContain("CREDENTIAL_UNRESOLVED|SSH_TARGET_POLICY_REFUSED|SSH_UNREACHABLE");
    expect(d12).toContain("Management address — 127.0.0.1");
    // the sandbox-specific single-code wait is gone
    expect(d12).not.toContain('getByText("CREDENTIAL_UNRESOLVED", { exact: false })');
  });
});

describe("R75-B: the app image registers its non-root user portably", () => {
  test("pinned uid/gid via passwd/group appends, no adduser dependency", () => {
    expect(DOCKERFILE).toContain('echo "faya:x:10001:10001::/app:/bin/false" >> /etc/passwd');
    expect(DOCKERFILE).toContain('echo "faya:x:10001:" >> /etc/group');
    // no COMMAND dependency on the (absent) binaries — the R75 comment
    // mentioning them by name is documentation, not usage
    expect(DOCKERFILE).not.toContain("addgroup --system");
    expect(DOCKERFILE).not.toContain("adduser --system");
    expect(DOCKERFILE).toContain("35421797082");
    // the COPY ownership and USER directive keep referencing the same user
    expect(DOCKERFILE).toContain("COPY --from=build --chown=faya:faya");
    expect(DOCKERFILE).toContain("USER faya");
  });

  test("the worker image needs no user registration (base's own bun user)", () => {
    const worker = read("Dockerfile.worker");
    expect(worker).toContain("USER bun");
    expect(worker).not.toContain("addgroup");
    expect(worker).not.toContain("adduser");
  });
});

describe("R75-C: the run record is frozen in the audit doc", () => {
  test("iteration-6 facts recorded (9/12 + three journey bugs + exit 127)", () => {
    expect(DOC).toContain("## 11. R75 ADDENDUM");
    expect(DOC).toContain("35421797082");
    expect(DOC).toContain("9/12");
    expect(DOC).toContain("addgroup: not found");
    expect(DOC).toContain("strict");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["detection-journeys", DETECTION],
      ["Dockerfile", DOCKERFILE],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
