import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { nextPost, log } from "./next-client";
import { resolveVaultSecret } from "./vault";
import {
  decodeSnmpV3Trap,
  readSnmpV3UsmIdentity,
} from "../../scripts/protocol-lab/snmpv3";
import { normalizeEngineIdHex } from "../../src/lib/protocol/snmpv3-policy";
import { PROTOCOLS, type ProtocolName } from "../../src/lib/protocol/ingest";

const DEFAULT_PORTS: Record<ProtocolName, number> = {
  syslog: 5514,
  "snmp-trap": 1162,
  netflow: 2055,
  ipfix: 4739,
  sflow: 6343,
};
const MAX_PACKET_BYTES = 65_535;
const MAX_IN_FLIGHT = 32;

export interface ProtocolCollectorMetrics {
  enabled: boolean;
  sockets: number;
  packetsReceived: number;
  packetsAccepted: number;
  packetsRejected: number;
  queueDrops: number;
  relayFailures: number;
}

let metrics: ProtocolCollectorMetrics = {
  enabled: false,
  sockets: 0,
  packetsReceived: 0,
  packetsAccepted: 0,
  packetsRejected: 0,
  queueDrops: 0,
  relayFailures: 0,
};
let activeRelays = 0;
let activeVerifications = 0;

export interface SnmpV3ProfileReference {
  credentialProfileId: string;
  hostname: string;
  username: string;
  secretRef: string;
  engineIdHex: string;
}

interface DecodedProtocolPayload {
  eventType: string;
  severity: string;
  message: string;
  protocolVersion: string;
  securityLevel?: "authPriv" | "community" | "unknown";
  deviceHint?: { hostname: string; credentialProfileId?: string };
  attributes: Record<string, string | number | boolean | null>;
}


function envKey(protocol: ProtocolName, suffix: string): string {
  return "FAYANMS_" + protocol.toUpperCase().replace(/-/g, "_") + suffix;
}

function portFor(protocol: ProtocolName): number {
  const key = envKey(protocol, "_PORT");
  const raw = process.env[key]?.trim();
  const port = raw ? Number(raw) : DEFAULT_PORTS[protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(key + " must be an integer UDP port from 1 to 65535");
  }
  return port;
}

function severityFromSyslog(priority: number): string {
  return ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"][priority % 8] ?? "INFO";
}

function parseSyslog(packet: Buffer): DecodedProtocolPayload {
  const text = packet.toString("utf8", 0, Math.min(packet.length, 8192));
  const priorityMatch = /^<([0-9]{1,3})>/.exec(text);
  const priority = priorityMatch ? Number(priorityMatch[1]) : 14;
  const stripped = priorityMatch ? text.slice(priorityMatch[0].length) : text;
  const fields = stripped.split(/\s+/);
  const is5424 = fields[0] === "1";
  const hostname = is5424 ? fields[2] : fields[0];
  return {
    eventType: "SYSLOG_MESSAGE",
    severity: severityFromSyslog(priority),
    message: stripped,
    protocolVersion: is5424 ? "RFC5424" : "RFC3164_OR_PLAIN",
    deviceHint: hostname && hostname !== "-" ? { hostname } : undefined,
    attributes: { facility: Math.floor(priority / 8), priority },
  };
}

function readVersion(packet: Buffer): number | null {
  return packet.length >= 4 ? packet.readUInt32BE(0) : null;
}

function parseBinary(protocol: ProtocolName, packet: Buffer): DecodedProtocolPayload | null {
  if (protocol === "snmp-trap") {
    if (packet.length < 2 || packet[0] !== 0x30) return null;
    return {
      eventType: "SNMP_TRAP",
      severity: "INFO",
      message: "SNMP trap packet received",
      protocolVersion: "BER",
      securityLevel: "unknown",
      attributes: { bytes: packet.length },
    };
  }
  const version = readVersion(packet);
  if (version === null) return null;
  const expected = protocol === "netflow" ? [5, 9] : protocol === "ipfix" ? [10] : [5];
  if (!expected.includes(version)) return null;
  return {
    eventType: protocol === "sflow" ? "SFLOW_SAMPLE" : "FLOW_RECORD_BATCH",
    severity: "INFO",
    message: protocol + " packet received",
    protocolVersion: protocol.toUpperCase() + "_V" + version,
    attributes: { bytes: packet.length, version },
  };
}

export function decodeProtocolPacket(
  protocol: ProtocolName,
  packet: Buffer,
  remote: Pick<RemoteInfo, "address" | "port">,
) {
  if (packet.length === 0 || packet.length > MAX_PACKET_BYTES) return null;
  const parsed = protocol === "syslog" ? parseSyslog(packet) : parseBinary(protocol, packet);
  if (!parsed) return null;
  return {
    collectorId: process.env.FAYANMS_PROTOCOL_COLLECTOR_ID?.trim() || "worker-1",
    protocol,
    sourceIp: remote.address,
    sourcePort: remote.port,
    receivedAt: new Date().toISOString(),
    ...parsed,
  };
}

