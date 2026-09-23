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
  const dockerEvidence = JSON.parse(readRepoFile("docs/implementation/release-evidence-7c5f069.json"));
  const latestDockerEvidence = JSON.parse(readRepoFile("docs/implementation/release-evidence-7e44361.json"));

  test("records the reviewed code baseline and avoids stale remote or push claims", () => {
    expect(state).toContain("7e4436183f337b52115fbb1ae0326dd8c3907627");
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
    expect(state).toContain("HEALTHY — SOURCE VERIFIED");
    expect(state).toContain("Prisma reported all 13 migrations applied");
    expect(state).toContain("PostgreSQL container and named volume remain unchanged");
    expect(state).toContain("Compose config validates and the read-only migration status is current");
    expect(dockerEvidence.localDockerDeployment.services.app.status).toBe("healthy");
    expect(dockerEvidence.localDockerDeployment.applicationProbe.statusCode).toBe(200);
    expect(dockerEvidence.localDockerDeployment.database.migrationCount).toBe(13);
    expect(dockerEvidence.localDockerDeployment.database.volumeName).toBe("fayanms_fayanms-pgdata");
    expect(dockerEvidence.imageDigests).toEqual({});
    expect(dockerEvidence.source.worktreeClean).toBe(false);
    expect(dockerEvidence.localDockerDeployment.sourceSha).toBe("2170a53ecf3de88f335ac00ffa69d2f73d575302");
  });

  test("pins the current app and worker images to their inspected source revision", () => {
    const deployment = latestDockerEvidence.localDockerDeployment;
    expect(state).toContain("7e4436183f337b52115fbb1ae0326dd8c3907627");
    expect(state).toContain("OCI revision labels match");
    expect(deployment.sourceSha).toBe("7e4436183f337b52115fbb1ae0326dd8c3907627");
    expect(deployment.services.app.sourceRevision).toBe(deployment.sourceSha);
    expect(deployment.services.worker.sourceRevision).toBe(deployment.sourceSha);
    expect(deployment.services.postgres.sourceRevision).toBeNull();
    expect(deployment.services.app.status).toBe("healthy");
    expect(deployment.services.worker.status).toBe("healthy");
    expect(deployment.services.postgres.status).toBe("healthy");
    expect(deployment.services.app.imageId).toBe("sha256:65b764e0114472ca2cbd16c857c30f91fbb7c287f256958e768f68fac3e1fea5");
    expect(deployment.services.worker.imageId).toBe("sha256:3bd02b6963ac4efc8cc66d3afbcd04082d872b78a4a454436257f75733f4596c");
    expect(deployment.applicationProbe.statusCode).toBe(200);
    expect(deployment.database.migrationCount).toBe(13);
    expect(deployment.database.migrationHead).toBe("20260923010000_netflow_v5_records");
    expect(deployment.database.volumeName).toBe("fayanms_fayanms-pgdata");
    expect(latestDockerEvidence.source.worktreeClean).toBe(false);
    expect(latestDockerEvidence.imageDigests).toEqual({});
    expect(latestDockerEvidence.externalBlockers).toHaveLength(4);
    const currentSection = nextTasks.split("## Completed i18n Tranche History")[0];
    expect(currentSection).toContain("7e4436183f337b52115fbb1ae0326dd8c3907627");
    expect(currentSection).toContain("release-evidence-7e44361.json");
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
    expect(currentSection).toContain("7e4436183f337b52115fbb1ae0326dd8c3907627");
    expect(currentSection).toContain("NetFlow v5 ingestion is implemented");
    expect(currentSection).not.toContain("These commits have not been pushed");
    expect(currentSection).not.toContain("no implementation is claimed");
  });
});
