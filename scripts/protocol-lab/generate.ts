import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import {
  encodeIpfixTemplate,
  encodeNetflowV5,
  encodeNetflowV9Template,
  encodeRfc3164,
  encodeRfc5424,
  encodeSflowCounterSample,
  encodeSnmpV1Trap,
  encodeSnmpV2cTrap,
  type FlowRecord,
} from "./codec";

export function isAllowedLabHost(
  host: string,
  allowNonLoopback = false,
): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  return allowNonLoopback && isIP(host) !== 0;
}

export function makePacket(protocol: string, index = 0): Uint8Array {
  switch (protocol) {
    case "syslog3164":
      return encodeRfc3164({
        facility: 4,
        severity: index % 8,
        message: "fayanms protocol-lab syslog3164 #" + index,
      });
    case "syslog5424":
      return encodeRfc5424({
        facility: 4,
        severity: index % 8,
        message: "fayanms protocol-lab syslog5424 #" + index,
      });
    case "snmp-v1-trap":
      return encodeSnmpV1Trap({
        enterpriseOid: "1.3.6.1.4.1.55555.1",
        specificTrap: index + 1,
        varBinds: [
          {
            oid: "1.3.6.1.2.1.1.5.0",
            value: { kind: "octets", value: "fayanms-lab" },
          },
        ],
      });
    case "snmp-v2c-trap":
      return encodeSnmpV2cTrap({
        trapOid: "1.3.6.1.4.1.55555.1.0.1",
        requestId: index + 1,
        varBinds: [
          {
            oid: "1.3.6.1.2.1.1.5.0",
            value: { kind: "octets", value: "fayanms-lab" },
          },
        ],
      });
    case "netflow-v5":
      return encodeNetflowV5({
        sequence: index + 1,
        records: [
          {
            srcAddr: "192.0.2.10",
            dstAddr: "198.51.100.20",
            srcPort: 12345,
            dstPort: 443,
          },
        ],
      });
    case "netflow-v9-template":
      return encodeNetflowV9Template({ templateId: 256 + (index % 8) });
    case "ipfix-template":
      return encodeIpfixTemplate({ templateId: 256 + (index % 8) });
    case "sflow-counter":
      return encodeSflowCounterSample({ sequence: index + 1 });
    default:
      throw new Error(
        "Unknown protocol " +
          protocol +
          ". Use syslog3164, syslog5424, snmp-v1-trap, snmp-v2c-trap, netflow-v5, netflow-v9-template, ipfix-template, or sflow-counter.",
      );
  }
}

export async function sendUdp(
  host: string,
  port: number,
  packet: Uint8Array,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.send(packet, port, host, (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const separator = arg.indexOf("=");
    if (separator < 0) {
      args[arg.slice(2)] = "true";
    } else {
      args[arg.slice(2, separator)] = arg.slice(separator + 1);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const protocol = args.protocol ?? "syslog5424";
  const host = args.host ?? "127.0.0.1";
  const port = Number(args.port ?? "5514");
  const count = Number(args.count ?? "1");
  const allowNonLoopback =
    process.env.FAYANMS_PROTOCOL_LAB_ALLOW_NON_LOOPBACK === "true";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer in the range 1..65535");
  }
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("count must be an integer in the range 1..1000");
  }
  if (!isAllowedLabHost(host, allowNonLoopback)) {
    throw new Error(
      "refusing non-loopback lab target; set FAYANMS_PROTOCOL_LAB_ALLOW_NON_LOOPBACK=true only for an approved isolated lab CIDR",
    );
  }

  for (let index = 0; index < count; index += 1) {
    await sendUdp(host, port, makePacket(protocol, index));
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
