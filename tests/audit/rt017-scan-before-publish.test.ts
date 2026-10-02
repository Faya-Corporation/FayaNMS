import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-017 / F-024 — container.yml: scan the LOCALLY BUILT image BEFORE any
 * publication.
 *
 * BEFORE: the publish job ran three `push: true` build-push steps (immutable
 * GHCR SHA tags) and ONLY THEN the three HIGH/CRITICAL trivy gates against
 * the published refs — a CRITICAL/HIGH image was already registrable when
 * the gate tripped.
 *
 * AFTER (the deliberate contract change): build (push: false, load: true,
 * linux/amd64 local `:gate` tags) → scan local refs (exit-code 1) → and
 * only after all three gates pass, the multi-arch push steps (same tags/
 * labels/build-args/SBOM/provenance contract as before). The SARIF
 * evidence steps stay AFTER the push (evidence, not the gate).
 *
 * NOTE: the workflow is DISABLED at repo level (owner request) — this is a
 * file-only contract, pinned here so the ordering cannot silently revert.
 */

const REPO_ROOT = join(import.meta.dir, "../..");
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/container.yml"), "utf8");

/** The publish job is the last job in the file — slice from its marker. */
const publishJob = workflow.slice(workflow.indexOf("  publish:\n"));

/** Split the job into step segments keyed by their `- name:` line. */
interface Step {
  name: string;
  index: number; // step ordinal within the job
  text: string;
}

function jobSteps(jobText: string): Step[] {
  const steps: Step[] = [];
  const lines = jobText.split("\n");
  let current: Step | null = null;
  let index = -1;
  for (const line of lines) {
    const match = line.match(/^      - name: (.+)$/);
    if (match) {
      index += 1;
      current = { name: match[1], index, text: line };
      steps.push(current);
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  return steps;
}

const steps = jobSteps(publishJob);

const gateScans = steps.filter((s) => /Scan built .*\(HIGH\/CRITICAL fatal\)/.test(s.name));
const pushSteps = steps.filter((s) => /push: true/.test(s.text));
const gateBuilds = steps.filter((s) => /Build gate .*\(local, never pushed\)/.test(s.name));
const sarifEvidence = steps.filter((s) => /format: sarif/.test(s.text));

describe("RT-017: scan-before-publish ordering (container.yml publish job)", () => {
  test("the gate shape exists: 3 local builds + 3 fatal scans + 3 pushes + evidence", () => {
    expect(gateBuilds).toHaveLength(3);
    expect(gateScans).toHaveLength(3);
    expect(pushSteps).toHaveLength(3);
    expect(sarifEvidence.length).toBeGreaterThanOrEqual(1);
  });

  test("scan steps precede push steps (every gate index < every push index)", () => {
    const maxGateIndex = Math.max(...gateScans.map((s) => s.index));
    const minPushIndex = Math.min(...pushSteps.map((s) => s.index));
    expect(maxGateIndex).toBeLessThan(minPushIndex);
  });

  test("gate builds are local-only (push: false, load: true, :gate tags)", () => {
    for (const build of gateBuilds) {
      expect(build.text).toContain("push: false");
      expect(build.text).toContain("load: true");
      expect(build.text).toContain("tags: fayanms");
      expect(build.text).toMatch(/tags: fayanms[a-z-]*:gate$/m);
      expect(build.text).not.toContain("ghcr.io");
    }
  });

  test("gate scans target the LOCAL :gate refs — no blocking gate scans ghcr", () => {
    for (const scan of gateScans) {
      expect(scan.text).toContain('exit-code: "1"');
      expect(scan.text).toContain("image-ref: fayanms");
      expect(scan.text).toMatch(/image-ref: fayanms[a-z-]*:gate$/m);
      expect(scan.text).not.toContain("ghcr.io");
    }
  });

  test("push steps keep multi-arch + provenance + sbom (no silent weakening)", () => {
    for (const push of pushSteps) {
      expect(push.text).toContain("platforms: linux/amd64,linux/arm64");
      expect(push.text).toContain("sbom: true");
      expect(push.text).toContain("provenance: mode=max");
    }
  });

  test("build-args unchanged on the final push steps", () => {
    const appPush = pushSteps.find((s) => s.text.includes("steps.meta.outputs.tags"));
    const workerPush = pushSteps.find((s) => s.text.includes("steps.worker-meta.outputs.tags"));
    const migratorPush = pushSteps.find((s) => s.text.includes("steps.migrator-meta.outputs.tags"));
    // F-026 (batch 9): the NEXT_PUBLIC_SITE_URL build-arg is retired
    // deliberately — the origin is a RUNTIME env (SITE_URL, per-request
    // resolution); its ABSENCE from the build args is the correct state.
    expect(appPush?.text).not.toContain("NEXT_PUBLIC_SITE_URL");
    for (const push of [appPush, workerPush, migratorPush]) {
      expect(push?.text).toContain("FAYANMS_SOURCE_SHA=${{ github.event.workflow_run.head_sha }}");
    }
  });

  test("SARIF evidence remains after the push (documented evidence-not-gate role)", () => {
    const maxPushIndex = Math.max(...pushSteps.map((s) => s.index));
    for (const evidence of sarifEvidence) {
      expect(evidence.index).toBeGreaterThan(maxPushIndex);
      // Evidence is non-blocking by contract.
      expect(evidence.text).toContain('exit-code: "0"');
    }
  });
});
