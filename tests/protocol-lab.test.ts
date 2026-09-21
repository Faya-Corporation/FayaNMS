import { createSocket } from "node:dgram";
import { describe, expect, test } from "bun:test";
import {
  encodeIpfixTemplate,
  encodeNetflowV5,
  encodeNetflowV9Template,
  encodeRfc3164,
  encodeRfc5424,
  encodeSflowCounterSample,
  encodeSnmpV1Trap,
  encodeSnmpV2cTrap,
  toAscii,
} from "../scripts/protocol-lab/codec";
import {
  isAllowedLabHost,
  makePacket,
  sendUdp,
} from "../scripts/protocol-lab/generate";

function u16(packet: Uint8Array, offset: number): number {
  return (packet[offset] << 8) | packet[offset + 1];
}

function u32(packet: Uint8Array, offset: number): number {
  return (
    packet[offset] * 0x1000000 +
    packet[offset + 1] * 0x10000 +
    packet[offset + 2] * 0x100 +
    packet[offset + 3]
  );
}

function waitForMessage(socket: ReturnType<typeof createSocket>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("loopback protocol packet timeout"));
    }, 1000);
    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(new Uint8Array(message));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

describe("CLOUD-11 packet-level protocol fixtures", () => {
  test("generates RFC3164 and RFC5424 syslog without a simulation marker", () => {
    const rfc3164 = toAscii(
      encodeRfc3164({ message: "link down", timestamp: "Jan  1 00:00:00" }),
    );
    const rfc5424 = toAscii(
      encodeRfc5424({
        message: "link down",
        timestamp: "2026-09-21T00:00:00.000Z",
      }),
    );
    expect(rfc3164).toStartWith("<134>Jan  1 00:00:00 lab-device");
    expect(rfc5424).toStartWith("<134>1 2026-09-21T00:00:00.000Z lab-device");
    expect(rfc5424).toContain("link down");
  });

  test("encodes standard and vendor-style SNMP traps as real BER packets", () => {
    const v1 = encodeSnmpV1Trap({
      enterpriseOid: "1.3.6.1.4.1.55555.1",
      varBinds: [],
    });
    const v2c = encodeSnmpV2cTrap({
      trapOid: "1.3.6.1.4.1.55555.1.0.1",
      varBinds: [],
    });
    expect(v1[0]).toBe(0x30);
    expect(v1.includes(0xa4)).toBeTrue();
    expect(v2c[0]).toBe(0x30);
    expect(v2c.includes(0xa7)).toBeTrue();
    expect(v2c).toContain(0x06);
  });

  test("encodes NetFlow v5, NetFlow v9 templates, IPFIX templates, and sFlow", () => {
    const v5 = encodeNetflowV5({
      records: [{ srcAddr: "192.0.2.1", dstAddr: "198.51.100.1" }],
    });
    const v9 = encodeNetflowV9Template({});
    const ipfix = encodeIpfixTemplate({});
    const sflow = encodeSflowCounterSample({});
    expect(u16(v5, 0)).toBe(5);
    expect(u16(v5, 2)).toBe(1);
    expect(u16(v9, 0)).toBe(9);
    expect(u16(v9, 20)).toBe(0);
    expect(u16(ipfix, 0)).toBe(10);
    expect(u16(ipfix, 16)).toBe(2);
    expect(u32(sflow, 0)).toBe(5);
    expect(u32(sflow, 4)).toBe(1);
  });

  test("restricts the sender to loopback unless an explicit lab override exists", () => {
    expect(isAllowedLabHost("127.0.0.1")).toBeTrue();
    expect(isAllowedLabHost("::1")).toBeTrue();
    expect(isAllowedLabHost("10.0.0.10")).toBeFalse();
    expect(isAllowedLabHost("10.0.0.10", true)).toBeTrue();
  });

  test("transmits a real RFC5424 datagram on loopback", async () => {
    const receiver = createSocket("udp4");
    receiver.bind(0, "127.0.0.1");
    await new Promise<void>((resolve) => receiver.once("listening", () => resolve()));
    const address = receiver.address();
    if (typeof address === "string") throw new Error("unexpected Unix socket");
    const received = waitForMessage(receiver);
    await sendUdp("127.0.0.1", address.port, makePacket("syslog5424"));
    expect(toAscii(await received)).toContain("fayanms protocol-lab syslog5424");
  });
});
