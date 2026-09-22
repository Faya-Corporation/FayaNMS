import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("NetFlow v5 persistence does not replace the simulated /api/v1/flows response", () => {
  const route = readFileSync("src/app/api/v1/flows/route.ts", "utf8");
  expect(route).toContain("simulateDeviceFlows(");
  expect(route).toContain("FLOW_WINDOWS");
  expect(route).not.toContain("db.flowRecord");
  expect(route).not.toContain("flowRecord.findMany");
});
