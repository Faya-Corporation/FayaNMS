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
 *                              SAFE-001: LIVE probes carry the enrolled
 *                              host-key pin (sshHostKeyPin.fingerprint,
 *                              enforced pre-auth); an UNPINNED live probe is
 *                              refused (SSH_HOSTKEY_UNENROLLED, 400) unless
 *                              enrollHostKey=true — the audited enrollment
 *                              capture that answers with the presented
 *                              hostKey { keyType, fingerprint }.
 *   POST /simulate/generate-config → vendor-flavored config text (Task 4-b
 *                              change engine pre/post backups)
 *   POST /simulate/apply      → config text with a change-flavored delta
 *                              (Task 4-b apply step; HTTP 500 when the demo
 *                              control payload.failAt === "APPLY")
 *   POST /simulate/restore    → SAFE-008: typed snapshot-exact restore
 *                              COMMIT on the simulator plane — verifies
 *                              sha256(configText) === body.expectedSha256
 *                              BEFORE committing (409 SHA_MISMATCH) and
 *                              echoes the committed bytes; HTTP 500 on the
 *                              demo control payload.failAt === "APPLY"
 *   POST /live/fetch-config   → Phase 23: REAL SSH config collection for a
 *                              LIVE_SSH device (the change engine's BACKUP
 *                              and VALIDATE steps); same read-only exec
 *                              surface as the Phase 22 adapters. SAFE-001:
 *                              the pinned host key is REQUIRED (fail-closed
 *                              SSH_HOSTKEY_UNENROLLED without it).
 *   POST /live/apply          → Phase 23 CONTROLLED change on a live
 *                              device: the body carries a validated PLAN
 *                              ({ kind, anchor, slug }) — never commands.
 *                              The worker builds the command list itself
 *                              (live-change.ts + change-commands.ts) and
 *                              drives a bounded PTY CLI session
 *                              (sshCliSession) with stop-on-first-rejection.
 *                              SAFE-001: the pinned host key is REQUIRED —
 *                              a controlled change to an endpoint whose key
 *                              does not match the enrollment dies in the
 *                              handshake (SSH_HOSTKEY_MISMATCH), before the
 *                              first command is built.
 *   POST /live/detect-vendor  → R50 vendor auto-detection for first contact
 *                              and inventory hygiene: execs ONLY the
 *                              read-only DETECT_COMMANDS (vendor-fingerprint.ts)
 *                              over the real SSH transport and attributes the
 *                              output to a certified vendor family (parse-
 *                              VendorFingerprint). SAFE-001: pinned → fail-
 *                              closed (mismatch dies pre-auth); unpinned is
 *                              refused (SSH_HOSTKEY_UNENROLLED) UNLESS
 *                              enrollHostKey=true — the audited first-contact
 *                              capture that answers with the presented
 *                              hostKey { keyType, fingerprint } for
 *                              enrollment after out-of-band verification.
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

import { createHash, timingSafeEqual } from "node:crypto";
import { adapters, pickAdapter, type DeviceTarget } from "./adapters";
import { LIVE_SSH_FLAVORS, LiveAdapterError, createLiveSshAdapter } from "./live-ssh";
import {
  guardDialTarget,
  HostKeyCaptureSignal,
  HostKeyPolicyError,
  parseHostKeyPin,
  parseTargetCredential,
  resolveAdapter,
  TargetPolicyError,
  type TargetCredential,
} from "./adapter-router";
import {
  applyLiveChangePlan,
  LIVE_CHANGE_FLAVORS,
  LiveChangeError,
  parseChangePlan,
} from "./live-change";
import { SshError, sshExecText, captureSshHostKey, type SshCredentials } from "./ssh-transport";
import {
  ANALYSIS_MAX_BYTES,
  DETECT_COMMANDS,
  isInformativeCliOutput,
  parseVendorFingerprint,
} from "./vendor-fingerprint";
import { resolveTargetForDial } from "./target-policy";
import { resolveVaultSecret, VaultError } from "./vault";
import { startRunner, getCounters } from "./runner";
import { startScheduler, getSchedulerState } from "./scheduler";
import { log } from "./next-client";
import { controlRejectResponse, verifyControlToken } from "./control-auth";
import { getProtocolCollectorMetrics, startProtocolCollector } from "./protocol-collector";

const PORT = 3030; // hardcoded — do not read PORT env (task 2-b contract)

