import { expect, test } from "bun:test";
import { decodeProtocolPacket } from "../mini-services/worker/protocol-collector";

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
