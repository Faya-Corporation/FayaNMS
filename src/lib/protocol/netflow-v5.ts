export interface NetFlowV5Header {
  count: number;
  systemUptimeMs: number;
  unixSeconds: number;
  unixNanoseconds: number;
  flowSequence: number;
  engineType: number;
  engineId: number;
  samplingMode: number;
  samplingInterval: number;
}

export interface NetFlowV5Record {
  sourceIp: string;
  destinationIp: string;
  nextHopIp: string;
  inputIfIndex: number;
  outputIfIndex: number;
  packets: string;
  octets: string;
  firstUptimeMs: string;
  lastUptimeMs: string;
  sourcePort: number;
  destinationPort: number;
  tcpFlags: number;
  protocol: number;
  tos: number;
  sourceAs: number;
  destinationAs: number;
  sourceMask: number;
  destinationMask: number;
}

export interface NetFlowV5Batch {
  header: NetFlowV5Header;
  records: NetFlowV5Record[];
}

const HEADER_BYTES = 24;
const RECORD_BYTES = 48;
const MAX_RECORDS = 30;

function ipv4At(packet: Buffer, offset: number): string {
  return `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
}

function uint32TextAt(packet: Buffer, offset: number): string {
  return packet.readUInt32BE(offset).toString(10);
}

export function decodeNetFlowV5Datagram(packet: Buffer): NetFlowV5Batch | null {
  if (packet.length < HEADER_BYTES || packet.readUInt16BE(0) !== 5) return null;

  const count = packet.readUInt16BE(2);
  if (count < 1 || count > MAX_RECORDS || packet.length !== HEADER_BYTES + count * RECORD_BYTES) {
    return null;
  }

  const sampling = packet.readUInt16BE(22);
  const records: NetFlowV5Record[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * RECORD_BYTES;
    records.push({
      sourceIp: ipv4At(packet, offset),
      destinationIp: ipv4At(packet, offset + 4),
      nextHopIp: ipv4At(packet, offset + 8),
      inputIfIndex: packet.readUInt16BE(offset + 12),
      outputIfIndex: packet.readUInt16BE(offset + 14),
      packets: uint32TextAt(packet, offset + 16),
      octets: uint32TextAt(packet, offset + 20),
      firstUptimeMs: uint32TextAt(packet, offset + 24),
      lastUptimeMs: uint32TextAt(packet, offset + 28),
      sourcePort: packet.readUInt16BE(offset + 32),
      destinationPort: packet.readUInt16BE(offset + 34),
      tcpFlags: packet[offset + 37],
      protocol: packet[offset + 38],
      tos: packet[offset + 39],
      sourceAs: packet.readUInt16BE(offset + 40),
      destinationAs: packet.readUInt16BE(offset + 42),
      sourceMask: packet[offset + 44],
      destinationMask: packet[offset + 45],
    });
  }

  return {
    header: {
      count,
      systemUptimeMs: packet.readUInt32BE(4),
      unixSeconds: packet.readUInt32BE(8),
      unixNanoseconds: packet.readUInt32BE(12),
      flowSequence: packet.readUInt32BE(16),
      engineType: packet[20],
      engineId: packet[21],
      samplingMode: sampling >>> 14,
      samplingInterval: sampling & 0x3fff,
    },
    records,
  };
}
