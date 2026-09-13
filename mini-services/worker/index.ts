/// <reference types="bun-types" />
/**
 * FayaNMS worker mini-service — entry point (bun; single runtime dependency:
 * ssh2 — the real-transport LIVE_SSH plane, Phase 22 slice 1).
 *
 * HTTP surface on port 3030 (hardcoded per Task 2-b; the gateway only exposes
 * 3000 — this service is backend-to-backend):
 *   GET  /health          → liveness + in-memory job counters + adapter names
 *   GET  /capabilities    → adapter capability manifests (simulator + live)
 *   POST /simulate/connect   → device connect probe. dataSource routing
 *                              (Phase 22 slice 1): SIMULATOR (default) uses
 *                              the in-memory adapters; LIVE_SSH performs a
 *                              REAL SSH probe (exec-only, read-only) using a
 *                              credential BLOCK { username, port, secretRef }
 *                              — the secret itself NEVER travels; the worker
 *                              resolves the vault reference worker-side.
 *   POST /simulate/generate-config → vendor-flavored config text (Task 4-b
 *                              change engine pre/post backups)
 *   POST /simulate/apply      → config text with a change-flavored delta
 *                              (Task 4-b apply step; HTTP 500 when the demo
 *                              control payload.failAt === "APPLY")
 *   POST /live/fetch-config   → Phase 23: REAL SSH config collection for a
 *                              LIVE_SSH device (the change engine's BACKUP
 *                              and VALIDATE steps); same read-only exec
 *                              surface as the Phase 22 adapters.
 *   POST /live/apply          → Phase 23 CONTROLLED change on a live
 *                              device: the body carries a validated PLAN
 *                              ({ kind, anchor, slug }) — never commands.
 *                              The worker builds the command list itself
 *                              (live-change.ts + change-commands.ts) and
 *                              drives a bounded PTY CLI session
 *                              (sshCliSession) with stop-on-first-rejection.
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
 * This service never touches the database; all persistence flows through
 * NEXT_BASE_URL (runbook T5; the http://localhost:3000 default preserves the
 * same-host loopback contract).
 */

import { adapters, pickAdapter, type DeviceTarget } from "./adapters";
import { LIVE_SSH_FLAVORS, LiveAdapterError, createLiveSshAdapter } from "./live-ssh";
import { parseTargetCredential, resolveAdapter, type TargetCredential } from "./adapter-router";
import {
  applyLiveChangePlan,
  LIVE_CHANGE_FLAVORS,
  LiveChangeError,
  parseChangePlan,
} from "./live-change";
import { SshError } from "./ssh-transport";
import { resolveVaultSecret, VaultError } from "./vault";
import { startRunner, getCounters } from "./runner";
import { startScheduler, getSchedulerState } from "./scheduler";
import { log } from "./next-client";
import { controlRejectResponse, verifyControlToken } from "./control-auth";

const PORT = 3030; // hardcoded — do not read PORT env (task 2-b contract)
const STARTED_AT = Date.now();

/**
 * Exported for the LIVE_SSH certification driver (certify.ts) — the driver
 * imports this module with import.meta.main === false, so the server bind
 * and the background loops below do NOT run in that path.
 */
