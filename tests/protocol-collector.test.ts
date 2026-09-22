import { expect, test } from "bun:test";
import {
  decodeProtocolPacket,
  decodeVerifiedSnmpV3Trap,
} from "../mini-services/worker/protocol-collector";
import { randomBytes } from "node:crypto";
import { buildSnmpV3Trap } from "../scripts/protocol-lab/snmpv3";

test("protocol collector parses RFC5424 syslog without retaining raw packet bytes", () => {
  const event = decodeProtocolPacket(
    "syslog",
    Buffer.from("<134>1 2026-09-21T00:00:00Z router1 app - - link up"),
    { address: "192.0.2.10", port: 5514 },
  );
  expect(event?.eventType).toBe("SYSLOG_MESSAGE");
  expect(event?.protocolVersion).toBe("RFC5424");
  expect(event?.deviceHint?.hostname).toBe("router1");
  expect(event?.sourceIp).toBe("192.0.2.10");
  expect(JSON.stringify(event)).not.toContain("base64");
});

test("protocol collector validates binary flow and sFlow versions", () => {
  const netflow = decodeProtocolPacket("netflow", Buffer.from([0, 0, 0, 9]), { address: "192.0.2.11", port: 2055 });
  const ipfix = decodeProtocolPacket("ipfix", Buffer.from([0, 0, 0, 10]), { address: "192.0.2.12", port: 4739 });
  const sflow = decodeProtocolPacket("sflow", Buffer.from([0, 0, 0, 5]), { address: "192.0.2.13", port: 6343 });
  expect(netflow?.protocolVersion).toBe("NETFLOW_V9");
  expect(ipfix?.protocolVersion).toBe("IPFIX_V10");
  expect(sflow?.protocolVersion).toBe("SFLOW_V5");
});

test("protocol collector rejects malformed binary packets", () => {
  expect(decodeProtocolPacket("snmp-trap", Buffer.from([0x01, 0x02]), { address: "192.0.2.14", port: 1162 })).toBeNull();
  expect(decodeProtocolPacket("netflow", Buffer.from([0, 0, 0, 7]), { address: "192.0.2.15", port: 2055 })).toBeNull();
});

test("generic SNMP trap framing is explicitly untrusted until authPriv verification", () => {
  const event = decodeProtocolPacket(
    "snmp-trap",
    Buffer.from([0x30, 0x00]),
    { address: "192.0.2.16", port: 1162 },
  );
  expect(event?.securityLevel).toBe("unknown");
  expect(event?.deviceHint).toBeUndefined();
});

test("worker verifies SNMPv3 authPriv with a vault-resolved profile and emits bounded metadata", async () => {
  const previousProvider = process.env.FAYANMS_VAULT_PROVIDER;
  const previousSecret = process.env.FAYANMS_VAULT_SNMP_TRAP_PROFILE;
  const secret = randomBytes(24).toString("hex");
  process.env.FAYANMS_VAULT_PROVIDER = "env";
  process.env.FAYANMS_VAULT_SNMP_TRAP_PROFILE = secret;
  try {
    const engineId = Uint8Array.from([0x80, 0x00, 0x1f, 0x88, 0x80, 9, 8, 7, 6, 5, 4]);
    const packet = Buffer.from(buildSnmpV3Trap({
      engineId,
      username: "trap-user",
      secret,
      notificationOid: "1.3.6.1.6.3.1.1.5.3",
      varBinds: [{ oid: "1.3.6.1.2.1.1.1.0", value: "verified" }],
    }));
    const event = await decodeVerifiedSnmpV3Trap(
      packet,
      { address: "192.0.2.16", port: 1162 },
      {
        credentialProfileId: "profile-a",
        hostname: "router-a",
        username: "trap-user",
        secretRef: "vault://snmp/trap-profile",
        engineIdHex: "80001f8880090807060504",
      },
    );
    expect(event.securityLevel).toBe("authPriv");
    expect(event.deviceHint).toEqual({
      hostname: "router-a",
      credentialProfileId: "profile-a",
    });
    expect(event.attributes).toEqual({
      requestId: 1,
      engineId: "80001f8880090807060504",
      varBindCount: 2,
      notificationOid: "1.3.6.1.6.3.1.1.5.3",
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    await expect(
      decodeVerifiedSnmpV3Trap(
        packet,
        { address: "192.0.2.16", port: 1162 },
        {
          credentialProfileId: "profile-a",
          hostname: "router-a",
          username: "trap-user",
          secretRef: "vault://snmp/trap-profile",
          engineIdHex: "00000000000000000000",
        },
      ),
    ).rejects.toThrow("engine ID mismatch");
  } finally {
    if (previousProvider === undefined) delete process.env.FAYANMS_VAULT_PROVIDER;
    else process.env.FAYANMS_VAULT_PROVIDER = previousProvider;
    if (previousSecret === undefined) delete process.env.FAYANMS_VAULT_SNMP_TRAP_PROFILE;
    else process.env.FAYANMS_VAULT_SNMP_TRAP_PROFILE = previousSecret;
  }
});
