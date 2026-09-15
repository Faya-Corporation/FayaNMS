/**
 * FayaNMS — public demo device fleet probe (TASK-DEMO-FLEET-001, READ-ONLY).
 *
 * Purpose: the zero-cost real-device evidence plane for CERT-HW-001. The
 * certification matrix (docs/certification/MATRIX.md) is honestly blocked at
 * T2/T1 (no hardware in the sandbox); this tool classifies and — when an
 * operator supplies their own free DevNet AAA credentials — executes the
 * FIRST real-device auth/read evidence run (public-demo tier, NOT T3).
 *
 * Stages
 *   1. TCP preflight (default)  — DNS + TCP connect + latency against every
 *      catalog entry. No authentication, no commands, no credentials.
 *   2. SSH stage (--ssh)        — requires FAYANMS_DEMO_SSH_* env (typed
 *      refusal BEFORE any network activity when missing). Performs the
 *      product's REAL sshProbe with host-key ENROLLMENT capture (SAFE-001:
 *      records the presented fingerprint, enforces nothing) and exactly ONE
 *      read-only `show version` exec.
 *   3. Backup stage (--backup)  — additionally runs the certified LIVE_SSH
 *      product adapter (`createLiveSshAdapter("cisco", …)` → fetchConfig →
 *      `show running-config`) so the evidence transcript comes from the SAME
 *      code path the product uses for real-device backups.
 *
 * READ-ONLY discipline (mirrors live-ssh.ts):
 *   - the transport is exec-only (ssh-transport.ts) — no shell channel in
 *     this script except through the product adapter's read path;
 *   - the only command literals in this file are `show version` and the
 *     certified flavor's `show running-config`;
 *   - public demo devices are SHARED infrastructure — mutation against them
 *     is out of scope forever (drift/change/rollback rows stay lab-only).
 *
 * Credential policy: credentials NEVER live in this repository. They are
 * read exclusively from the FAYANMS_DEMO_SSH_* environment (Cisco DevNet
 * issues per-user AAA credentials from a free account — the shared-password
 * era ended 2025-09-16, see docs/certification/PUBLIC-DEMO-DEVICES.md).
 *
 * Exit codes: 0 = report produced · 2 = typed refusal (missing env) ·
 * 3 = SSH stage failed (auth/unreachable/timeout — still an honest result).
 */

import { createConnection } from "node:net";
import {
  sshExecText,
  sshProbe,
  type SshCredentials,
} from "../mini-services/worker/ssh-transport";
import { createLiveSshAdapter } from "../mini-services/worker/live-ssh";

/* ───────────────────────────── catalog ───────────────────────────── */

export type CredentialModel = "devnet-aaa-per-user" | "none";

export interface PublicDemoDevice {
  id: string;
  label: string;
  host: string;
  port: number;
  /**
   * Certified LIVE_SSH flavor key (live-ssh.ts) — null means the device is
   * cataloged for reachability classification only and is NOT enrollable by
   * the product transports (claimed only at the tier actually evidenced).
   */
  liveSshFlavor: string | null;
  credentialModel: CredentialModel;
  /** where an operator obtains credentials (never a credential itself) */
  credentialSourceUrl: string;
  notes: string;
}

export const PUBLIC_DEMO_FLEET: PublicDemoDevice[] = [
  {
    id: "devnet-cat8000-iosxe",
    label: "Cisco DevNet Always-On Catalyst 8000 (IOS-XE)",
    host: "devnetsandboxiosxe.cisco.com",
    port: 22,
    liveSshFlavor: "cisco",
    credentialModel: "devnet-aaa-per-user",
    credentialSourceUrl: "https://developer.cisco.com/sandbox/",
    notes:
      "The one enrollable public SSH device today. Shared sandbox credentials were retired 2025-09-16 — Cisco now issues unique per-user AAA credentials from a free DevNet account. Enrollable via the cisco LIVE_SSH flavor (show running-config).",
  },
  {
    id: "devnet-nxos",
    label: "Cisco DevNet Always-On NX-OS",
    host: "sbx-nxos-mgmt.cisco.com",
    port: 22,
    // Honesty: NX-OS is NOT a certified LIVE_SSH flavor (live-ssh.ts certifies
    // IOS/IOS-XE classic CLI). Cataloged for reachability evidence only.
    liveSshFlavor: null,
    credentialModel: "devnet-aaa-per-user",
    credentialSourceUrl: "https://developer.cisco.com/sandbox/",
    notes:
      "Reachability-classification only — no certified FayaNMS flavor; DO NOT enroll until a flavor is certified against NX-OS.",
  },
];

