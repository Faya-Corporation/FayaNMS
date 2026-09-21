import { TextEncoder } from "node:util";

const encoder = new TextEncoder();

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("u64 values must be non-negative safe integers");
  }
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  return concat(u32(high), u32(low));
}

function ipv4(value: string): Uint8Array {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error("IPv4 address required: " + value);
  }
  return Uint8Array.from(octets);
}

function berLength(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("BER length must be a non-negative integer");
  }
  if (length < 0x80) {
    return u8(length);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function berTlv(tag: number, value: Uint8Array): Uint8Array {
  return concat(u8(tag), berLength(value.length), value);
}

function berSequence(...parts: Uint8Array[]): Uint8Array {
  return berTlv(0x30, concat(...parts));
}

function berInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) {
    throw new Error("BER integer must be a safe integer");
  }
  if (value === 0) {
    return berTlv(0x02, u8(0));
  }
  if (value < 0) {
    throw new Error("Only non-negative BER integers are supported by the lab fixtures");
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes.unshift(0);
  }
  return berTlv(0x02, Uint8Array.from(bytes));
}

function berOid(value: string): Uint8Array {
  const arcs = value.split(".").map(Number);
  if (
    arcs.length < 2 ||
    arcs.some((arc) => !Number.isInteger(arc) || arc < 0) ||
    arcs[0] > 2 ||
    (arcs[0] < 2 && arcs[1] > 39)
  ) {
    throw new Error("Invalid OID: " + value);
  }
  const encoded: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const digits = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      digits.unshift(remaining & 0x7f);
      remaining = Math.floor(remaining / 128);
    }
    for (let index = 0; index < digits.length - 1; index += 1) {
      digits[index] |= 0x80;
    }
    encoded.push(...digits);
  }
  return berTlv(0x06, Uint8Array.from(encoded));
}

function berOctets(value: Uint8Array | string): Uint8Array {
  return berTlv(0x04, typeof value === "string" ? text(value) : value);
}

function berNull(): Uint8Array {
  return berTlv(0x05, new Uint8Array());
}

function berIpAddress(value: string): Uint8Array {
  return berTlv(0x40, ipv4(value));
}

function berTimeTicks(value: number): Uint8Array {
  return berTlv(0x43, u32(value));
}

export type SyslogOptions = {
  facility?: number;
  severity?: number;
  timestamp?: string;
  hostname?: string;
  appName?: string;
  procId?: string;
  msgId?: string;
  message: string;
};

function pri(options: Pick<SyslogOptions, "facility" | "severity">): number {
  const facility = options.facility ?? 16;
  const severity = options.severity ?? 6;
  if (
    !Number.isInteger(facility) ||
    facility < 0 ||
    facility > 23 ||
    !Number.isInteger(severity) ||
    severity < 0 ||
    severity > 7
  ) {
    throw new Error("syslog facility/severity out of range");
  }
  return facility * 8 + severity;
}

export function encodeRfc3164(options: SyslogOptions): Uint8Array {
  const timestamp = options.timestamp ?? "Jan  1 00:00:00";
  const hostname = options.hostname ?? "lab-device";
  const appName = options.appName ?? "fayanms-lab";
  return text(
    "<" +
      pri(options) +
      ">" +
      timestamp +
      " " +
      hostname +
      " " +
      appName +
      ": " +
      options.message,
  );
}

export function encodeRfc5424(options: SyslogOptions): Uint8Array {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const hostname = options.hostname ?? "lab-device";
  const appName = options.appName ?? "fayanms-lab";
  const procId = options.procId ?? "-";
  const msgId = options.msgId ?? "LAB-1";
  return text(
    "<" +
      pri(options) +
      ">1 " +
      timestamp +
      " " +
      hostname +
      " " +
      appName +
      " " +
      procId +
      " " +
      msgId +
      " - " +
      options.message,
  );
}

