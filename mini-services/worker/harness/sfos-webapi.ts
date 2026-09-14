/**
 * FayaNMS worker — Sophos SFOS WebAPI harness (CERT-006).
 *
 * A REAL loopback HTTPS server speaking the SFOS WebAPI envelope: POST
 * /webserver/API with a JSON body { action, api-key, ... } and a JSON
 * response shaped like the device's {"Response": {"@id", "Status":
 * {"@code", "@message"}, ...}} — vendor-realistic payloads, same
 * certification discipline as the SSH personas (harness/*-sshd.ts).
 *
 * TLS: serves the COMMITTED self-signed harness certificate
 * (harness/tls/sfos-webapi-{cert,key}.pem — test-only, loopback-only,
 * never production material). Certification proves the transport's
 * fail-closed TLS posture against it:
 *   - WITHOUT FAYANMS_WEBAPI_CA_PEM → the self-signed cert is untrusted
 *     and the transport must refuse BEFORE any credential is sent;
 *   - WITH FAYANMS_WEBAI_CA_PEM=<the harness cert> → the full TLS
 *     handshake, request and response flow succeed.
 *
 * Read-only harness: it answers GetAuthStatus and GetConfig (and rejects
 * everything else exactly like a device would — an unsupported action
 * error), it holds NO state that can be mutated, and it records every
 * received request so the certification can assert exactly what crossed
 * the wire.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SfosWebApiRequest {
  action: string;
  hasApiKey: boolean;
  apiKeyMatches: (candidate: string) => boolean;
}

export interface SfosWebApiHarness {
  port: number;
  stop: () => Promise<void>;
  requests: SfosWebApiRequest[];
  /** The certificate PEM (for the transport's FAYANMS_WEBAPI_CA_PEM). */
  caPem: string;
  /** GC anchor — Bun collects listeners nothing references; callers must
   *  keep the harness object (and therefore this server) alive. */
  _server: unknown;
}

/** The SFOS-style running configuration the harness serves. */
export const SFOS_HARNESS_CONFIG = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<Configuration APIVersion=\"19.5 MR-1\" Ver=\"Reporting\">",
  "  <System>",
  "    <Hostname>HARNESS-SFOS-01</Hostname>",
  "    <TimeZone>Asia/Riyadh</TimeZone>",
  "  </System>",
  "  <Network>",
  "    <Interface>",
  "      <Name>Port2</Name>",
  "      <Type>Static</Type>",
  "      <IP>10.20.30.1</IP>",
  "      <Netmask>255.255.255.0</Netmask>",
  "      <Description>SFOS-CONFIG-MARKER-HARNESS</Description>",
  "    </Interface>",
  "  </Network>",
  "  <Firewall>",
  "    <Rule>",
  "      <Name>Allow LAN to WAN</Name>",
  "      <Action>Accept</Action>",
  "    </Rule>",
  "  </Firewall>",
  "</Configuration>",
].join("\n");

const HARNESS_API_KEY = "sfos-harness-api-key-0123456789abcdef";

function envelope(id: string, code: string, message: string): Record<string, unknown> {
  return {
    Response: {
      "@id": id,
      Status: { "@code": code, "@message": message },
    },
  };
}

function configEnvelope(id: string): Record<string, unknown> {
  return {
    Response: {
      "@id": id,
      Status: { "@code": "440", "@message": "Action succeeded" },
      Configuration: {
        "#cdata-section": SFOS_HARNESS_CONFIG,
      },
    },
  };
}

export interface SfosWebApiHarnessOptions {
  /** Reject the api-key (auth failure path) — default false. */
  rejectAuth?: boolean;
  /** Serve a malformed body (malformed-response path) — default false. */
  malformed?: boolean;
}

export async function startSfosWebApiHarness(
  opts: SfosWebApiHarnessOptions = {},
): Promise<SfosWebApiHarness> {
  const tlsDir = join(import.meta.dir, "tls");
  const caPem = readFileSync(join(tlsDir, "sfos-webapi-cert.pem"), "utf8");
  const keyPem = readFileSync(join(tlsDir, "sfos-webapi-key.pem"), "utf8");

  const requests: SfosWebApiRequest[] = [];

  const server = Bun.serve({
    port: 0, // ephemeral
    tls: {
      cert: caPem,
      key: keyPem,
    },
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/webserver/API") {
        return Response.json(
          envelope("0", "400", "Not Found"),
          { status: 404 },
        );
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await req.text());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        return Response.json(envelope("0", "400", "Malformed request"), { status: 400 });
      }
      const action = typeof body["action"] === "string" ? body["action"] : "";
      const apiKey = typeof body["api-key"] === "string" ? body["api-key"] : "";
      requests.push({
        action,
        hasApiKey: apiKey.length > 0,
        apiKeyMatches: (candidate) => apiKey === candidate,
      });

      if (opts.rejectAuth) {
        return Response.json(
          envelope("1", "404", "Authentication failed: invalid API key"),
          { status: 200 },
        );
      }
      if (apiKey !== HARNESS_API_KEY) {
        return Response.json(
          envelope("1", "404", "Authentication failed: invalid API key"),
          { status: 200 },
        );
      }
      if (opts.malformed) {
        return new Response("<html>not-json</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (action === "GetAuthStatus") {
        return Response.json({
          Response: {
            "@id": "1",
            Status: { "@code": "440", "@message": "Action succeeded" },
            AuthStatus: {
              Administrator: { Name: "api", Login: { Time: "2026-09-14 22:00" } },
              DeviceInfo: { Model: "XGS 2100", FirmwareVersion: "SFOS 20.0.1" },
            },
          },
        });
      }
      if (action === "GetConfig") {
        return Response.json(configEnvelope("2"));
      }
      // Device-realistic refusal for ANY other action — the transport must
      // never send one, and the harness asserts that by construction.
      return Response.json(
        envelope("3", "400", "Unsupported action"),
        { status: 200 },
      );
    },
  });

  return {
    // Bun assigns the ephemeral port at listen time; the type is
    // number | undefined only because port 0 was requested.
    port: server.port ?? 0,
    caPem,
    requests,
    // LAZY on purpose: `stop: server.stop(true)` would stop the server the
    // moment the harness object is built.
    stop: async () => {
      server.stop(true);
    },
    _server: server,
  };
}

/** The api-key the harness accepts (worker-side vault entry for certify). */
export const SFOS_HARNESS_API_KEY = HARNESS_API_KEY;
