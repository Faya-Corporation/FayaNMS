import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { TextEncoder } from "node:util";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function berLength(length: number): Uint8Array {
  if (length < 0x80) return u8(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concat(u8(tag), berLength(value.length), value);
}

function sequence(...parts: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(...parts));
}

function integer(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("SNMPv3 fixture integers must be non-negative safe integers");
  }
  if (value === 0) return tlv(0x02, u8(0));
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
}

function octets(value: Uint8Array | string): Uint8Array {
  return tlv(0x04, typeof value === "string" ? encoder.encode(value) : value);
}

function oid(value: string): Uint8Array {
  const arcs = value.split(".").map(Number);
  if (
    arcs.length < 2 ||
    arcs.some((arc) => !Number.isInteger(arc) || arc < 0) ||
    arcs[0] > 2 ||
    (arcs[0] < 2 && arcs[1] > 39)
  ) {
    throw new Error("invalid OID: " + value);
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
  return tlv(0x06, Uint8Array.from(encoded));
}

function nullValue(): Uint8Array {
  return tlv(0x05, new Uint8Array());
}

export type SnmpV3TrapVarBind = {
  oid: string;
  value: string | number | null;
  valueType?: "octets" | "oid" | "integer" | "timeticks";
};

function trapValue(value: SnmpV3TrapVarBind): Uint8Array {
  if (value.valueType === "oid") {
    if (typeof value.value !== "string") throw new Error("SNMPv3 OID values must be strings");
    return oid(value.value);
  }
  if (value.valueType === "timeticks") {
    if (
      typeof value.value !== "number" ||
      !Number.isSafeInteger(value.value) ||
      value.value < 0 ||
      value.value > 0xffffffff
    ) {
      throw new Error("SNMPv3 timeticks must be unsigned 32-bit integers");
    }
    return tlv(0x43, u32(value.value));
  }
  if (value.value === null) return nullValue();
  if (typeof value.value === "number") return integer(value.value);
  return octets(value.value);
}

function decodeSnmpValue(packet: Uint8Array, value: ParsedTlv): string | number | null {
  switch (value.tag) {
    case 0x04:
      return decodeText(packet, value);
    case 0x05:
      return null;
    case 0x06:
      return decodeOid(packet, value);
    case 0x02:
    case 0x41:
    case 0x42:
    case 0x43:
      return decodeInteger(packet, value);
    default:
      return Buffer.from(bytes(packet, value)).toString("hex");
  }
}

type ParsedTlv = {
  tag: number;
  valueStart: number;
  next: number;
};

function readLength(packet: Uint8Array, offset: number): {
  length: number;
  next: number;
} {
  const first = packet[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const width = first & 0x7f;
  if (width < 1 || width > 4) throw new Error("unsupported BER length");
  let length = 0;
  for (let index = 0; index < width; index += 1) {
    length = length * 256 + packet[offset + 1 + index];
  }
  return { length, next: offset + 1 + width };
}

function readTlv(packet: Uint8Array, offset: number): ParsedTlv {
  const { length, next } = readLength(packet, offset + 1);
  const valueStart = next;
  const end = valueStart + length;
  if (end > packet.length) throw new Error("truncated BER value");
  return { tag: packet[offset], valueStart, next: end };
}

function children(packet: Uint8Array, parent: ParsedTlv): ParsedTlv[] {
  const result: ParsedTlv[] = [];
  let offset = parent.valueStart;
  while (offset < parent.next) {
    const child = readTlv(packet, offset);
    result.push(child);
    offset = child.next;
  }
  if (offset !== parent.next) throw new Error("invalid BER child boundary");
  return result;
}

function bytes(packet: Uint8Array, tlvValue: ParsedTlv): Uint8Array {
  return packet.slice(tlvValue.valueStart, tlvValue.next);
}

function decodeInteger(packet: Uint8Array, value: ParsedTlv): number {
  let result = 0;
  for (const octet of bytes(packet, value)) {
    result = result * 256 + octet;
  }
  return result;
}

function decodeText(packet: Uint8Array, value: ParsedTlv): string {
  return new TextDecoder().decode(bytes(packet, value));
}

function decodeOid(packet: Uint8Array, value: ParsedTlv): string {
  const encoded = bytes(packet, value);
  if (encoded.length === 0) throw new Error("empty OID");
  const first = encoded[0];
  const arcs = [Math.min(2, Math.floor(first / 40)), first >= 80 ? first - 80 : first % 40];
  let current = 0;
  for (const octet of encoded.slice(1)) {
    current = (current << 7) | (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      arcs.push(current);
      current = 0;
    }
  }
  if (current !== 0) throw new Error("unterminated OID arc");
  return arcs.join(".");
}

function localizedKey(passphrase: string, engineId: Uint8Array): Uint8Array {
  if (passphrase.length < 8) {
    throw new Error("SNMPv3 fixture passphrases must be at least eight characters");
  }
  const password = encoder.encode(passphrase);
  const expanded = new Uint8Array(1_048_576);
  for (let index = 0; index < expanded.length; index += 1) {
    expanded[index] = password[index % password.length];
  }
  const ku = createHash("sha1").update(Buffer.from(expanded)).digest();
  return new Uint8Array(
    createHash("sha1")
      .update(Buffer.from(concat(ku, engineId, ku)))
      .digest(),
  );
}

function encryptScoped(
  scoped: Uint8Array,
  key: Uint8Array,
  boots: number,
  time: number,
  salt: Uint8Array,
): Uint8Array {
  const iv = concat(u32(boots), u32(time), salt);
  const cipher = createCipheriv(
    "aes-128-cfb",
    Buffer.from(key.slice(0, 16)),
    Buffer.from(iv),
  );
  cipher.setAutoPadding(false);
  return new Uint8Array(
    concat(cipher.update(Buffer.from(scoped)), cipher.final()),
  );
}

function decryptScoped(
  encrypted: Uint8Array,
  key: Uint8Array,
  boots: number,
  time: number,
  salt: Uint8Array,
): Uint8Array {
  const iv = concat(u32(boots), u32(time), salt);
  const decipher = createDecipheriv(
    "aes-128-cfb",
    Buffer.from(key.slice(0, 16)),
    Buffer.from(iv),
  );
  decipher.setAutoPadding(false);
  return new Uint8Array(
    concat(decipher.update(Buffer.from(encrypted)), decipher.final()),
  );
}

function usmParameters(options: {
  engineId: Uint8Array;
  boots: number;
  time: number;
  username: string;
  authParameters: Uint8Array;
  privParameters: Uint8Array;
}): Uint8Array {
  return sequence(
    octets(options.engineId),
    integer(options.boots),
    integer(options.time),
    octets(options.username),
    octets(options.authParameters),
    octets(options.privParameters),
  );
}

function header(messageId: number): Uint8Array {
  return sequence(
    integer(messageId),
    integer(65_507),
    octets(Uint8Array.of(0x07)),
    integer(3),
  );
}

function authOffset(packet: Uint8Array): { offset: number; value: Uint8Array } {
  const top = readTlv(packet, 0);
  const topChildren = children(packet, top);
  const securityOctets = topChildren[2];
  const usm = readTlv(packet, securityOctets.valueStart);
  const usmChildren = children(packet, usm);
  const auth = usmChildren[4];
  return { offset: auth.valueStart, value: bytes(packet, auth) };
}

function authenticate(packet: Uint8Array, key: Uint8Array): Uint8Array {
  const copy = new Uint8Array(packet);
  const location = authOffset(copy);
  copy.fill(0, location.offset, location.offset + location.value.length);
  const digest = new Uint8Array(
    createHmac("sha1", Buffer.from(key))
      .update(Buffer.from(copy))
      .digest()
      .subarray(0, 12),
  );
  packet.set(digest, location.offset);
  return packet;
}

function verifyAuthentication(packet: Uint8Array, key: Uint8Array): void {
  const copy = new Uint8Array(packet);
  const location = authOffset(copy);
  const expected = new Uint8Array(location.value);
  copy.fill(0, location.offset, location.offset + location.value.length);
  const actual = new Uint8Array(
    createHmac("sha1", Buffer.from(key))
      .update(Buffer.from(copy))
      .digest()
      .subarray(0, 12),
  );
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  ) {
    throw new Error("SNMPv3 USM authentication failed");
  }
}

function buildScopedGet(options: {
  engineId: Uint8Array;
  contextName: string;
  requestId: number;
  requestedOid: string;
}): Uint8Array {
  const varBind = sequence(oid(options.requestedOid), nullValue());
  const pdu = tlv(
    0xa0,
    concat(
      integer(options.requestId),
      integer(0),
      integer(0),
      sequence(varBind),
    ),
  );
  return sequence(octets(options.engineId), octets(options.contextName), pdu);
}

function buildScopedTrap(options: {
  engineId: Uint8Array;
  contextName: string;
  requestId: number;
  notificationOid?: string;
  varBinds: readonly SnmpV3TrapVarBind[];
}): Uint8Array {
  const varBinds = options.notificationOid
    ? [
        {
          oid: "1.3.6.1.6.3.1.1.4.1.0",
          value: options.notificationOid,
          valueType: "oid" as const,
        },
        ...options.varBinds,
      ]
    : options.varBinds;
  const pdu = tlv(
    0xa7,
    concat(
      integer(options.requestId),
      integer(0),
      integer(0),
      sequence(
        ...varBinds.map((varBind) =>
          sequence(oid(varBind.oid), trapValue(varBind)),
        ),
      ),
    ),
  );
  return sequence(
    octets(options.engineId),
    octets(options.contextName),
    pdu,
  );
}

function buildMessage(options: {
  engineId: Uint8Array;
  boots: number;
  time: number;
  username: string;
  messageId: number;
  scopedPdu: Uint8Array;
  key: Uint8Array;
  salt: Uint8Array;
}): Uint8Array {
  const encrypted = encryptScoped(
    options.scopedPdu,
    options.key,
    options.boots,
    options.time,
    options.salt,
  );
  const message = sequence(
    integer(3),
    header(options.messageId),
    octets(
      usmParameters({
        engineId: options.engineId,
        boots: options.boots,
        time: options.time,
        username: options.username,
        authParameters: new Uint8Array(12),
        privParameters: options.salt,
      }),
    ),
    octets(encrypted),
  );
  return authenticate(message, options.key);
}

export type SnmpV3Config = {
  engineId: Uint8Array;
  username: string;
  secret: string;
  boots?: number;
  time?: number;
};

export function buildSnmpV3Trap(
  options: SnmpV3Config & {
    requestId?: number;
    messageId?: number;
    contextName?: string;
    notificationOid?: string;
    varBinds: readonly SnmpV3TrapVarBind[];
  },
): Uint8Array {
  const boots = options.boots ?? 1;
  const time = options.time ?? 1;
  const requestId = options.requestId ?? 1;
  const key = localizedKey(options.secret, options.engineId);
  return buildMessage({
    engineId: options.engineId,
    boots,
    time,
    username: options.username,
    messageId: options.messageId ?? requestId,
    scopedPdu: buildScopedTrap({
      engineId: options.engineId,
      contextName: options.contextName ?? "",
      requestId,
      notificationOid: options.notificationOid,
      varBinds: options.varBinds,
    }),
    key,
    salt: Uint8Array.from(randomBytes(8)),
  });
}

export function buildSnmpV3GetRequest(
  options: SnmpV3Config & {
    requestId?: number;
    messageId?: number;
    requestedOid: string;
  },
): Uint8Array {
  const boots = options.boots ?? 1;
  const time = options.time ?? 1;
  const key = localizedKey(options.secret, options.engineId);
  return buildMessage({
    engineId: options.engineId,
    boots,
    time,
    username: options.username,
    messageId: options.messageId ?? options.requestId ?? 1,
    scopedPdu: buildScopedGet({
      engineId: options.engineId,
      contextName: "",
      requestId: options.requestId ?? 1,
      requestedOid: options.requestedOid,
    }),
    key,
    salt: Uint8Array.from(randomBytes(8)),
  });
}

function responseValue(requestedOid: string): Uint8Array {
  switch (requestedOid) {
    case "1.3.6.1.2.1.1.1.0":
      return octets("FayaNMS disposable SNMPv3 lab agent");
    case "1.3.6.1.2.1.1.5.0":
      return octets("fayanms-lab-agent");
    case "1.3.6.1.2.1.1.3.0":
      return tlv(0x43, u32(1234));
    default:
      return tlv(0x80, new Uint8Array());
  }
}

function buildScopedResponse(options: {
  engineId: Uint8Array;
  contextName: string;
  requestId: number;
  requestedOid: string;
}): Uint8Array {
  const varBind = sequence(
    oid(options.requestedOid),
    responseValue(options.requestedOid),
  );
  const pdu = tlv(
    0xa2,
    concat(
      integer(options.requestId),
      integer(0),
      integer(0),
      sequence(varBind),
    ),
  );
  return sequence(octets(options.engineId), octets(options.contextName), pdu);
}

export function readSnmpV3UsmIdentity(
  packet: Uint8Array,
): { engineId: Uint8Array; username: string } {
  const top = readTlv(packet, 0);
  const topChildren = children(packet, top);
  if (decodeInteger(packet, topChildren[0]) !== 3) {
    throw new Error("SNMPv3 version 3 is required");
  }
  const securityOctets = topChildren[2];
  const usm = readTlv(packet, securityOctets.valueStart);
  const usmChildren = children(packet, usm);
  return {
    engineId: new Uint8Array(bytes(packet, usmChildren[0])),
    username: decodeText(packet, usmChildren[3]),
  };
}

function parseAuthenticatedRequest(
  packet: Uint8Array,
  config: SnmpV3Config,
): {
  engineId: Uint8Array;
  boots: number;
  time: number;
  username: string;
  salt: Uint8Array;
  requestId: number;
  requestedOid: string;
  contextName: string;
  key: Uint8Array;
  pduTag: number;
  varBinds: SnmpV3TrapVarBind[];
} {
  const top = readTlv(packet, 0);
  const topChildren = children(packet, top);
  if (decodeInteger(packet, topChildren[0]) !== 3) {
    throw new Error("SNMPv3 version 3 is required");
  }
  const headerChildren = children(packet, topChildren[1]);
  if ((bytes(packet, headerChildren[2])[0] & 0x03) !== 0x03) {
    throw new Error("SNMPv3 authPriv flags are required");
  }
  const securityOctets = topChildren[2];
  const usm = readTlv(packet, securityOctets.valueStart);
  const usmChildren = children(packet, usm);
  const engineId = bytes(packet, usmChildren[0]);
  const boots = decodeInteger(packet, usmChildren[1]);
  const time = decodeInteger(packet, usmChildren[2]);
  const username = decodeText(packet, usmChildren[3]);
  const salt = bytes(packet, usmChildren[5]);
  if (username !== config.username) throw new Error("unknown SNMPv3 user");
  if (engineId.length !== config.engineId.length || !timingSafeEqual(Buffer.from(engineId), Buffer.from(config.engineId))) {
    throw new Error("unexpected SNMPv3 engine ID");
  }
  const key = localizedKey(config.secret, engineId);
  verifyAuthentication(packet, key);
  const scopedOctets = topChildren[3];
  const scoped = decryptScoped(bytes(packet, scopedOctets), key, boots, time, salt);
  const scopedTop = readTlv(scoped, 0);
  const scopedChildren = children(scoped, scopedTop);
  const pdu = scopedChildren[2];
  const pduChildren = children(scoped, pdu);
  const varBindList = children(scoped, pduChildren[3]);
  const varBind = varBindList[0];
  const varBindChildren = children(scoped, varBind);
  const varBinds = varBindList.map((currentVarBind) => {
    const currentChildren = children(scoped, currentVarBind);
    return {
      oid: decodeOid(scoped, currentChildren[0]),
      value: decodeSnmpValue(scoped, currentChildren[1]),
    };
  });
  return {
    engineId,
    boots,
    time,
    username,
    salt,
    requestId: decodeInteger(scoped, pduChildren[0]),
    requestedOid: decodeOid(scoped, varBindChildren[0]),
    contextName: decodeText(scoped, scopedChildren[1]),
    key,
    pduTag: pdu.tag,
    varBinds,
  };
}

export function decodeSnmpV3Trap(
  packet: Uint8Array,
  options: SnmpV3Config,
): {
  requestId: number;
  username: string;
  engineId: Uint8Array;
  boots: number;
  time: number;
  contextName: string;
  varBinds: SnmpV3TrapVarBind[];
} {
  const parsed = parseAuthenticatedRequest(packet, options);
  if (parsed.pduTag !== 0xa7) {
    throw new Error("SNMPv3 trap PDU is required");
  }
  return {
    requestId: parsed.requestId,
    username: parsed.username,
    engineId: new Uint8Array(parsed.engineId),
    boots: parsed.boots,
    time: parsed.time,
    contextName: parsed.contextName,
    varBinds: parsed.varBinds,
  };
}

export function decodeSnmpV3GetResponse(
  packet: Uint8Array,
  options: SnmpV3Config,
): { requestId: number; oid: string; value: string } {
  const parsed = parseAuthenticatedRequest(packet, options);
  const top = readTlv(packet, 0);
  const topChildren = children(packet, top);
  const securityOctets = topChildren[2];
  const usm = readTlv(packet, securityOctets.valueStart);
  const usmChildren = children(packet, usm);
  const salt = bytes(packet, usmChildren[5]);
  const scoped = decryptScoped(
    bytes(packet, topChildren[3]),
    parsed.key,
    parsed.boots,
    parsed.time,
    salt,
  );
  const scopedTop = readTlv(scoped, 0);
  const scopedChildren = children(scoped, scopedTop);
  const pduChildren = children(scoped, scopedChildren[2]);
  const responseBind = children(scoped, pduChildren[3])[0];
  const responseBindChildren = children(scoped, responseBind);
  return {
    requestId: decodeInteger(scoped, pduChildren[0]),
    oid: decodeOid(scoped, responseBindChildren[0]),
    value: decodeText(scoped, responseBindChildren[1]),
  };
}

export function createSnmpV3Agent(
  config: SnmpV3Config & { host?: string; port?: number },
): {
  socket: Socket;
  listening: Promise<{ address: string; port: number }>;
  close: () => Promise<void>;
} {
  if (config.host && config.host !== "127.0.0.1") {
    throw new Error("the SNMPv3 lab agent binds to loopback only");
  }
  const socket = createSocket("udp4");
  const listening = new Promise<{ address: string; port: number }>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("listening", () => {
      const address = socket.address();
      if (typeof address === "string") {
        reject(new Error("unexpected Unix socket"));
      } else {
        resolve({ address: address.address, port: address.port });
      }
    });
  });
  socket.on("message", (message, remote) => {
    try {
      const packet = new Uint8Array(message);
      const request = parseAuthenticatedRequest(packet, config);
      const response = buildMessage({
        engineId: config.engineId,
        boots: request.boots,
        time: request.time,
        username: config.username,
        messageId: request.requestId,
        scopedPdu: buildScopedResponse({
          engineId: config.engineId,
          contextName: request.contextName,
          requestId: request.requestId,
          requestedOid: request.requestedOid,
        }),
        key: request.key,
        salt: Uint8Array.from(randomBytes(8)),
      });
      socket.send(response, remote.port, remote.address);
    } catch (error: unknown) {
      // The disposable agent fails closed on malformed, unauthenticated, or
      // non-authPriv packets. The message contains no packet bytes or secrets
      // and makes lab troubleshooting observable without opening a data path.
      console.error(
        "SNMPv3 lab packet rejected:",
        error instanceof Error ? error.message : "unknown packet error",
      );
    }
  });
  socket.bind(config.port ?? 0, config.host ?? "127.0.0.1");
  return {
    socket,
    listening,
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => resolve());
      }),
  };
}
