import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { describe, expect, test } from "bun:test";
import {
  buildSnmpV3GetRequest,
  createSnmpV3Agent,
  decodeSnmpV3GetResponse,
} from "../scripts/protocol-lab/snmpv3";

function receive(socket: ReturnType<typeof createSocket>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("SNMPv3 response timeout"));
    }, 1500);
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

describe("CLOUD-11 SNMPv3 authPriv disposable agent", () => {
  test("polls a real encrypted/authenticated GET over loopback UDP", async () => {
    const secret = randomBytes(24).toString("hex");
    const engineId = Uint8Array.from([
      0x80,
      0x00,
      0x1f,
      0x88,
      0x80,
      ...randomBytes(6),
    ]);
    const config = {
      engineId,
      username: "lab-user",
      secret,
      host: "127.0.0.1",
      port: 0,
      requestId: 42,
    };
    const agent = createSnmpV3Agent(config);
    try {
      const address = await agent.listening;
      const client = createSocket("udp4");
      client.bind(0, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("listening", () => resolve()));
      const response = receive(client);
      await new Promise<void>((resolve, reject) => {
        client.send(
          buildSnmpV3GetRequest({
            ...config,
            requestId: 42,
            requestedOid: "1.3.6.1.2.1.1.5.0",
          }),
          address.port,
          address.address,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      const decoded = decodeSnmpV3GetResponse(await response, config);
      expect(decoded.requestId).toBe(42);
      expect(decoded.oid).toBe("1.3.6.1.2.1.1.5.0");
      expect(decoded.value).toBe("fayanms-lab-agent");
    } finally {
      await agent.close();
    }
  });
});
