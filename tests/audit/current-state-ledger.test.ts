import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("N0-001 canonical current-state ledger", () => {
  const state = readRepoFile("docs/implementation/CURRENT-STATE.md");
  const nextTasks = readRepoFile("docs/audits/FayaNMS-NEXT-TASKS.md");
  const cloudProgress = readRepoFile("docs/audits/FayaNMS-CLOUD-IMPLEMENTATION-PROGRESS.md");

  test("records the reviewed code baseline and avoids stale remote or push claims", () => {
    expect(state).toContain("2170a53ecf3de88f335ac00ffa69d2f73d575302");
    expect(state).toContain("local `origin/main` and `HEAD` matched");
    expect(state).toContain("Worktree is not clean");
    expect(state).not.toContain("Local main contains unpushed commits");
  });

  test("records queue and continuous discovery as implemented without overstating lab proof", () => {
    expect(state).toContain("durable protocol event queue");
    expect(state).toContain("bounded continuous discovery");
    expect(state).toContain("physical-vendor certification remains open");
  });

  test("reports governance only at the last verified API readback", () => {
    expect(state).toContain("main.protected=false");
    expect(state).toContain("This status has not been rechecked for this snapshot");
    expect(state).not.toMatch(/branch protection (?:is )?active(?:\b|\.)/i);
  });

  test("records the healthy Docker deployment and completed migration state", () => {
    expect(state).toContain("HEALTHY — CONFIG RECONCILED");
    expect(state).toContain("Prisma reported all 13 migrations applied");
    expect(state).toContain("named PostgreSQL volume remains attached");
    expect(state).toContain("Compose config and one-off migration status now pass");
  });

  test("marks NetFlow v5 implemented while preserving the simulated flows API boundary", () => {
    expect(state).toContain("NetFlow v5 records | IMPLEMENTED — DEPLOYED LOCALLY");
    expect(state).toContain("audited 14-day retention");
    expect(state).toContain("`/api/v1/flows` remains simulated");
    expect(state).not.toContain("No implementation is claimed");
  });

  test("historical status pages point readers to the canonical current state", () => {
    for (const file of [
      "docs/audits/FayaNMS-CLOUD-IMPLEMENTATION-PROGRESS.md",
      "docs/audits/FayaNMS-NEXT-TASKS.md",
      "docs/audits/FayaNMS-FINAL-Production-Gate-2026-09-15.md",
      "docs/certification/MATRIX.md",
    ]) {
      expect(readRepoFile(file), file).toContain("docs/implementation/CURRENT-STATE.md");
    }
    expect(cloudProgress).toContain("timestamped snapshots are not live readbacks");
  });

  test("does not freeze a commit distance that changes as follow-up tasks are committed", () => {
    expect(state).toContain("git rev-list --left-right --count origin/main...HEAD");
    expect(state).not.toMatch(/\d+ commits ahead of that ref/);
  });

  test("current cross-program status contains no obsolete unpushed or spec-only claims", () => {
    const currentSection = nextTasks.split("## Completed i18n Tranche History")[0];
    expect(currentSection).toContain("2170a53ecf3de88f335ac00ffa69d2f73d575302");
    expect(currentSection).toContain("NetFlow v5 ingestion is implemented");
    expect(currentSection).not.toContain("These commits have not been pushed");
    expect(currentSection).not.toContain("no implementation is claimed");
  });
});
