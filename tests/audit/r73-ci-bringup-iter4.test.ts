/**
 * R73 — CI bring-up iteration 4: first green e2e + D-file missing-goto defect
 * + trivy triage.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §9):
 * run 35417127704 @ feafb0d — gate GREEN a second consecutive time, e2e went
 * GREEN FOR THE FIRST TIME IN REPO HISTORY (the R72 seed-KEK fix proven on the
 * wire), the main TASK-BROWSER-E2E suite went first-time green 6/6 — but:
 *   - browser: ALL of tests/browser/detection-journeys.test.ts failed 6/6 —
 *     its signIn() filled #sign-in-email on a never-navigated about:blank page
 *     (the goto lived only in openAddDeviceSheet, which runs after sign-in).
 *     First real execution anywhere (sandbox could never run it) → genuine
 *     defect. FIX: signIn navigates first, byte-mirroring the proven B-file.
 *   - scan: gitleaks GREEN (R72 allowlist proven); trivy fs exited 1 on its
 *     ONLY finding — the committed test-only loopback SFOS harness key
 *     (P1-019 non-authority, gitleaks-trialed R72). FIX: dedicated
 *     skip-files input scoped to harness/tls/* (triage inline) + .dockerignore
 *     excludes the TLS fixtures from image layers (lazy PEM reads verified).
 * Machine proof: checksum-verified trivy 0.70.0 on a byte-faithful git archive
 * tree — no skip → exit 1 single HIGH secret; with skip → exit 0, zero
 * findings.
 *
 * These pins freeze the goto-before-fill ordering, the trivy triage scope
 * (against silent widening), the dockerignore exclusion, and the run record.
 * They never execute the harness or trivy.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DETECTION = read("tests/browser/detection-journeys.test.ts");
const CI = read(".github/workflows/ci.yml");
const GITLEAKS = read(".gitleaks.toml");
const DOCKERIGNORE = read(".dockerignore");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R73-A: the detection journeys navigate BEFORE any sign-in fill", () => {
  test("signIn performs goto (and waits for the gate) before filling the email", () => {
    const fn = DETECTION.slice(
      DETECTION.indexOf("async function signIn"),
      // anchor on the DEFINITION — the bare name also appears in the header
      DETECTION.indexOf("async function openAddDeviceSheet")
    );
    const goto = fn.indexOf("page.goto(`${APP_BASE}/`");
    const waitFor = fn.indexOf('#sign-in-email", { state: "visible"');
    const fill = fn.indexOf('page.fill("#sign-in-email"');
    expect(goto, "goto must exist inside signIn").toBeGreaterThan(-1);
    expect(waitFor, "visible-wait must exist inside signIn").toBeGreaterThan(-1);
    expect(fill, "fill must exist inside signIn").toBeGreaterThan(-1);
    expect(goto < waitFor && waitFor < fill, "ordering goto < wait < fill").toBeTrue();
  });

  test("the first-execution defect + fix are recorded in the file header", () => {
    expect(DETECTION).toContain("35417127704");
    expect(DETECTION).toContain("about:blank");
    expect(DETECTION).toContain("FIXED R73");
  });
});

describe("R73-B: the trivy fs triage stays narrow and gitleaks keeps its shape", () => {
  test("the fs trivy step carries the dedicated skip-files input, tls dir only", () => {
    const step = CI.slice(
      CI.indexOf("- name: Container scan (trivy)"),
      CI.indexOf("- name: Container scan skipped")
    );
    expect(step).toContain("skip-files: mini-services/worker/harness/tls/*");
    expect(step).toContain("35417127704");
    expect(step).toContain("P1-019");
    expect(step).toContain("Widening requires a new triage note");
    // the IMAGE scans stay un-triaged — the dockerignore exclusion is the fix
    expect(
      CI.indexOf("skip-files:") === CI.indexOf("skip-files: mini-services/worker/harness/tls/*"),
      "exactly one skip-files usage in the workflow"
    ).toBeTrue();
  });

  test("the gitleaks allowlist keeps the default ruleset and exactly seven paths", () => {
    expect(GITLEAKS).toContain("[extend]");
    expect(GITLEAKS).toContain("useDefault = true");
    const block = GITLEAKS.slice(GITLEAKS.indexOf("[allowlist]"));
    const listed = block.split("\n").filter((l) => l.trim().startsWith("'''")).length;
    expect(listed).toBe(7);
  });
});

describe("R73-C: test-only TLS fixtures never enter an image layer", () => {
  test("dockerignore excludes the harness tls dir with the lazy-read rationale", () => {
    expect(DOCKERIGNORE).toContain("mini-services/worker/harness/tls");
    expect(DOCKERIGNORE).toContain("startSfosWebApiHarness()");
    expect(DOCKERIGNORE).toContain("P1-019");
    expect(DOCKERIGNORE).toContain("35417127704");
  });
});

describe("R73-D: the run record is frozen in the audit doc", () => {
  test("first green e2e + D-file defect + trivy machine proof recorded", () => {
    expect(DOC).toContain("35417127704");
    expect(DOC).toContain("FIRST GREEN e2e JOB");
    expect(DOC).toContain("about:blank");
    expect(DOC).toContain("## 9. R73 ADDENDUM");
    expect(DOC).toContain("checksum-verified trivy 0.70.0");
    expect(DOC).toContain("exit 0, zero findings");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["detection-journeys", DETECTION],
      ["ci.yml", CI],
      ["gitleaks.toml", GITLEAKS],
      ["dockerignore", DOCKERIGNORE],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
