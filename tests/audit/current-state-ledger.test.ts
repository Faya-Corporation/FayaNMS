import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("N0-001 canonical current-state ledger", () => {
  const state = readRepoFile("docs/implementation/CURRENT-STATE.md");

  test("separates the verified remote baseline from the unpushed local branch", () => {
    expect(state).toContain("5671bc5b5067d1503b6e10be73101f006b3af794");
    expect(state).toContain("Local main contains unpushed commits");
    expect(state).toContain("Worktree is not clean");
  });

  test("records queue and continuous discovery as implemented, without overstating lab proof", () => {
    expect(state).toContain("durable protocol event queue");
    expect(state).toContain("bounded continuous discovery");
    expect(state).toContain("physical-vendor certification remains open");
  });

  test("does not claim branch protection is active without a positive API readback", () => {
    expect(state).toContain("Branch protection: NOT ACTIVE");
    expect(state).toContain("protected=false");
    expect(state).not.toMatch(/branch protection (?:is )?active(?:\b|\.)/i);
  });

  test("historical release and certification pages direct readers to the canonical live status", () => {
    for (const file of [
      "docs/audits/FayaNMS-CLOUD-IMPLEMENTATION-PROGRESS.md",
      "docs/audits/FayaNMS-NEXT-TASKS.md",
      "docs/audits/FayaNMS-FINAL-Production-Gate-2026-09-15.md",
      "docs/certification/MATRIX.md",
    ]) {
      expect(readRepoFile(file), file).toContain("docs/implementation/CURRENT-STATE.md");
    }
  });

  test("does not freeze a commit distance that changes as follow-up tasks are committed", () => {
    expect(state).toContain("git rev-list --left-right --count origin/main...HEAD");
    expect(state).not.toMatch(/\d+ commits ahead of that ref/);
  });
});
