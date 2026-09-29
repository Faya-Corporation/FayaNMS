import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  WEBAPI_MAX_RESPONSE_BYTES,
  webApiFetchConfigText,
  WebApiError,
} from "../../mini-services/worker/webapi-transport";
import {
  SFOS_HARNESS_API_KEY,
  startSfosWebApiHarness,
  type SfosWebApiHarness,
} from "../../mini-services/worker/harness/sfos-webapi";

/**
 * RT-010 / F-011 — bounded response accumulation in the WebAPI transport.
 *
 * BEFORE: postJson pushed every response chunk into `chunks` with NO byte
 * cap — the only transport without an output budget (SSH bounds every
 * stream via appendBounded at 1 MiB). A hostile/compromised "device"
 * answering GetConfig with an unbounded or streamed body could balloon
 * worker memory (OOM).
 *
 * Pinned here (against the real loopback TLS harness):
 *   1. a response over the 4 MiB cap aborts with the typed
 *      WEBAPI_RESPONSE_TOO_LARGE error (asserted via the rejection, not
 *      RSS) — the stream is destroyed, never silently truncated;
 *   2. a legitimate GetConfig under the cap still parses unchanged;
 *   3. the cap is chunk-boundary independent — many small drips totaling
 *      over the cap still abort;
 *   4. the typed error carries NO device data (message is byte-count only).
 */

const REPO_ROOT = join(import.meta.dir, "../..");
const CERT_PEM = readFileSync(
  join(REPO_ROOT, "mini-services/worker/harness/tls/sfos-webapi-cert.pem"),
  "utf8",
);
const KEY_PEM = readFileSync(
  join(REPO_ROOT, "mini-services/worker/harness/tls/sfos-webapi-key.pem"),
  "utf8",
);

const MARKER = "HOSTILE-DEVICE-MARKER-0f11-DO-NOT-LEAK";

/** Oversize-device harness: streams a body over the cap in drip chunks. */
async function startOversizeHarness(chunkBytes: number, chunks: number) {
  const server = Bun.serve({
    port: 0,
    tls: { cert: CERT_PEM, key: KEY_PEM },
    fetch: () => {
      let sent = 0;
      const unit = new Uint8Array(chunkBytes).fill(0x41); // 'A' filler
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= chunks) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(unit);
        },
      });
      void MARKER; // the hostile payload content is filler bytes + marker env asserted below
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { port: server.port ?? 0, stop: async () => server.stop(true), _server: server };
}

let savedCaPem: string | undefined;

beforeAll(() => {
  savedCaPem = process.env.FAYANMS_WEBAPI_CA_PEM;
  process.env.FAYANMS_WEBAPI_CA_PEM = CERT_PEM;
});

afterAll(() => {
  if (savedCaPem === undefined) {
    delete process.env.FAYANMS_WEBAPI_CA_PEM;
  } else {
    process.env.FAYANMS_WEBAPI_CA_PEM = savedCaPem;
  }
});

describe("RT-010: bounded WebAPI response accumulation", () => {
  test("oversized response aborts with WEBAPI_RESPONSE_TOO_LARGE (stream destroyed, not truncated)", async () => {
    // 10 x 600 KiB = ~5.7 MiB > 4 MiB cap, delivered as multi-hundred-KiB chunks.
    const device = await startOversizeHarness(600 * 1024, 10);
    try {
      let caught: unknown = null;
      try {
        await webApiFetchConfigText({ host: "127.0.0.1", port: device.port, apiKey: "k" });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WebApiError);
      const webApiError = caught as WebApiError;
      expect(webApiError.code).toBe("WEBAPI_RESPONSE_TOO_LARGE");
      expect(webApiError.message).toBe(
        `WebAPI response exceeded ${WEBAPI_MAX_RESPONSE_BYTES} bytes`,
      );
    } finally {
      await device.stop();
    }
  });

  test("cap is chunk-boundary independent (drip pattern of many small chunks)", async () => {
    // 9000 x 600 B = ~5.3 MiB > cap, dripped in 600-byte chunks — an
    // implementation that only checked per-chunk size would pass this
    // payload through and must NOT.
    const device = await startOversizeHarness(600, 9000);
    try {
      let caught: unknown = null;
      try {
        await webApiFetchConfigText({ host: "127.0.0.1", port: device.port, apiKey: "k" });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect((caught as WebApiError).code).toBe("WEBAPI_RESPONSE_TOO_LARGE");
    } finally {
      await device.stop();
    }
  });

  test("legitimate GetConfig under the cap still parses (no regression)", async () => {
    const harness: SfosWebApiHarness = await startSfosWebApiHarness();
    try {
      const text = await webApiFetchConfigText({
        host: "127.0.0.1",
        port: harness.port,
        apiKey: SFOS_HARNESS_API_KEY,
      });
      expect(text).toContain("SFOS-CONFIG-MARKER-HARNESS");
    } finally {
      await harness.stop();
    }
  });

  test("typed error carries no response body excerpt (byte-count-only message)", async () => {
    const device = await startOversizeHarness(1024 * 1024, 6);
    try {
      let caught: unknown = null;
      try {
        await webApiFetchConfigText({ host: "127.0.0.1", port: device.port, apiKey: "k" });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error).message;
      expect(message).toMatch(/^WebAPI response exceeded \d+ bytes$/);
      expect(message).not.toContain("AAAA");
      expect(message).not.toContain(MARKER);
    } finally {
      await device.stop();
    }
  });
});