export async function handle(req: Request): Promise<Response> {
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
        liveAdapters: Object.values(LIVE_SSH_FLAVORS).map((f) => f.adapter),
      });
    }

    if (req.method === "GET" && url.pathname === "/capabilities") {
      // Phase 19-C (audit GATEWAY-101): the adapter manifest is privileged
      // architecture disclosure — control-plane token required.
      const auth = verifyControlToken(req);
      if (!auth.ok) return controlRejectResponse(auth);
      return Response.json([
        ...adapters.map((a) => ({
          vendor: a.vendor,
          adapter: a.adapter,
          capabilities: a.capabilities,
          configFlavor: a.configFlavor,
          notes: a.notes,
        })),
        // LIVE manifest derived from the certified-flavor registry — no
        // hardcoded vendor list to drift out of sync (Phase 22 slice 2).
        // Phase 23: flavors registered in the controlled-change plane carry
        // the apply_config capability (plan-validated, description-level).
        ...Object.entries(LIVE_SSH_FLAVORS).map(([vendor, flavor]) => ({
          vendor,
          adapter: flavor.adapter,
          capabilities:
            LIVE_CHANGE_FLAVORS[vendor]
              ? ["connect", "backup_config", "apply_config"]
              : ["connect", "backup_config"],
          configFlavor: flavor.configFlavor,
          notes: `LIVE SSH transport (Phase 22${LIVE_CHANGE_FLAVORS[vendor] ? " + controlled change Phase 23" : ""}): ${flavor.notes} Hardware certification pending.`,
        })),
      ]);
    }

    // Phase 19-C (audit GATEWAY-101): every /simulate/* mutation requires a
    // control-plane service JWT with the "simulate" scope. The sandbox
    // gateway can reach :3030, so anonymous simulator control is closed.
    // Since Phase 22 slice 1 this gate is ALSO the direct device-control
    // gate: a LIVE_SSH probe body makes /simulate/connect open a REAL SSH
    // connection (read-only) — the JWT requirement covers both planes.
    // Phase 23: the "simulate" scope is the DEVICE-CONTROL scope — the
    // /live/* endpoints (real config collection + controlled changes)
    // require exactly the same token class.
    if (url.pathname.startsWith("/simulate/") || url.pathname.startsWith("/live/")) {
      const auth = verifyControlToken(req, "simulate");
      if (!auth.ok) return controlRejectResponse(auth);
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
            error: "Body must be { vendor: string, host: string, hostname?: string, dataSource?: \"SIMULATOR\"|\"LIVE_SSH\", credential?: { username, port, secretRef } }",
          },
          { status: 400 }
        );
      }

      // Phase 22 slice 1 — dataSource routing. The credential block carries
      // the vault REFERENCE only (username/port/secretRef); the secret is
      // resolved worker-side at connection time. Incomplete LIVE_SSH
      // requests are rejected BEFORE any connection attempt.
      const dataSource =
        typeof body?.dataSource === "string" && body.dataSource.trim()
          ? body.dataSource.trim().toUpperCase()
          : "SIMULATOR";
      let credential: TargetCredential | null = null;
      if (dataSource === "LIVE_SSH") {
        try {
          credential = parseTargetCredential(body?.credential ?? null);
        } catch (e) {
          return Response.json(
            { ok: false, vendor, host, error: (e as Error).message },
            { status: 400 }
          );
        }
      }

      const target: DeviceTarget = {
        deviceId: typeof body?.deviceId === "string" ? body.deviceId : "manual-test",
        hostname,
        vendor,
        managementIp: host,
        dataSource,
      };
      try {
        const adapter = resolveAdapter(target, credential);
        const conn = await adapter.connect(target);
        return Response.json({
          ok: true,
          vendor,
          host,
          adapter: adapter.adapter,
          dataSource,
          latencyMs: conn.latencyMs,
          banner: conn.banner,
          negotiated: conn.negotiated,
        });
      } catch (e) {
        // Failure semantics (Phase 22 slice 1):
        //   VaultError = request/credential problem (NO connection was ever
        //     attempted) → 400 bad request;
        //   SshError / LiveAdapterError = the probe really failed against the
        //     device/transport → 200 ok:false so the test-connection UI
        //     renders the actionable reason instead of a generic 500.
        if (e instanceof VaultError) {
          return Response.json(
            { ok: false, vendor, host, dataSource, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        if (e instanceof SshError || e instanceof LiveAdapterError) {
          return Response.json({
            ok: false,
            vendor,
            host,
            adapter:
              dataSource === "LIVE_SSH"
                ? LIVE_SSH_FLAVORS[vendor.trim().toLowerCase()]?.adapter
                : undefined,
            dataSource,
            error: `${e.code}: ${e.message}`,
          });
        }
        throw e;
      }
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

    if (req.method === "POST" && url.pathname === "/live/fetch-config") {
      // Phase 23 — REAL config collection for the change engine's BACKUP /
      // VALIDATE steps (same read-only exec surface as the Phase 22
      // adapters, over a credential block that carries the vault REFERENCE
      // only).
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
          { ok: false, error: "Body must be { vendor: string, host: string, hostname?: string, credential: { username, port, secretRef } }" },
          { status: 400 }
        );
      }
      let credential: TargetCredential;
      try {
        const parsed = parseTargetCredential(body?.credential ?? null);
        if (!parsed) {
          throw new VaultError(
            "CREDENTIAL_REF_INVALID",
            "credential block { username, port, secretRef } is required",
          );
        }
        credential = parsed;
      } catch (e) {
        return Response.json(
          { ok: false, vendor, host, error: (e as Error).message },
          { status: 400 }
        );
      }
      const target: DeviceTarget = {
        deviceId: typeof body?.deviceId === "string" ? body.deviceId : "live-fetch",
        hostname,
        vendor,
        managementIp: host,
        dataSource: "LIVE_SSH",
      };
      try {
        const password = resolveVaultSecret(credential.secretRef);
        const adapter = createLiveSshAdapter(vendor, {
          host,
          port: credential.port,
          username: credential.username,
          password,
        });
        const config = await adapter.fetchConfig(target);
        return Response.json({
          ok: true,
          vendor,
          host,
          adapter: adapter.adapter,
          configFlavor: adapter.configFlavor,
          configText: config.rawText,
          normalizedText: config.normalizedText,
          bytes: new TextEncoder().encode(config.rawText).length,
        });
      } catch (e) {
        // Failure semantics identical to /simulate/connect: VaultError /
        // LiveAdapterError = request problem → 400 (no connection made);
        // SshError = the collection really failed → 200 ok:false.
        if (e instanceof VaultError || e instanceof LiveAdapterError) {
          return Response.json(
            { ok: false, vendor, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        if (e instanceof SshError) {
          return Response.json({
            ok: false,
            vendor,
            host,
            adapter: LIVE_SSH_FLAVORS[vendor.trim().toLowerCase()]?.adapter,
            error: `${e.code}: ${e.message}`,
          });
        }
        throw e;
      }
    }

    if (req.method === "POST" && url.pathname === "/live/apply") {
      // Phase 23 — CONTROLLED change on a live device. The body carries a
      // validated PLAN (kind/anchor/slug tokens), never command text: the
      // worker builds the command list itself and drives a bounded PTY CLI
      // session. Every rejection below happens BEFORE any connection is
      // opened (plan/vault/flavor), or as a typed transport failure.
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
          { ok: false, error: "Body must be { vendor, host, hostname?, credential, plan: { kind: \"APPLY\"|\"ROLLBACK\", anchor, slug } }" },
          { status: 400 }
        );
      }
      let credential: TargetCredential;
      try {
        const parsed = parseTargetCredential(body?.credential ?? null);
        if (!parsed) {
          throw new VaultError(
            "CREDENTIAL_REF_INVALID",
            "credential block { username, port, secretRef } is required",
          );
        }
        credential = parsed;
      } catch (e) {
        return Response.json(
          { ok: false, vendor, host, error: (e as Error).message },
          { status: 400 }
        );
      }
      try {
        const plan = parseChangePlan(body?.plan ?? null);
        const password = resolveVaultSecret(credential.secretRef);
        const result = await applyLiveChangePlan(vendor, {
          host,
          port: credential.port,
          username: credential.username,
          password,
        }, plan);
        return Response.json({
          ok: true,
          vendor,
          host,
          hostname,
          adapter: result.adapter,
          configFlavor: result.configFlavor,
          plan: result.plan,
          commands: result.commands,
          results: result.results,
          applied: result.applied,
        });
      } catch (e) {
        if (
          e instanceof VaultError ||
          e instanceof LiveChangeError ||
          e instanceof LiveAdapterError
        ) {
          // Request-level problem — NOTHING reached the device.
          return Response.json(
            { ok: false, vendor, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        if (e instanceof SshError) {
          // Real transport/session failure against the device.
          return Response.json({
            ok: false,
            vendor,
            host,
            adapter: LIVE_CHANGE_FLAVORS[vendor.trim().toLowerCase()]?.adapter,
            error: `${e.code}: ${e.message}`,
          });
        }
        throw e;
      }
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

if (import.meta.main) {
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
}
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
