/// <reference types="bun-types" />
/**
 * FayaNMS worker mini-service — entry point (bun, zero dependencies).
 *
 * HTTP surface on port 3030 (hardcoded per Task 2-b; the gateway only exposes
 * 3000 — this service is backend-to-backend):
 *   GET  /health          → liveness + in-memory job counters + adapter names
 *   GET  /capabilities    → adapter capability manifests
 *   POST /simulate/connect→ simulated device connect (test-connection flow +
 *                           the runner's own connect step)
 *
 * Background loops:
 *   runner.ts    — claims CONFIG_BACKUP jobs from Next.js every 3 s
 *   scheduler.ts — pokes POST /api/v1/worker/tick every 30 s (+10 s after boot)
 *
 * This service never touches SQLite; all persistence flows through
 * http://localhost:3000 (see next-client.ts header note).
 */

import { adapters, pickAdapter, type DeviceTarget } from "./adapters";
import { startRunner, getCounters } from "./runner";
import { startScheduler } from "./scheduler";
import { log } from "./next-client";

const PORT = 3030; // hardcoded — do not read PORT env (task 2-b contract)
const STARTED_AT = Date.now();

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "fayanms-worker",
        uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
        jobs: getCounters(),
        adapters: adapters.map((a) => a.adapter),
      });
    }

    if (req.method === "GET" && url.pathname === "/capabilities") {
      return Response.json(
        adapters.map((a) => ({
          vendor: a.vendor,
          adapter: a.adapter,
          capabilities: a.capabilities,
          configFlavor: a.configFlavor,
          notes: a.notes,
        }))
      );
    }

    if (req.method === "POST" && url.pathname === "/simulate/connect") {
      let body: Record<string, unknown> | undefined;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { ok: false, error: "Request body must be valid JSON" },
          { status: 400 }
        );
      }
      const vendor = typeof body?.vendor === "string" ? body.vendor.trim() : "";
      const host = typeof body?.host === "string" ? body.host.trim() : "";
      const hostname =
        typeof body?.hostname === "string" && body.hostname.trim()
          ? body.hostname.trim()
          : host;
      if (!vendor || !host) {
        return Response.json(
          {
            ok: false,
            error: "Body must be { vendor: string, host: string, hostname?: string }",
          },
          { status: 400 }
        );
      }
      const target: DeviceTarget = {
        deviceId: "manual-test",
        hostname,
        vendor,
      };
      const adapter = pickAdapter(vendor); // unknown vendor → generic (ok)
      const conn = await adapter.connect(target);
      return Response.json({
        ok: true,
        vendor,
        host,
        latencyMs: conn.latencyMs,
        banner: conn.banner,
        negotiated: conn.negotiated,
      });
    }

    return Response.json({ ok: false, error: `No route: ${req.method} ${url.pathname}` }, { status: 404 });
  } catch (e) {
    // Handler errors are JSON, never hangs (all inner work is timeout-bounded).
    return Response.json(
      { ok: false, error: (e as Error)?.message ?? "internal error" },
      { status: 500 }
    );
  }
}

const server = Bun.serve({ port: PORT, fetch: (req) => handle(req) });
log(`fayanms-worker v0.1.0 listening on :${server.port}`);
startRunner();
startScheduler();

process.on("SIGTERM", () => {
  log("SIGTERM received — shutting down");
  server.stop(true);
  process.exit(0);
});
process.on("SIGINT", () => {
  log("SIGINT received — shutting down");
  server.stop(true);
  process.exit(0);
});
