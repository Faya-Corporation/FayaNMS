import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("NetFlow retention is separately configured and bounded by server receive time", () => {
  const policy = readFileSync("src/lib/flows/retention.ts", "utf8");
  expect(policy).toContain('FLOW_RETENTION_KEY = "flows.retention"');
  expect(policy).toContain("days: 14, enabled: true");
  expect(policy).toContain("FLOW_RETENTION_CHUNK_SIZE = 1_000");
  expect(policy).toContain("FLOW_RETENTION_MAX_DELETES_PER_RUN = 10_000");

  const prune = readFileSync("src/app/api/v1/flows/retention/prune/route.ts", "utf8");
  expect(prune).toContain("receivedAt: { lt: cutoff }");
  expect(prune).not.toContain("exportedAt: { lt: cutoff }");
  expect(prune).toContain('action: "FLOW_RECORDS_PRUNED"');
});

test("retention integration leaves simulated /flows behavior unchanged", () => {
  const flows = readFileSync("src/app/api/v1/flows/route.ts", "utf8");
  expect(flows).toContain("simulateDeviceFlows");
  expect(flows).not.toContain("flowRecord.findMany");

  const schema = readFileSync("prisma/schema.prisma", "utf8");
  expect(schema).toContain("@@index([receivedAt])");
  expect(schema).toContain("@@unique([queueId, recordIndex])");
});