/* ─────────────────────────── credentials ─────────────────────────── */

export const DEMO_SSH_ENV = {
  host: "FAYANMS_DEMO_SSH_HOST",
  port: "FAYANMS_DEMO_SSH_PORT",
  user: "FAYANMS_DEMO_SSH_USER",
  pass: "FAYANMS_DEMO_SSH_PASS",
} as const;

export interface DemoSshCreds {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type DemoCredsResolution =
  | { ok: true; creds: DemoSshCreds }
  | { ok: false; missing: string[] };

/**
 * Resolve the SSH stage credentials from the environment ONLY. Missing
 * variables are reported BY NAME; this module contains no defaults and no
 * credential material — a demo password in the repo would defeat the point.
 */
export function resolveDemoSshCreds(
  env: Record<string, string | undefined> = process.env,
): DemoCredsResolution {
  const missing: string[] = [];
  const host = (env[DEMO_SSH_ENV.host] ?? "").trim();
  const user = (env[DEMO_SSH_ENV.user] ?? "").trim();
  const pass = env[DEMO_SSH_ENV.pass] ?? "";
  if (!host) missing.push(DEMO_SSH_ENV.host);
  if (!user) missing.push(DEMO_SSH_ENV.user);
  if (!pass) missing.push(DEMO_SSH_ENV.pass);
  if (missing.length > 0) return { ok: false, missing };

  const rawPort = (env[DEMO_SSH_ENV.port] ?? "").trim();
  let port = 22;
  if (rawPort) {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { ok: false, missing: [`${DEMO_SSH_ENV.port} (must be an integer 1–65535, got "${rawPort}")`] };
    }
    port = parsed;
  }
  return { ok: true, creds: { host, port, username: user, password: pass } };
}

/* ────────────────────────── tcp preflight ────────────────────────── */

export interface TcpProbeResult {
  host: string;
  port: number;
  errorClass: "OPEN" | "REFUSED" | "TIMEOUT" | "DNS" | "ERROR";
  latencyMs: number | null;
  detail: string;
}

/** DNS + TCP connect + latency. No authentication, no payload. */
export function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (result: TcpProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => {
      done({ host, port, errorClass: "TIMEOUT", latencyMs: null, detail: `no connect within ${timeoutMs} ms` });
    });
    socket.on("connect", () => {
      done({ host, port, errorClass: "OPEN", latencyMs: Date.now() - startedAt, detail: "TCP connect succeeded" });
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "ERROR";
      const errorClass: TcpProbeResult["errorClass"] =
        code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? "DNS"
          : code === "ECONNREFUSED"
            ? "REFUSED"
            : "ERROR";
      done({ host, port, errorClass, latencyMs: null, detail: `${code}: ${err.message}` });
    });
  });
}

export interface FleetPreflightRow extends TcpProbeResult {
  id: string;
  label: string;
  liveSshFlavor: string | null;
}

export async function runTcpPreflight(
  devices: PublicDemoDevice[] = PUBLIC_DEMO_FLEET,
  timeoutMs = 8000,
): Promise<FleetPreflightRow[]> {
  const rows: FleetPreflightRow[] = [];
  // Sequential on purpose — one gentle connection per public device, no bursts.
  for (const device of devices) {
    const probe = await tcpProbe(device.host, device.port, timeoutMs);
    rows.push({ id: device.id, label: device.label, liveSshFlavor: device.liveSshFlavor, ...probe });
  }
  return rows;
}

/* ──────────────────────────── ssh stage ──────────────────────────── */

export interface SshStageReport {
  host: string;
  port: number;
  username: string;
  probe: { latencyMs: number; banner: string; negotiated: string };
  /** SAFE-001 enrollment capture: the fingerprint the device PRESENTED (no enforcement) */
  presentedHostKey: { keyType: string; fingerprint: string } | null;
  showVersion: string;
  backup: { ok: boolean; bytes: number; detail: string } | null;
}

const SHOW_VERSION = "show version"; // the one exec this tool ever issues (read-only)

function toSshCredentials(creds: DemoSshCreds): SshCredentials {
  return {
    host: creds.host,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    // Enrollment capture ONLY (SAFE-001): record the presented key so the
    // operator can pin it for subsequent runs. expectedFingerprint stays null.
    onHostKey: (meta) => {
      presentedHostKey = meta;
    },
  };
}

let presentedHostKey: { keyType: string; fingerprint: string } | null = null;

