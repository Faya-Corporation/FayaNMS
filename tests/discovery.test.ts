import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  enumerateDiscoveryTargets,
  probeDiscoveryTarget,
  scanDiscoverySubnet,
} from "../mini-services/worker/discovery";
import { normalizeDiscoveryPolicyConfig } from "../src/lib/discovery/policy";

describe("bounded discovery probes", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  test("enumerates only bounded host addresses", () => {
    expect(enumerateDiscoveryTargets("192.0.2.0/30")).toEqual([
      "192.0.2.1",
      "192.0.2.2",
    ]);
    expect(enumerateDiscoveryTargets("192.0.2.10/32")).toEqual(["192.0.2.10"]);
    expect(() => enumerateDiscoveryTargets("192.0.2.0/23")).toThrow(/\/24-\/32/);
  });

  test("reports a real loopback TCP listener without vendor or SNMP claims", async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind");
    const result = await probeDiscoveryTarget("127.0.0.1", {
      ports: [address.port],
      timeoutMs: 500,
    });
    expect(result.reachable).toBe(true);
    expect(result.openPorts).toEqual([address.port]);

    const scan = await scanDiscoverySubnet("127.0.0.1/32", {
      ports: [address.port],
      timeoutMs: 500,
      concurrency: 1,
    });
    expect(scan.targetsScanned).toBe(1);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      ip: "127.0.0.1",
      vendorGuess: "generic",
      osFingerprint: "Unauthenticated TCP reachability",
    });
    expect(scan.candidates[0].protocols).toEqual(["tcp/" + address.port]);
  });
});

test("continuous discovery policy stays disabled-by-default and bounded", () => {
  const config = normalizeDiscoveryPolicyConfig({
    subnets: ["192.0.2.0/24"],
    ports: [22, 443],
    intervalMinutes: 60,
    enabled: true,
  });
  expect(config).toEqual({
    subnets: ["192.0.2.0/24"],
    ports: [22, 443],
    intervalMinutes: 60,
    enabled: true,
  });
  expect(
    normalizeDiscoveryPolicyConfig({
      subnets: ["192.0.2.0/23"],
      ports: [22],
      intervalMinutes: 60,
      enabled: true,
    }),
  ).toBeNull();
  expect(
    normalizeDiscoveryPolicyConfig({
      subnets: ["192.0.2.0/24"],
      ports: [161],
      intervalMinutes: 60,
      enabled: true,
    }),
  ).toBeNull();
  expect(
    normalizeDiscoveryPolicyConfig({
      subnets: ["192.0.2.0/24"],
      ports: [22],
      intervalMinutes: 60,
    })?.enabled,
  ).toBe(false);
});

test("discovery reconciliation persists evidence without fabricating identity or topology", () => {
  const route = readFileSync(
    "src/app/api/v1/worker/discovery/reconcile/route.ts",
    "utf8",
  );
  expect(route).toContain('authenticateServiceRequest(request, "jobs")');
  expect(route).toContain("discoveryObservation.createMany");
  expect(route).toContain("device.updateMany");
  expect(route).toContain("never create a Device");
  expect(route).not.toContain("vendorId:");
  const scheduler = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
  expect(scheduler).toContain("enqueueDiscoveryPolicies");
  expect(scheduler).toContain('source: "CONTINUOUS"');
  const topology = readFileSync("src/app/api/v1/topology/route.ts", "utf8");
  expect(topology).toContain("discoveryEvidence");
  expect(topology).toContain("simulated");
});
