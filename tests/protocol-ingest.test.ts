import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { associateProtocolDevice, normalizeProtocolEvent } from "../src/lib/protocol/ingest";

test("protocol normalization bounds messages and attributes", () => {
  const event = normalizeProtocolEvent({
    collectorId: "collector-a",
    protocol: "syslog",
    sourceIp: "192.0.2.20",
    sourcePort: 5514,
    receivedAt: new Date("2026-09-21T00:00:00.000Z"),
    eventType: "SYSLOG_MESSAGE",
    severity: "info",
    message: "x".repeat(9000),
    attributes: { keep: "y".repeat(900), drop: Number.NaN },
  });
  expect(event.message.length).toBe(2048);
  expect(event.attributes.keep).toBe("y".repeat(256));
  expect(event.attributes.drop).toBeNull();
});

test("protocol association prefers hostname over source IP", () => {
  const candidates = [
    { id: "by-host", hostname: "router-a", mgmtIp: "192.0.2.21" },
    { id: "by-ip", hostname: "router-b", mgmtIp: "192.0.2.20" },
  ];
  const result = associateProtocolDevice(
    { sourceIp: "192.0.2.20", deviceHint: { hostname: "router-a" } },
    candidates,
  );
  expect(result.method).toBe("hostname");
  expect(result.device?.id).toBe("by-host");
});

test("ingestion route requires telemetry scope and stores no raw packet field", () => {
  const route = readFileSync("src/app/api/v1/ingest/protocol/route.ts", "utf8");
  expect(route).toContain('authenticateServiceRequest(request, "telemetry")');
  expect(route).toContain("PROTOCOL_EVENT_RECEIVED");
  expect(route).not.toContain("payloadBase64");
});