export type SnmpVarBind = {
  oid: string;
  value:
    | { kind: "integer"; value: number }
    | { kind: "octets"; value: string }
    | { kind: "oid"; value: string }
    | { kind: "counter32"; value: number }
    | { kind: "timeticks"; value: number }
    | { kind: "null" };
};

function encodeVarBind(varBind: SnmpVarBind): Uint8Array {
  let value: Uint8Array;
  switch (varBind.value.kind) {
    case "integer":
      value = berInteger(varBind.value.value);
      break;
    case "octets":
      value = berOctets(varBind.value.value);
      break;
    case "oid":
      value = berOid(varBind.value.value);
      break;
    case "counter32":
      value = berTlv(0x41, u32(varBind.value.value));
      break;
    case "timeticks":
      value = berTimeTicks(varBind.value.value);
      break;
    case "null":
      value = berNull();
      break;
  }
  return berSequence(berOid(varBind.oid), value);
}

function encodeVarBinds(varBinds: SnmpVarBind[]): Uint8Array {
  return berSequence(...varBinds.map(encodeVarBind));
}

export const SNMP_SYS_UPTIME_OID = "1.3.6.1.2.1.1.3.0";
export const SNMP_TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0";

export function standardTrapVarBinds(
  trapOid: string,
  uptimeTicks: number,
  extra: SnmpVarBind[] = [],
): SnmpVarBind[] {
  return [
    {
      oid: SNMP_SYS_UPTIME_OID,
      value: { kind: "timeticks", value: uptimeTicks },
    },
    { oid: SNMP_TRAP_OID, value: { kind: "oid", value: trapOid } },
    ...extra,
  ];
}

export function encodeSnmpV2cTrap(options: {
  community?: string;
  requestId?: number;
  trapOid: string;
  uptimeTicks?: number;
  varBinds?: SnmpVarBind[];
}): Uint8Array {
  const pdu = berTlv(
    0xa7,
    concat(
      berInteger(options.requestId ?? 1),
      berInteger(0),
      berInteger(0),
      encodeVarBinds(
        standardTrapVarBinds(
          options.trapOid,
          options.uptimeTicks ?? 100,
          options.varBinds,
        ),
      ),
    ),
  );
  return berSequence(berInteger(1), berOctets(options.community ?? "public"), pdu);
}

export function encodeSnmpV1Trap(options: {
  community?: string;
  enterpriseOid: string;
  agentAddress?: string;
  genericTrap?: number;
  specificTrap?: number;
  timestampTicks?: number;
  varBinds?: SnmpVarBind[];
}): Uint8Array {
  const pdu = berTlv(
    0xa4,
    concat(
      berOid(options.enterpriseOid),
      berIpAddress(options.agentAddress ?? "127.0.0.1"),
      berInteger(options.genericTrap ?? 6),
      berInteger(options.specificTrap ?? 1),
      berTimeTicks(options.timestampTicks ?? 100),
      encodeVarBinds(options.varBinds ?? []),
    ),
  );
  return berSequence(berInteger(0), berOctets(options.community ?? "public"), pdu);
}

export type FlowRecord = {
  srcAddr: string;
  dstAddr: string;
  nextHop?: string;
  input?: number;
  output?: number;
  packets?: number;
  octets?: number;
  first?: number;
  last?: number;
  srcPort?: number;
  dstPort?: number;
  tcpFlags?: number;
  protocol?: number;
  tos?: number;
  srcAs?: number;
  dstAs?: number;
  srcMask?: number;
  dstMask?: number;
};

function netflowV5Record(record: FlowRecord): Uint8Array {
  return concat(
    ipv4(record.srcAddr),
    ipv4(record.dstAddr),
    ipv4(record.nextHop ?? "0.0.0.0"),
    u16(record.input ?? 1),
    u16(record.output ?? 2),
    u32(record.packets ?? 1),
    u32(record.octets ?? 64),
    u32(record.first ?? 1000),
    u32(record.last ?? 1100),
    u16(record.srcPort ?? 443),
    u16(record.dstPort ?? 443),
    u8(0),
    u8(record.tcpFlags ?? 0x10),
    u8(record.protocol ?? 6),
    u8(record.tos ?? 0),
    u16(record.srcAs ?? 0),
    u16(record.dstAs ?? 0),
    u8(record.srcMask ?? 24),
    u8(record.dstMask ?? 24),
    u16(0),
  );
}