/**
 * R50-T025 — the detection probe's TOTAL budget (resolution + every
 * candidate handshake + exec). The app plane aborts its worker fetch at
 * 30 s; this budget bounds the WORK even for callers without an abort
 * (per-command exec budgets still apply within it).
 */
const DETECT_TOTAL_BUDGET_MS =
  Number(process.env.FAYANMS_DETECT_TOTAL_BUDGET_MS) > 0
    ? Number(process.env.FAYANMS_DETECT_TOTAL_BUDGET_MS)
    : 45_000;
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

    if (req.method === "GET" && url.pathname === "/api/metrics") {
      const configuredToken = process.env.FAYANMS_METRICS_TOKEN?.trim() ?? "";
      if (configuredToken.length > 0) {
        const supplied = req.headers.get("authorization") ?? "";
        // RT-025 / F-040 — constant-time compare (mirrors RT-009 on the app
        // /api/metrics route): length-check first because timingSafeEqual
        // throws on a length mismatch. The unset-token OPEN behavior is
        // UNCHANGED here (fail-closed is a deployment-policy decision
        // tracked in BACKLOG under A2-08 — do not silently change reachability).
        const expected = Buffer.from(`Bearer ${configuredToken}`, "utf8");
        const suppliedBuf = Buffer.from(supplied, "utf8");
        const tokenOk =
          suppliedBuf.length === expected.length && timingSafeEqual(suppliedBuf, expected);
        if (!tokenOk) {
          return new Response("Unauthorized\n", {
            status: 401,
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }
      }

      const counters = getCounters();
      const scheduler = getSchedulerState();
      const protocol = getProtocolCollectorMetrics();
      const metricLines = [
        "# HELP fayanms_worker_process_uptime_seconds Worker process uptime in seconds.",
        "# TYPE fayanms_worker_process_uptime_seconds gauge",
        `fayanms_worker_process_uptime_seconds ${((Date.now() - STARTED_AT) / 1000).toFixed(3)}`,
        "# HELP fayanms_worker_jobs_total Worker jobs by lifecycle state.",
        "# TYPE fayanms_worker_jobs_total counter",
        `fayanms_worker_jobs_total{state="claimed"} ${counters.claimed}`,
        `fayanms_worker_jobs_total{state="running"} ${counters.running}`,
        `fayanms_worker_jobs_total{state="completed"} ${counters.completed}`,
        `fayanms_worker_jobs_total{state="failed"} ${counters.failed}`,
        "# HELP fayanms_worker_scheduler_up Whether the scheduler has no consecutive failures.",
        "# TYPE fayanms_worker_scheduler_up gauge",
        `fayanms_worker_scheduler_up ${scheduler.consecutiveTickFailures === 0 ? 1 : 0}`,
        "# HELP fayanms_worker_claim_backoff_seconds Current claim retry backoff.",
        "# TYPE fayanms_worker_claim_backoff_seconds gauge",
        `fayanms_worker_claim_backoff_seconds ${(counters.currentBackoffMs / 1000).toFixed(3)}`,
        "# HELP fayanms_worker_protocol_packets_total Protocol packets received by the optional worker collector.",
        "# TYPE fayanms_worker_protocol_packets_total counter",
        `fayanms_worker_protocol_packets_total{state="received"} ${protocol.packetsReceived}`,
        `fayanms_worker_protocol_packets_total{state="accepted"} ${protocol.packetsAccepted}`,
        `fayanms_worker_protocol_packets_total{state="rejected"} ${protocol.packetsRejected}`,
        `fayanms_worker_protocol_packets_total{state="queue_dropped"} ${protocol.queueDrops}`,
        `fayanms_worker_protocol_relay_failures_total ${protocol.relayFailures}`,
        `fayanms_worker_protocol_collector_up ${protocol.enabled ? 1 : 0}`,
      ];

      return new Response(`${metricLines.join("\n")}\n`, {
        status: 200,
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        },
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
            error: "Body must be { vendor: string, host: string, hostname?: string, dataSource?: \"SIMULATOR\"|\"LIVE_SSH\", credential?: { username, port, secretRef }, sshHostKeyPin?: { fingerprint }, enrollHostKey?: boolean }",
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
      // SAFE-001 — host-key policy. The pin is validated up front (malformed
      // → 400, never ignored); enrollment mode is honored ONLY on this probe
      // endpoint and only for LIVE_SSH targets.
      let enrollmentMode = false;
      let hostKeyPin: string | null = null;
      try {
        hostKeyPin = parseHostKeyPin(body?.sshHostKeyPin ?? null);
        enrollmentMode = dataSource === "LIVE_SSH" && body?.enrollHostKey === true;
      } catch (e) {
        if (e instanceof HostKeyPolicyError) {
          return Response.json(
            { ok: false, vendor, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        throw e;
      }
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
        const adapter = await resolveAdapter(target, credential, { hostKeyPin, enrollmentMode });
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
        // R61 P0 — the credential-free first-contact capture is a SUCCESS
        // outcome, not an error: the presented key travels back for the
        // operator's out-of-band verification (same answer shape as the
        // pre-R61 enrollment probe; the difference is that NO credential
        // was ever resolved from the vault and NO authentication was ever
        // attempted — the handshake aborts during key exchange).
        if (e instanceof HostKeyCaptureSignal) {
          return Response.json({
            ok: true,
            vendor,
            host,
            adapter:
              dataSource === "LIVE_SSH"
                ? LIVE_SSH_FLAVORS[vendor.trim().toLowerCase()]?.adapter
                : undefined,
            dataSource,
            latencyMs: e.capture.latencyMs,
            banner: e.capture.banner,
            negotiated: "ssh2 (pre-auth host-key capture — credential-free)",
            hostKey: { keyType: e.capture.keyType, fingerprint: e.capture.fingerprint },
          });
        }
        // Failure semantics (Phase 22 slice 1 + SAFE-001 + R51-A1):
        //   VaultError / HostKeyPolicyError / TargetPolicyError =
        //     request/credential/policy problem (NO connection was ever
        //     attempted) → 400 bad request;
        //   SshError / LiveAdapterError = the probe really failed against the
        //     device/transport → 200 ok:false so the test-connection UI
        //     renders the actionable reason instead of a generic 500.
        if (
          e instanceof VaultError ||
          e instanceof HostKeyPolicyError ||
          e instanceof TargetPolicyError
        ) {
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

    if (req.method === "POST" && url.pathname === "/simulate/restore") {
      // SAFE-008 — typed snapshot-exact restore commit on the SIMULATOR data
      // plane. The change engine pushes the APPROVED snapshot's raw text and
      // its sha256; this route verifies the digest BEFORE committing and
      // echoes the committed bytes (the engine records them as the job's
      // POST_CHANGE snapshot and re-asserts the echo — SAFE-009). Deliberate
      // contrast with the LIVE plane: this is a simulator persona (stateless
      // config generation), not real hardware — full-config pushes against
      // real devices remain refused engine-side (LIVE_RESTORE_NOT_CERTIFIED).
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
      const configText = typeof body?.configText === "string" ? body.configText : "";
      const expectedSha256 =
        typeof body?.expectedSha256 === "string" ? body.expectedSha256.trim().toLowerCase() : "";
      const failAt = typeof body?.failAt === "string" ? body.failAt.trim() : null;
      if (!hostname || !configText || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return Response.json(
          { ok: false, error: "Body must be { hostname: string, flavor?: string, configText: string, expectedSha256: string(64-hex), failAt?: string }" },
          { status: 400 }
        );
      }
      // Mirrors /simulate/apply's demo control — a demo restore can exercise
      // the rollback path without faulting anything.
      if (failAt === "APPLY") {
        return Response.json(
          {
            ok: false,
            error: `Simulated restore failure on ${hostname} — commit aborted (demo control failAt=APPLY)`,
          },
          { status: 500 }
        );
      }
      // Size bound + control-character sanity (defensive mirrors of the
      // app-side restore-op contract; the engine checks its copy too).
      const byteLength = Buffer.byteLength(configText, "utf8");
      if (byteLength > 262_144 || configText.includes("\u0000")) {
        return Response.json(
          { ok: false, error: "configText out of bounds (≤ 256 KiB, no NUL bytes)" },
          { status: 400 }
        );
      }
      // Integrity gate — commit EXACTLY the approved bytes or nothing.
      const actualSha256 = createHash("sha256").update(configText, "utf8").digest("hex");
      if (actualSha256 !== expectedSha256) {
        return Response.json(
          {
            ok: false,
            error: `SHA_MISMATCH — refusing to commit: body digest ${actualSha256} does not equal the approved snapshot digest`,
          },
          { status: 409 }
        );
      }
      return Response.json({
        ok: true,
        configText,
        sha256: actualSha256,
        bytes: byteLength,
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
      let hostKeyPin: string | null = null;
      try {
        const parsed = parseTargetCredential(body?.credential ?? null);
        if (!parsed) {
          throw new VaultError(
            "CREDENTIAL_REF_INVALID",
            "credential block { username, port, secretRef } is required",
          );
        }
        credential = parsed;
        // SAFE-001 — config collection is PINNED or refused (fail-closed;
        // no enrollment escape hatch on the job/change planes).
        hostKeyPin = parseHostKeyPin(body?.sshHostKeyPin ?? null);
        if (!hostKeyPin) {
          throw new HostKeyPolicyError(
            "SSH_HOSTKEY_UNENROLLED",
            `no pinned SSH host key for ${host}:${credential.port} — live config collection is refused (fail-closed). Enroll the host key from the device page first.`,
          );
        }
      } catch (e) {
        if (e instanceof VaultError || e instanceof HostKeyPolicyError) {
          return Response.json(
            { ok: false, vendor, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        throw e;
      }
      const target: DeviceTarget = {
        deviceId: typeof body?.deviceId === "string" ? body.deviceId : "live-fetch",
        hostname,
        vendor,
        managementIp: host,
        dataSource: "LIVE_SSH",
      };
      try {
        // R51-A1 — the resolved-address target policy governs this dial
        // plane too (it previously covered only the detection probe):
        // a governed address class is refused BEFORE any credential or
        // connection work, and the validated address is dialed verbatim.
        const dialHost = await guardDialTarget(host);
        const password = await resolveVaultSecret(credential.secretRef);
        const adapter = createLiveSshAdapter(vendor, {
          host: dialHost,
          port: credential.port,
          username: credential.username,
          password,
          expectedFingerprint: hostKeyPin,
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
        // LiveAdapterError / TargetPolicyError = request problem → 400 (no
        // connection made); SshError = the collection really failed → 200
        // ok:false.
        if (
          e instanceof VaultError ||
          e instanceof LiveAdapterError ||
          e instanceof TargetPolicyError
        ) {
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

    if (req.method === "POST" && url.pathname === "/live/detect-vendor") {
      // R50 — vendor auto-detection. ONE read-only probe per candidate
      // (DETECT_COMMANDS, vendor-fingerprint.ts — the complete allowlist);
      // the first informative output is attributed to a certified vendor
      // family. Credential block carries the vault REFERENCE only.
      let body: Record<string, unknown> | undefined;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { ok: false, error: "Request body must be valid JSON" },
          { status: 400 }
        );
      }
      const host = typeof body?.host === "string" ? body.host.trim() : "";
      if (!host) {
        return Response.json(
          { ok: false, error: "Body must be { host: string, credential: { username, port, secretRef }, sshHostKeyPin?: string, enrollHostKey?: boolean }" },
          { status: 400 }
        );
      }
      let credential: TargetCredential;
      let hostKeyPin: string | null = null;
      let enrollmentMode = false;
      try {
        const parsed = parseTargetCredential(body?.credential ?? null);
        if (!parsed) {
          throw new VaultError(
            "CREDENTIAL_REF_INVALID",
            "credential block { username, port, secretRef } is required",
          );
        }
        credential = parsed;
        // SAFE-001 — same host-key policy class as every other /live/*
        // surface: pinned = verified pre-auth (mismatch dies in the
        // handshake); unpinned = refused UNLESS the caller explicitly opts
        // into the first-contact capture (enrollHostKey=true) — the ONLY
        // unpinned mode on this endpoint, mirroring /simulate/connect.
        hostKeyPin = parseHostKeyPin(body?.sshHostKeyPin ?? null);
        enrollmentMode = body?.enrollHostKey === true;
        if (!hostKeyPin && !enrollmentMode) {
          throw new HostKeyPolicyError(
            "SSH_HOSTKEY_UNENROLLED",
            `no pinned SSH host key for ${host}:${credential.port} — vendor detection is refused (fail-closed). Enroll the host key first, or pass enrollHostKey=true for the audited first-contact capture.`,
          );
        }
      } catch (e) {
        if (e instanceof VaultError || e instanceof HostKeyPolicyError) {
          return Response.json(
            { ok: false, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        throw e;
      }
      try {
        // R50-T025: the probe clock starts here — the total budget covers
        // resolution, handshakes and execs (the app plane aborts earlier
        // at 30 s; this is the worker-side bound).
        const startedAt = Date.now();
        // R50-T022 follow-up — RESOLVED-ADDRESS target policy (the worker
        // never trusts the app plane): literals classify with no I/O;
        // hostnames resolve under the R50-T025 budget and EVERY candidate
        // address must pass the policy (fail-closed across the RRset).
        // The probe then dials the VALIDATED address — no second lookup,
        // so the resolve-then-dial rebinding window is structurally gone.
        // R61 P0: the dial policy runs BEFORE the vault — a policy refusal
        // never even reads a secret.
        const dial = await resolveTargetForDial(host);
        if (!dial.decision.ok) {
          return Response.json(
            {
              ok: false,
              host,
              error: `${dial.decision.code}: ${dial.decision.detail}`,
            },
            { status: 400 },
          );
        }
        // R61 P0 — credential-free first-contact capture. When the caller
        // explicitly opts into enrollment (enrollHostKey=true, no pin),
        // the worker captures the presented host key with ZERO vault
        // access and ZERO authentication (the capture connection carries
        // no credential material and aborts during key exchange), then
        // answers with the key and DEFERS detection: the operator verifies
        // the fingerprint out-of-band, pins it, and re-runs detection —
        // the re-run rides the pinned path (verified pre-auth).
        if (enrollmentMode && !hostKeyPin) {
          const remaining = Math.max(0, DETECT_TOTAL_BUDGET_MS - (Date.now() - startedAt));
          const capture = await captureSshHostKey(
            { host: dial.decision.dialedAddress, port: credential.port },
            remaining || 1,
          );
          return Response.json({
            ok: true,
            host,
            negotiated: "ssh2 (pre-auth host-key capture — credential-free)",
            latencyMs: capture.latencyMs,
            banner: capture.banner,
            hostKey: { keyType: capture.keyType, fingerprint: capture.fingerprint },
            detectionDeferred: true,
          });
        }
        // Credentialed detection — structurally AFTER the enrollment branch
        // (enrollment mode can never reach this line with real secrets).
        const password = await resolveVaultSecret(credential.secretRef);
        const creds: SshCredentials = {
          host: dial.decision.dialedAddress,
          port: credential.port,
          username: credential.username,
          password,
          expectedFingerprint: hostKeyPin,
        };
        let output: string | null = null;
        let usedCommand: string | null = null;
        let lastError: string | null = null;
        for (const command of DETECT_COMMANDS) {
          // R50-T025: the candidate loop honors the total budget — an
          // exhausted budget aborts BEFORE the next handshake (the
          // in-flight exec is bounded by its own per-command timeout).
          if (Date.now() - startedAt > DETECT_TOTAL_BUDGET_MS) {
            lastError = `SSH_TIMEOUT: detection total budget (${DETECT_TOTAL_BUDGET_MS} ms) exceeded before "${command}"`;
            break;
          }
          try {
            // R50-T025: per-command exec timeout (15 s) + the per-stream
            // output cap pinned to the analysis budget (256 KiB).
            const out = await sshExecText(creds, command, 15000, ANALYSIS_MAX_BYTES);
            // R50.5 (R50-T050): a SHORT CLI-rejection answer ("% Invalid
            // input detected…", often with exit 0) is NOT informative —
            // keep walking the allowlist so the probe reaches the command
            // this CLI actually answers (FortiOS/PAN-OS answer probe #2/#3).
            if (isInformativeCliOutput(out)) {
              output = out;
              usedCommand = command;
              break;
            }
            // Empty stdout: this CLI does not speak the command — try the
            // next read-only candidate (same connection would be nicer, but
            // the exec-channel transport is one-command-per-connection by
            // design; at most DETECT_COMMANDS.length handshakes).
          } catch (e) {
            if (e instanceof SshError) {
              lastError = `${e.code}: ${e.message}`;
              // Command-level rejection (EXEC_FAILED) → the CLI exists but
              // does not know this command — try the next candidate.
              // Connect/auth/policy-level failures (AUTH/UNREACHABLE/
              // TIMEOUT/HOSTKEY_MISMATCH/SESSION) abort immediately: the
              // target is not speaking SSH to us at all.
              if (e.code !== "SSH_EXEC_FAILED") break;
              continue;
            }
            throw e;
          }
        }
        if (output === null) {
          return Response.json({
            ok: false,
            host,
            error:
              lastError ??
              "DETECT_NO_OUTPUT: no read-only probe produced output (does the CLI answer any of: " +
                DETECT_COMMANDS.join(", ") +
                "?)",
          });
        }
        const detection = parseVendorFingerprint(output);
        return Response.json({
          ok: true,
          host,
          // R50-T022 follow-up evidence: the validated address actually
          // dialed + the policy decision (the app plane records it in the
          // audit trail). Additive fields — older callers ignore them.
          dialedAddress: dial.decision.dialedAddress,
          targetPolicy: {
            checked: dial.decision.checked,
            addressClass: dial.decision.addressClass,
          },
          command: usedCommand,
          latencyMs: Date.now() - startedAt,
          detection,
          // R61 P0: the credentialed detect path no longer captures host
          // keys — first-contact capture is the separate credential-free
          // branch above (detectionDeferred). A pinned credentialed probe
          // answers no hostKey field.
        });
      } catch (e) {
        // Same failure contract as /live/fetch-config: VaultError = request
        // problem (no connection attempted) → 400; SshError → 200 ok:false.
        if (e instanceof VaultError) {
          return Response.json(
            { ok: false, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        if (e instanceof SshError) {
          return Response.json({
            ok: false,
            host,
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
      let hostKeyPin: string | null = null;
      try {
        const parsed = parseTargetCredential(body?.credential ?? null);
        if (!parsed) {
          throw new VaultError(
            "CREDENTIAL_REF_INVALID",
            "credential block { username, port, secretRef } is required",
          );
        }
        credential = parsed;
        // SAFE-001 — controlled changes are PINNED or refused (fail-closed;
        // no enrollment escape hatch on the job/change planes).
        hostKeyPin = parseHostKeyPin(body?.sshHostKeyPin ?? null);
        if (!hostKeyPin) {
          throw new HostKeyPolicyError(
            "SSH_HOSTKEY_UNENROLLED",
            `no pinned SSH host key for ${host}:${credential.port} — controlled changes are refused (fail-closed). Enroll the host key from the device page first.`,
          );
        }
      } catch (e) {
        if (e instanceof VaultError || e instanceof HostKeyPolicyError) {
          return Response.json(
            { ok: false, vendor, host, error: `${e.code}: ${e.message}` },
            { status: 400 }
          );
        }
        throw e;
      }
      try {
        // R51-A1 — controlled changes are governed by the resolved-address
        // target policy BEFORE any plan/vault work: a governed address
        // class never reaches a credential resolution, and the validated
        // address (not the payload literal) is what gets dialed.
        const dialHost = await guardDialTarget(host);
        const plan = parseChangePlan(body?.plan ?? null);
        const password = await resolveVaultSecret(credential.secretRef);
        const result = await applyLiveChangePlan(vendor, {
          host: dialHost,
          port: credential.port,
          username: credential.username,
          password,
          expectedFingerprint: hostKeyPin,
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
          e instanceof LiveAdapterError ||
          e instanceof TargetPolicyError
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
  // TASK-SVC-001-A §12: fail FAST on missing/malformed/self-contradictory
  // service identity — before the port opens, never at first request.
  // (certify.ts imports only handle() below, so harness runs are unaffected;
  // its legacy shared-secret shape is a valid boot configuration.)
  const { assertWorkerServiceIdentity, warnWorkerSecretScope } = await import(
    "./identity-boot"
  );
  assertWorkerServiceIdentity();
  // SEC-ENV-001 deprecation path: out-of-zone secret material in the worker
  // env still boots, but it is flagged by name (values are never printed).
  // After the documented deprecation window this becomes a boot refusal —
  // the worker must never receive app-session/KEK/PostgreSQL material.
  warnWorkerSecretScope();

  const server = Bun.serve({ port: PORT, fetch: (req) => handle(req) });
  log(`fayanms-worker v0.1.0 listening on :${server.port}`);
  startRunner();
  startScheduler();
  const protocolCollector = startProtocolCollector();

  process.on("SIGTERM", () => {
    log("SIGTERM received — shutting down");
    protocolCollector?.stop();
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("SIGINT received — shutting down");
    protocolCollector?.stop();
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
