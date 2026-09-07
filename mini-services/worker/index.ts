/// <reference types="bun-types" />
/**
 * FayaNMS worker mini-service — entry point (bun, zero dependencies).
 *
 * HTTP surface on port 3030 (hardcoded per Task 2-b; the gateway only exposes
 * 3000 — this service is backend-to-backend):
 *   GET  /health          → liveness + in-memory job counters + adapter names
 *   GET  /capabilities    → adapter capability manifests
 *   POST /simulate/connect   → simulated device connect (test-connection flow +
 *                              the runner's own connect step)
 *   POST /simulate/generate-config → vendor-flavored config text (Task 4-b
 *                              change engine pre/post backups)
 *   POST /simulate/apply      → config text with a change-flavored delta
 *                              (Task 4-b apply step; HTTP 500 when the demo
 *                              control payload.failAt === "APPLY")
 *
 * Background loops (Task 10-a: both self-schedule with exponential backoff
 * and auto-recover while the backend is down):
 *   runner.ts    — claims QUEUED jobs from Next.js (3 s cadence, backoff to
 *                  5 min on backend outage, greppable recovery line)
 *   scheduler.ts — pokes POST /api/v1/worker/tick every 30 s (+10 s after boot,
 *                  same backoff pattern)
 *
 * Process guards: unhandledRejection / uncaughtException are logged and
 * contained — the HTTP server keeps answering /health.
 *
 * This service never touches SQLite; all persistence flows through
 * http://localhost:3000 (see next-client.ts header note).
 */

import { adapters, pickAdapter, type DeviceTarget } from "./adapters";
import { startRunner, getCounters } from "./runner";
import { startScheduler, getSchedulerState } from "./scheduler";
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
        scheduler: getSchedulerState(),
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

    if (req.method === "POST" && url.pathname === "/simulate/generate-config") {
      let body: Record<string, unknown> | undefined;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { ok: false, error: "Request body must be valid JSON" },
          { status: 400 }
        );
      }
      const hostname = typeof body?.hostname === "string" ? body.hostname.trim() : "";
      const flavor = typeof body?.flavor === "string" ? body.flavor.trim() : "generic";
      if (!hostname) {
        return Response.json(
          { ok: false, error: "Body must be { hostname: string, flavor?: string, managementIp?: string }" },
          { status: 400 }
        );
      }
      // Task 4-b — vendor-flavored running config for pre/post-change
      // backups; same generators the CONFIG_BACKUP path uses.
      const target: DeviceTarget = {
        deviceId: "simulate-generate",
        hostname,
        vendor: flavor || "generic",
        model: typeof body?.model === "string" ? body.model : null,
        managementIp: typeof body?.managementIp === "string" ? body.managementIp : null,
      };
      const config = await pickAdapter(flavor).fetchConfig(target);
      return Response.json({ ok: true, configText: config.rawText, configFlavor: pickAdapter(flavor).configFlavor });
    }

    if (req.method === "POST" && url.pathname === "/simulate/apply") {
      let body: Record<string, unknown> | undefined;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { ok: false, error: "Request body must be valid JSON" },
          { status: 400 }
        );
      }
      const hostname = typeof body?.hostname === "string" ? body.hostname.trim() : "";
      const flavor = typeof body?.flavor === "string" ? body.flavor.trim() : "generic";
      const changeTitle =
        typeof body?.changeTitle === "string" && body.changeTitle.trim()
          ? body.changeTitle.trim()
          : "configuration update";
      const failAt = typeof body?.failAt === "string" ? body.failAt.trim() : null;
      if (!hostname) {
        return Response.json(
          { ok: false, error: "Body must be { hostname: string, flavor?: string, changeTitle?: string, failAt?: string }" },
          { status: 400 }
        );
      }
      if (failAt === "APPLY") {
        // Demo control — forces the change engine down its rollback path.
        return Response.json(
          {
            ok: false,
            error: `Simulated apply failure on ${hostname} — commit aborted (demo control failAt=APPLY)`,
          },
          { status: 500 }
        );
      }
      const target: DeviceTarget = {
        deviceId: "simulate-apply",
        hostname,
        vendor: flavor || "generic",
        model: typeof body?.model === "string" ? body.model : null,
        managementIp: typeof body?.managementIp === "string" ? body.managementIp : null,
      };
      const adapter = pickAdapter(flavor);
      const config = await adapter.fetchConfig(target);
      return Response.json({
        ok: true,
        configText: applyChangeDelta(config.rawText, adapter.configFlavor, changeTitle),
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

/* ───────────────────── change-apply delta (Task 4-b) ───────────────────── */

/** Uppercase kebab slug of the change title (truncated) for config lines. */
function changeSlug(title: string): string {
  return (
    title
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "CONFIG-UPDATE"
  );
}

/**
 * Append a vendor-appropriate change record + one realistic config line
 * derived from the change title. Cisco/AOS-CX flavors also get a
 * `description <slug>` line under the first interface (the only real
 * config delta — comments are stripped by normalization, so the applied
 * change shows up in the Phase 3 diff engine as exactly that line).
 */
function applyChangeDelta(rawText: string, flavor: string, changeTitle: string): string {
  const slug = changeSlug(changeTitle);
  const hashStyle = flavor === "cisco-ios" || flavor === "aos-cx" ? "!" : "#";
  const lines = rawText.replace(/\s+$/, "").split(/\r?\n/);

  if (hashStyle === "!") {
    const interfaceIndex = lines.findIndex((line) => /^interface /i.test(line));
    if (interfaceIndex >= 0) {
      lines.splice(interfaceIndex + 1, 0, ` description ${slug}`);
    }
  }

  const block = [
    hashStyle,
    `${hashStyle} Change application record — FayaNMS change engine`,
    `${hashStyle} applied by CHG: ${changeTitle.slice(0, 120)}`,
    `${hashStyle} change-slug: ${slug}`,
    hashStyle,
  ];
  return `${lines.join("\n")}\n${block.join("\n")}\n`;
}

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

/* ───────────── process-level guards (Task 10-a) ───────────── */

/**
 * Contain, never exit (Task 10-a): a rejected async job/report path or an
 * unexpected throw must not kill the HTTP surface — /health keeps answering
 * so the orchestrator can observe the worker (and its backoff state).
 */
process.on("unhandledRejection", (reason: unknown) => {
  const text =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  void log(`unhandled rejection (contained): ${text}`);
});

// Contained on purpose for this simulator service: log and keep serving.
process.on("uncaughtException", (error: Error) => {
  void log(
    `uncaught exception (contained): ${(error as Error)?.stack ?? String(error)}`
  );
});
