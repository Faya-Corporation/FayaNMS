import { expect, test } from "bun:test";
import { decodeNetFlowV5Datagram } from "../src/lib/protocol/netflow-v5";

function packetWithRecords(count: number): Buffer {
  const packet = Buffer.alloc(24 + count * 48);
  packet.writeUInt16BE(5, 0);
  packet.writeUInt16BE(count, 2);
  packet.writeUInt32BE(0xf0000001, 4);
  packet.writeUInt32BE(0xf0000005, 8);
  packet.writeUInt32BE(123, 12);
  packet.writeUInt32BE(0xf0000002, 16);
  packet[20] = 1;
  packet[21] = 2;
  packet.writeUInt16BE(0x8064, 22);
  for (let index = 0; index < count; index += 1) {
    const offset = 24 + index * 48;
    packet.set([192, 0, 2, 1, 198, 51, 100, 2, 203, 0, 113, 1], offset);
    packet.writeUInt16BE(7, offset + 12);
    packet.writeUInt16BE(8, offset + 14);
    packet.writeUInt32BE(0xf0000003, offset + 16);
    packet.writeUInt32BE(0xf0000004, offset + 20);
    packet.writeUInt32BE(0xf0000006, offset + 24);
    packet.writeUInt32BE(0xf0000007, offset + 28);
    packet.writeUInt16BE(443, offset + 32);
    packet.writeUInt16BE(52_000, offset + 34);
    packet[offset + 37] = 0x12;
    packet[offset + 38] = 6;
  }
  return packet;
}

test("decodes v5 fields in network byte order and preserves unsigned values", () => {
  const batch = decodeNetFlowV5Datagram(packetWithRecords(1));
  expect(batch?.header).toEqual({
    count: 1,
    systemUptimeMs: 0xf0000001,
    unixSeconds: 0xf0000005,
    unixNanoseconds: 123,
    flowSequence: 0xf0000002,
    engineType: 1,
    engineId: 2,
    samplingMode: 2,
    samplingInterval: 100,
  });
  expect(batch?.records[0]).toEqual({
    sourceIp: "192.0.2.1",
    destinationIp: "198.51.100.2",
    nextHopIp: "203.0.113.1",
    inputIfIndex: 7,
    outputIfIndex: 8,
    packets: "4026531843",
    octets: "4026531844",
    firstUptimeMs: "4026531846",
    lastUptimeMs: "4026531847",
    sourcePort: 443,
    destinationPort: 52_000,
    tcpFlags: 0x12,
    protocol: 6,
    tos: 0,
    sourceAs: 0,
    destinationAs: 0,
    sourceMask: 0,
    destinationMask: 0,
  });
});

test("accepts the maximum-sized 30-record datagram", () => {
  expect(decodeNetFlowV5Datagram(packetWithRecords(30))?.records).toHaveLength(30);
});

test("rejects unsupported, empty, over-limit, truncated, and trailing-byte datagrams", () => {
  const valid = packetWithRecords(1);
  const unsupported = Buffer.from(valid);
  unsupported.writeUInt16BE(9, 0);
  const empty = Buffer.from(valid);
  empty.writeUInt16BE(0, 2);
  const tooMany = Buffer.from(valid);
  tooMany.writeUInt16BE(31, 2);
  expect(decodeNetFlowV5Datagram(unsupported)).toBeNull();
  expect(decodeNetFlowV5Datagram(empty)).toBeNull();
  expect(decodeNetFlowV5Datagram(tooMany)).toBeNull();
  expect(decodeNetFlowV5Datagram(valid.subarray(0, valid.length - 1))).toBeNull();
  expect(decodeNetFlowV5Datagram(Buffer.concat([valid, Buffer.from([0])]))).toBeNull();
});
