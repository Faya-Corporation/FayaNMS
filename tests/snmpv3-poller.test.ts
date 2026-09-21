import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSnmpV3Agent } from "../scripts/protocol-lab/snmpv3";
import { counterDelta, pollSnmpV3 } from "../mini-services/worker/snmpv3-poller";

const ENGINE_ID = Uint8Array.from([0x80, 0x00, 0x1f, 0x88, 0x80, 9, 8, 7, 6, 5, 4]);
const SECRET = randomBytes(24).toString("hex");

test("authenticated SNMPv3 poller collects system and initial IF-MIB data", async () => {
  const previousProvider = process.env.FAYANMS_VAULT_PROVIDER;
  const previousSecret = process.env.FAYANMS_VAULT_SNMP_POLL_PROFILE;
  process.env.FAYANMS_VAULT_PROVIDER = "env";
  process.env.FAYANMS_VAULT_SNMP_POLL_PROFILE = SECRET;
  const agent = createSnmpV3Agent({
    engineId: ENGINE_ID,
    username: "poll-user",
    secret: SECRET,
    boots: 3,
    time: 100,
    host: "127.0.0.1",
  });
  try {
    const listening = await agent.listening;
    const result = await pollSnmpV3({
      deviceId: "device-a",
      hostname: "router-a",
      mgmtIp: "127.0.0.1",
      port: listening.port,
      credentialProfileId: "profile-a",
      username: "poll-user",
      secretRef: "vault://snmp/poll-profile",
      engineIdHex: "80001f8880090807060504",
      engineBoots: 3,
      engineTime: 100,
    }, {
      timeoutMs: 500,
      retries: 1,
      retryBackoffMs: 0,
      jitterMs: 0,
      maxInterfaces: 1,
      interfaceIndexes: [1],
      requestIdStart: 10,
      random: () => 0,
    });
    expect(result.system.sysName).toBe("fayanms-lab-agent");
    expect(result.system.sysDescr).toContain("FayaNMS");
    expect(result.system.uptimeSeconds).toBe(12);
    expect(result.interfaces).toEqual([{
      index: 1,
      name: "lo",
      operStatus: "UP",
      inOctets: "123456",
      outOctets: "654321",
    }]);
    expect(result.engine).toEqual({
      engineIdHex: "80001f8880090807060504",
      boots: 3,
      time: 101,
    });
    expect(result.attempts).toBe(result.requests);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  } finally {
    await agent.close();
    if (previousProvider === undefined) delete process.env.FAYANMS_VAULT_PROVIDER;
    else process.env.FAYANMS_VAULT_PROVIDER = previousProvider;
    if (previousSecret === undefined) delete process.env.FAYANMS_VAULT_SNMP_POLL_PROFILE;
    else process.env.FAYANMS_VAULT_SNMP_POLL_PROFILE = previousSecret;
  }
});

test("SNMPv3 counter delta distinguishes wrap from reset", () => {
  expect(counterDelta("4294967291", "3", 32)).toEqual({ delta: "8", reset: false });
  expect(counterDelta("500", "10", 32)).toEqual({ delta: "10", reset: true });
  expect(counterDelta(null, "10")).toEqual({ delta: null, reset: false });
});