export async function runSshStage(
  creds: DemoSshCreds,
  options: { backup?: boolean } = {},
): Promise<SshStageReport> {
  presentedHostKey = null;
  const sshCreds = toSshCredentials(creds);
  const probe = await sshProbe(sshCreds, 12_000);
  const showVersion = await sshExecText(sshCreds, SHOW_VERSION, 20_000);

  let backup: SshStageReport["backup"] = null;
  if (options.backup) {
    // The PRODUCT adapter path: same createLiveSshAdapter the worker router
    // uses for real-device backups (read-only allowlist `show running-config`).
    try {
      const adapter = createLiveSshAdapter("cisco", sshCreds);
      const result = await adapter.fetchConfig({
        deviceId: "demo-fleet-probe",
        hostname: creds.host,
        vendor: "cisco",
      });
      backup = {
        ok: true,
        bytes: result.rawText.length,
        detail: `captured ${result.rawText.split("\n").length} lines via the certified cisco LIVE_SSH adapter`,
      };
    } catch (error) {
      backup = { ok: false, bytes: 0, detail: (error as Error).message };
    }
  }

  return {
    host: creds.host,
    port: creds.port,
    username: creds.username,
    probe: { latencyMs: probe.latencyMs, banner: probe.banner, negotiated: probe.negotiated },
    presentedHostKey,
    showVersion: showVersion.trimEnd(),
    backup,
  };
}

/* ────────────────────────────── main ────────────────────────────── */

function printPreflight(rows: FleetPreflightRow[]): void {
  console.log("[DEMO-FLEET] TCP preflight — public demo device fleet (no auth, no commands)");
  for (const row of rows) {
    console.log(
      `[DEMO-FLEET]   ${row.errorClass.padEnd(8)} ${row.host}:${row.port}` +
        (row.latencyMs !== null ? ` (${row.latencyMs} ms)` : "") +
        ` — ${row.label} [flavor: ${row.liveSshFlavor ?? "none (reference only)"}]` +
        ` — ${row.detail}`,
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const sshRequested = argv.includes("--ssh");
  const backupRequested = argv.includes("--backup");
  const asJson = argv.includes("--json");

  // Typed refusal BEFORE any network activity when the SSH stage is requested
  // without credentials (keeps the functional refusal test hermetic).
  let creds: DemoSshCreds | null = null;
  if (sshRequested) {
    const resolution = resolveDemoSshCreds();
    if (!resolution.ok) {
      console.error(
        `[DEMO-FLEET] DEMO_SSH_CREDS_MISSING — the SSH stage requires ${resolution.missing.join(", ")} ` +
          "(per-user DevNet AAA credentials from your own free account; this repository never carries them)",
      );
      return 2;
    }
    creds = resolution.creds;
  }

  const preflight = await runTcpPreflight();
  if (!asJson) printPreflight(preflight);

  let sshReport: SshStageReport | null = null;
  if (creds) {
    try {
      sshReport = await runSshStage(creds, { backup: backupRequested });
      if (!asJson) {
        console.log(
          `[DEMO-FLEET] SSH probe OK — ${sshReport.host}:${sshReport.port} (${sshReport.probe.latencyMs} ms, ${sshReport.probe.negotiated})`,
        );
        console.log(
          `[DEMO-FLEET] presented host key (enrollment capture — pin this for later runs): ` +
            `${sshReport.presentedHostKey?.keyType ?? "unknown"} ${sshReport.presentedHostKey?.fingerprint ?? "n/a"}`,
        );
        console.log(`[DEMO-FLEET] "${SHOW_VERSION}" transcript (first 12 lines):`);
        for (const line of sshReport.showVersion.split("\n").slice(0, 12)) {
          console.log(`[DEMO-FLEET]   | ${line}`);
        }
        if (sshReport.backup) {
          console.log(
            `[DEMO-FLEET] backup via product LIVE_SSH adapter: ${sshReport.backup.ok ? "OK" : "FAILED"} — ${sshReport.backup.detail}`,
          );
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!asJson) console.error(`[DEMO-FLEET] SSH stage failed (honest result): ${message}`);
      if (asJson) {
        console.log(
          JSON.stringify({ preflight, ssh: { ok: false, error: message } }, null, 2),
        );
      }
      return 3;
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ preflight, ssh: sshReport ? { ok: true, ...sshReport } : null }, null, 2));
  }
  if (!asJson && !creds) {
    console.log(
      "[DEMO-FLEET] SSH stage skipped (no --ssh). Real-device auth/read evidence needs your own free " +
        "DevNet AAA credentials via FAYANMS_DEMO_SSH_HOST / _USER / _PASS — see docs/certification/PUBLIC-DEMO-DEVICES.md",
    );
  }
  return 0;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