export function encodeNetflowV5(options: {
  records: FlowRecord[];
  sysUptime?: number;
  unixSeconds?: number;
  sequence?: number;
}): Uint8Array {
  if (options.records.length < 1 || options.records.length > 30) {
    throw new Error("NetFlow v5 supports one to thirty records per packet");
  }
  const records = options.records.map(netflowV5Record);
  return concat(
    u16(5),
    u16(records.length),
    u32(options.sysUptime ?? 1000),
    u32(options.unixSeconds ?? Math.floor(Date.now() / 1000)),
    u32(0),
    u32(options.sequence ?? 1),
    u8(0),
    u8(0),
    u16(0),
    ...records,
  );
}

export type FlowTemplateField = {
  type: number;
  length: number;
};

function flowTemplateSet(
  setId: number,
  templateId: number,
  fields: FlowTemplateField[],
): Uint8Array {
  const body = concat(
    u16(templateId),
    u16(fields.length),
    ...fields.flatMap((field) => [u16(field.type), u16(field.length)]),
  );
  return concat(u16(setId), u16(body.length + 4), body);
}

export function encodeNetflowV9Template(options: {
  templateId?: number;
  fields?: FlowTemplateField[];
  sourceId?: number;
}): Uint8Array {
  const fields = options.fields ?? [
    { type: 8, length: 4 },
    { type: 12, length: 4 },
    { type: 7, length: 2 },
    { type: 11, length: 2 },
  ];
  const set = flowTemplateSet(0, options.templateId ?? 256, fields);
  return concat(
    u16(9),
    u16(1),
    u32(1000),
    u32(Math.floor(Date.now() / 1000)),
    u32(1),
    u32(options.sourceId ?? 1),
    set,
  );
}

export function encodeIpfixTemplate(options: {
  templateId?: number;
  fields?: FlowTemplateField[];
  observationDomain?: number;
}): Uint8Array {
  const fields = options.fields ?? [
    { type: 8, length: 4 },
    { type: 12, length: 4 },
    { type: 7, length: 2 },
    { type: 11, length: 2 },
  ];
  const template = flowTemplateSet(2, options.templateId ?? 256, fields);
  const header = concat(
    u16(10),
    u16(template.length + 16),
    u32(Math.floor(Date.now() / 1000)),
    u32(1),
    u32(options.observationDomain ?? 1),
  );
  return concat(header, template);
}

export function encodeSflowCounterSample(options: {
  agentAddress?: string;
  sequence?: number;
  ifIndex?: number;
  inOctets?: number;
  outOctets?: number;
}): Uint8Array {
  const counters = concat(
    u32(options.ifIndex ?? 1),
    u32(6),
    u64(1_000_000_000),
    u32(0),
    u32(0),
    u64(options.inOctets ?? 1024),
    u32(1),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u64(options.outOctets ?? 2048),
    u32(1),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  );
  const genericCounterRecord = concat(u32(1), u32(counters.length), counters);
  const sampleBody = concat(
    u32(1),
    u32(0),
    u32(1),
    genericCounterRecord,
  );
  const sample = concat(u32(2), u32(sampleBody.length), sampleBody);
  return concat(
    u32(5),
    u32(1),
    ipv4(options.agentAddress ?? "127.0.0.1"),
    u32(0),
    u32(options.sequence ?? 1),
    u32(1000),
    u32(1),
    sample,
  );
}

export function toAscii(packet: Uint8Array): string {
  return new TextDecoder().decode(packet);
}
