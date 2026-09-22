import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("flow retention policy and prune APIs use their required authorization and audit scopes", () => {
  const policy = readFileSync("src/app/api/v1/flows/retention/route.ts", "utf8");
  expect(policy).toContain('requirePermission(request, "admin.system")');
  expect(policy).toContain('action: "SETTINGS_UPDATED"');
  expect(policy).toContain("FLOW_RETENTION_KEY");

  const prune = readFileSync("src/app/api/v1/flows/retention/prune/route.ts", "utf8");
  expect(prune).toContain('authenticateServiceRequest(request, "jobs")');
  expect(prune).toContain('action: "FLOW_RECORDS_PRUNED"');
  expect(prune).toContain("receivedAt: { lt: cutoff }");
  expect(prune).toContain("FLOW_RETENTION_CHUNK_SIZE");
  expect(prune).toContain("FLOW_RETENTION_MAX_DELETES_PER_RUN");
  expect(prune).toContain("take: FLOW_RETENTION_CHUNK_SIZE");
  expect(prune).toContain("id: { in: expired.map((row) => row.id) }");
});

test("flow retention jobs are deduplicated, claimed, executed, and validated", () => {
  const tick = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
  expect(tick).toContain('type: "FLOW_RETENTION"');
  expect(tick).toContain("FLOW_RETENTION_DEDUPE_HOURS");
  expect(tick).toContain('status: { in: ["QUEUED", "RUNNING"] }');
  expect(tick).toContain('finishedAt: {');

  const claim = readFileSync("src/app/api/v1/worker/claim/route.ts", "utf8");
  expect(claim).toContain(".max(12)");
  const runner = readFileSync("mini-services/worker/runner.ts", "utf8");
  expect(runner).toContain('job.type === "FLOW_RETENTION"');
  expect(runner).toContain('"/api/v1/flows/retention/prune"');
  expect(runner).toContain('"FLOW_RETENTION"');
  const complete = readFileSync("src/app/api/v1/worker/complete/route.ts", "utf8");
  expect(complete).toContain('job.type === "FLOW_RETENTION"');
  expect(complete).toContain('flowRecordsDeleted: z.number().int().nonnegative()');
  expect(complete).toContain('durationMs: z.number().int().nonnegative()');
});