export async function decodeVerifiedSnmpV3Trap(
  packet: Buffer,
  remote: Pick<RemoteInfo, "address" | "port">,
  profile: SnmpV3ProfileReference,
) {
  const identity = readSnmpV3UsmIdentity(new Uint8Array(packet));
  if (identity.username !== profile.username) {
    throw new Error("SNMPv3 profile username mismatch");
  }
  if (normalizeEngineIdHex(identity.engineId) !== profile.engineIdHex.toLowerCase()) {
    throw new Error("SNMPv3 profile engine ID mismatch");
  }
  const secret = await resolveVaultSecret(profile.secretRef);
  const decoded = decodeSnmpV3Trap(
    new Uint8Array(packet),
    {
      engineId: identity.engineId,
      username: profile.username,
      secret,
    },
  );
  const notification = decoded.varBinds.find(
    (varBind) => varBind.oid === "1.3.6.1.6.3.1.1.4.1.0",
  );
  return {
    collectorId: process.env.FAYANMS_PROTOCOL_COLLECTOR_ID?.trim() || "worker-1",
    protocol: "snmp-trap" as const,
    sourceIp: remote.address,
    sourcePort: remote.port,
    receivedAt: new Date().toISOString(),
    eventType: "SNMP_TRAP",
    severity: "INFO",
    message: "Verified SNMPv3 authPriv trap",
    protocolVersion: "SNMPV3_USM_AUTHPRIV",
    securityLevel: "authPriv" as const,
    deviceHint: {
      hostname: profile.hostname,
      credentialProfileId: profile.credentialProfileId,
    },
    attributes: {
      requestId: decoded.requestId,
      engineId: Buffer.from(decoded.engineId).toString("hex").slice(0, 64),
      varBindCount: decoded.varBinds.length,
      notificationOid:
        typeof notification?.value === "string" ? notification.value : null,
    },
  };
}

export function getProtocolCollectorMetrics(): ProtocolCollectorMetrics {
  return { ...metrics };
}

export function startProtocolCollector(): { stop: () => void } | null {
  if (process.env.FAYANMS_PROTOCOL_COLLECTOR_ENABLED?.trim().toLowerCase() !== "true") {
    return null;
  }
  const host = process.env.FAYANMS_PROTOCOL_COLLECTOR_BIND?.trim() || "127.0.0.1";
  const protocols = PROTOCOLS.filter(
    (protocol) => process.env[envKey(protocol, "_DISABLED")]?.trim().toLowerCase() !== "true",
  );
  const sockets: Socket[] = [];
  metrics = { ...metrics, enabled: true, sockets: 0 };

  const relay = (event: Record<string, unknown>) => {
    if (activeRelays + activeVerifications >= MAX_IN_FLIGHT) {
      metrics.queueDrops += 1;
      return;
    }
    activeRelays += 1;
    metrics.packetsAccepted += 1;
    void nextPost("/api/v1/ingest/protocol", event, 5_000)
      .catch(() => { metrics.relayFailures += 1; })
      .finally(() => { activeRelays -= 1; });
  };

  const verifyAndRelaySnmpTrap = async (packet: Buffer, remote: RemoteInfo) => {
    if (activeRelays + activeVerifications >= MAX_IN_FLIGHT) {
      metrics.queueDrops += 1;
      return;
    }
    activeVerifications += 1;
    try {
      const identity = readSnmpV3UsmIdentity(new Uint8Array(packet));
      const profileResult = await nextPost(
        "/api/v1/ingest/protocol/snmpv3-profile",
        {
          sourceIp: remote.address,
          username: identity.username,
          engineId: Buffer.from(identity.engineId).toString("hex"),
        },
        5_000,
      );
      if (
        !profileResult ||
        typeof profileResult !== "object" ||
        !("profile" in profileResult) ||
        !profileResult.profile ||
        typeof profileResult.profile !== "object"
      ) {
        throw new Error("SNMPv3 profile lookup returned no profile");
      }
      const profile = profileResult.profile as Partial<SnmpV3ProfileReference>;
      if (
        typeof profile.credentialProfileId !== "string" ||
        typeof profile.hostname !== "string" ||
        typeof profile.username !== "string" ||
        typeof profile.secretRef !== "string" ||
        typeof profile.engineIdHex !== "string"
      ) {
        throw new Error("SNMPv3 profile lookup returned an invalid profile");
      }
      const event = await decodeVerifiedSnmpV3Trap(packet, remote, {
        credentialProfileId: profile.credentialProfileId,
        hostname: profile.hostname,
        username: profile.username,
        secretRef: profile.secretRef,
        engineIdHex: profile.engineIdHex.toLowerCase(),
      });
      await nextPost(
        "/api/v1/ingest/protocol/snmpv3-profile/accept",
        {
          sourceIp: remote.address,
          username: identity.username,
          credentialProfileId: profile.credentialProfileId,
          engineIdHex: Buffer.from(identity.engineId).toString("hex"),
          boots: identity.boots,
          time: identity.time,
        },
        5_000,
      );
      relay(event);
    } catch {
      // Fail closed. Error messages never include packet bytes or secrets.
      metrics.packetsRejected += 1;
    } finally {
      activeVerifications -= 1;
    }
  };

  for (const protocol of protocols) {
    const socket = createSocket("udp4");
    socket.on("message", (packet, remote) => {
      metrics.packetsReceived += 1;
      if (protocol === "snmp-trap") {
        void verifyAndRelaySnmpTrap(packet, remote);
        return;
      }
      const event = decodeProtocolPacket(protocol, packet, remote);
      if (!event) {
        metrics.packetsRejected += 1;
        return;
      }
      relay(event);
    });
    socket.on("error", (error) => {
      metrics.relayFailures += 1;
      void log("protocol collector " + protocol + " socket error: " + error.message);
    });
    socket.bind(portFor(protocol), host);
    sockets.push(socket);
  }
  metrics.sockets = sockets.length;
  void log("protocol collector enabled on " + host + " for " + protocols.join(","));
  return {
    stop: () => {
      for (const socket of sockets) socket.close();
      metrics.sockets = 0;
      metrics.enabled = false;
    },
  };
}
