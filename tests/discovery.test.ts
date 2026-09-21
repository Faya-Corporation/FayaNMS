import { createServer } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import {
  enumerateDiscoveryTargets,
  probeDiscoveryTarget,
  scanDiscoverySubnet,
} from "../mini-services/worker/discovery";

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
