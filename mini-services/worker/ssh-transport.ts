/**
 * FayaNMS worker — real SSH transport (Phase 22 slice 1, READ-ONLY;
 * Phase 23 adds the CONTROLLED write session).
 *
 * A thin wrapper around the ssh2 client used exclusively by live-ssh.ts
 * (read-only exec plane) and live-change.ts (controlled change plane).
 * Invariants:
 *   - EXEC-ONLY (read plane): every command runs on the SSH "exec"
 *     channel. No shell channel, no PTY, no interactive session —
 *     strictly one request/response per command. This is the
 *     transport-level half of the read-only discipline; the command-level
 *     half is the allowlist in live-ssh.ts.
 *   - CLI-SESSION (controlled change plane, Phase 23): a bounded PTY
 *     shell channel driven prompt-to-prompt (netmiko-style) — the ONLY
 *     code path that can mutate a live device, and only with commands
 *     built worker-side by live-change.ts from a validated plan (the app
 *     can never send arbitrary command text).
 *   - TYPED FAILURES: every error surfaces as an SshError with a stable
 *     code (SSH_AUTH_FAILED / SSH_UNREACHABLE / SSH_TIMEOUT /
 *     SSH_EXEC_FAILED / SSH_SESSION_FAILED / SSH_HOSTKEY_MISMATCH) so the
 *     runner can map it to the job failure path verbatim and the UI can
 *     render an actionable message.
 *   - HOST-KEY PINNING (SAFE-001, audit P0-001): when a pinned fingerprint
 *     is present the transport verifies the server's host key DURING the
 *     handshake and BEFORE authentication — credentials are never sent to
 *     an endpoint whose key does not match the enrollment (typed
 *     SSH_HOSTKEY_MISMATCH, fail closed). Enrollment capture (recording the
 *     presented key without enforcement) is a separate, explicit mode used
 *     only by the audited enrollment probe.
 *   - BOUNDED: every connect/exec/session carries an explicit timeout;
 *     sockets are always ended (success and failure paths both).
 *   - BOUNDED OUTPUT (R50-T025): exec accumulation is capped per stream
 *     (default 1 MiB, caller-tightenable) — a chatty or malicious endpoint
 *     cannot exhaust worker memory through a read-only probe. The tail
 *     beyond the budget is dropped at chunk granularity; the detection
 *     plane additionally bounds its ANALYSIS input (ANALYSIS_MAX_BYTES).
 */

import { createHash } from "node:crypto";
import { Client } from "ssh2";

import { log } from "./next-client";

export class SshError extends Error {
  constructor(
    public readonly code:
      | "SSH_AUTH_FAILED"
      | "SSH_UNREACHABLE"
      | "SSH_TIMEOUT"
      | "SSH_EXEC_FAILED"
      | "SSH_SESSION_FAILED"
      | "SSH_HOSTKEY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  /**
   * SAFE-001 host-key pin: OpenSSH-style "SHA256:<base64>" fingerprint the
   * server's key MUST match (verified pre-auth). null/absent = no pin —
   * an UNPINNED credentialed connection is therefore IMPOSSIBLE through
   * this type: first-contact capture is a separate credential-free path
   * (captureSshHostKey, R61 P0) that carries no credential material at
   * all, so a pin-less connection can never authenticate.
   */
  expectedFingerprint?: string | null;
}

/**
 * OpenSSH-style SHA-256 fingerprint of an SSH public key blob:
 * "SHA256:" + base64(digest) with padding stripped (43 chars).
 * This is the exact value pinned in the SshHostKey enrollment and compared
 * inside the hostVerifier below.
 */
export function computeHostKeyFingerprint(publicKeyBlob: Buffer): string {
  const b64 = createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "");
  return `SHA256:${b64}`;
}

/**
 * Extract the key algorithm name from an SSH wire-format public key blob
 * (first length-prefixed string field, e.g. "ssh-ed25519"). Used by the
 * enrollment capture so the admin sees which key type they are pinning.
 */
export function parseHostKeyType(publicKeyBlob: Buffer): string {
  if (publicKeyBlob.length < 4) return "unknown";
  const nameLen = publicKeyBlob.readUInt32BE(0);
  if (nameLen === 0 || 4 + nameLen > publicKeyBlob.length || nameLen > 64) {
    return "unknown";
  }
  return publicKeyBlob.subarray(4, 4 + nameLen).toString("utf8") || "unknown";
}

export interface SshProbeResult {
  latencyMs: number;
  banner: string;
  negotiated: string;
}

function classifyConnectError(e: unknown): SshError {
  const err = e as { message?: string; level?: string };
  const message = err?.message ?? String(e);
  const level = err?.level ?? "";
  if (level.includes("authentication") || /authentication|auth/i.test(message)) {
    return new SshError("SSH_AUTH_FAILED", `SSH authentication failed: ${message}`);
  }
  if (level.includes("timeout") || /timed?\s*out|timeout/i.test(message)) {
    return new SshError("SSH_TIMEOUT", `SSH connection timed out: ${message}`);
  }
  return new SshError("SSH_UNREACHABLE", `SSH connection failed: ${message}`);
}

interface OpenConnection {
  client: Client;
  latencyMs: number;
  banner: string;
}

function openConnection(creds: SshCredentials, timeoutMs: number): Promise<OpenConnection> {
  return new Promise<OpenConnection>((resolve, reject) => {
    const startedAt = Date.now();
    const client = new Client();
    let banner = "";
    let settled = false;
    // SAFE-001: set when the hostVerifier rejected the presented key — the
    // subsequent connect error is then surfaced as SSH_HOSTKEY_MISMATCH (the
    // generic ssh2 failure text would otherwise be unclassifiable).
    let hostKeyRejected: string | null = null;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already closed */
      }
      if (hostKeyRejected !== null) {
        reject(
          new SshError(
            "SSH_HOSTKEY_MISMATCH",
            `SSH host key does not match the pinned enrollment (expected ${hostKeyRejected}) — connection refused before authentication; if the device key legitimately rotated, re-enroll the host key`,
          ),
        );
        return;
      }
      reject(classifyConnectError(err));
    };

    client
      .on("banner", (text: string) => {
        banner = (text ?? "").trim();
      })
      .on("ready", () => {
        if (settled) return;
        settled = true;
        resolve({ client, latencyMs: Date.now() - startedAt, banner });
      })
      .on("error", fail);

    const connectConfig: Parameters<Client["connect"]>[0] = {
      host: creds.host,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
    };

    // SAFE-001 — pin enforcement. ssh2 calls the verifier with the raw
    // server host key DURING the handshake, BEFORE any authentication: a
    // mismatch aborts the connection without the credential ever being
    // transmitted. A credential-FREE connection (captureSshHostKey) cannot
    // reach this type at all — the SshCredentials type carries auth
    // material, so every connection built from it is credentialed and
    // therefore REQUIRES a pin by policy (unpinned live = refused at the
    // router; R61 P0 removed the credential-bearing capture mode).
    if (creds.expectedFingerprint) {
      const expected = creds.expectedFingerprint;
      connectConfig.hostVerifier = (key: Buffer): boolean => {
        const fingerprint = computeHostKeyFingerprint(key);
        if (fingerprint !== expected) {
          hostKeyRejected = expected;
          return false;
        }
        return true;
      };
    }

    try {
      client.connect(connectConfig);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * R61 P0 — credential-free FIRST-CONTACT host-key capture.
 *
 * The invariant (independent re-verification 2026-09-19, P0): enrollment
 * must capture the presented host key with ZERO vault access and ZERO user
 * authentication — the credential must never be transmitted before the
 * operator has verified the captured fingerprint out-of-band.
 *
 * How the invariant is enforced structurally:
 *   - the connect config carries NO password, NO private key, NO target
 *     username — only a FIXED non-secret marker (ssh2's API requires the
 *     field) and no authentication method whatsoever; the parameter type
 *     accepts only host + port;
 *   - the hostVerifier captures the presented key and returns FALSE — the
 *     handshake is deliberately aborted DURING key exchange, so the SSH
 *     protocol never even reaches the authentication stage (a persona
 *     harness counter proves auth attempts stay at 0);
 *   - the expected post-capture error is treated as the SUCCESS outcome and
 *     resolved with the captured key; any pre-capture transport failure
 *     (unreachable, timeout) is rejected as the usual typed SshError.
 */
export interface HostKeyCaptureResult {
  keyType: string;
  fingerprint: string;
  latencyMs: number;
  banner: string;
}

export async function captureSshHostKey(
  target: { host: string; port: number },
  timeoutMs = 8000,
): Promise<HostKeyCaptureResult> {
  const startedAt = Date.now();
  let banner = "";
  let captured: { keyType: string; fingerprint: string } | null = null;
  let captureAborted = false;
  let settled = false;

  return new Promise<HostKeyCaptureResult>((resolve, reject) => {
    const client = new Client();
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already closed */
      }
      if (captureAborted && captured) {
        // The deliberate post-capture handshake abort — the EXPECTED outcome.
        resolve({ ...captured, latencyMs: Date.now() - startedAt, banner });
        return;
      }
      reject(classifyConnectError(err));
    };

    client
      .on("banner", (text: string) => {
        banner = (text ?? "").trim();
      })
      .on("ready", () => {
        // Structurally unreachable: with no auth methods configured the
        // server can never accept us. If a server somehow completes auth,
        // kill the connection immediately — this function must NEVER
        // authenticate.
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          /* already closed */
        }
        reject(new SshError("SSH_AUTH_FAILED", "host-key capture reached authentication — config bug, connection killed"));
      })
      .on("error", fail);

    const connectConfig: Parameters<Client["connect"]>[0] = {
      host: target.host,
      port: target.port,
      // ssh2 requires SOME username to build the connection; this is a
      // FIXED, non-secret marker (not the target's username — the probe
      // never learns or sends it). With no password/privateKey/none-auth
      // configured there is no way to authenticate, and the hostVerifier
      // below aborts the handshake during key exchange anyway — the
      // persona-harness counter proves the server sees ZERO auth events.
      username: "fayanms-hostkey-probe",
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
      // NO password, NO privateKey — zero credential material by
      // construction (see the R61 P0 invariant above).
    };

    connectConfig.hostVerifier = (key: Buffer): boolean => {
      captured = { keyType: parseHostKeyType(key), fingerprint: computeHostKeyFingerprint(key) };
      captureAborted = true;
      // Abort the handshake NOW, during key exchange, before the protocol
      // can reach authentication.
      return false;
    };

    try {
      client.connect(connectConfig);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Connect, measure, disconnect. Used by the test-connection flow
 * (POST /simulate/connect with dataSource LIVE_SSH) and by the adapter's
 * connect() step — no commands are executed.
 */
export async function sshProbe(
  creds: SshCredentials,
  timeoutMs = 8000,
): Promise<SshProbeResult> {
  const { client, latencyMs, banner } = await openConnection(creds, timeoutMs);
  try {
    client.end();
  } catch {
    /* already closed */
  }
  return {
    latencyMs,
    banner: banner || "(no pre-auth banner sent)",
    negotiated: "ssh2 (real transport)",
  };
}

/**
 * R50-T025 — the bounded stdout/stderr accumulator. Appends a chunk while
 * the byte budget allows; past the budget the crossing chunk is sliced to
 * the EXACT remaining budget and the tail is dropped (RT-026: the cap is
 * enforced exactly — `bytes` never overshoots `maxBytes`) and the
 * truncation is reported so callers can observe it. Pure: unit-pinned in
 * the audit suite.
 *
 * Byte-accurate note: Buffer.subarray slices at a BYTE boundary and can
 * split a multi-byte UTF-8 sequence — the trailing replacement char
 * (\uFFFD) is acceptable at a truncation boundary (the stream is already
 * `truncated: true`). Do NOT "fix" this into an unbounded decoder loop.
 */
export function appendBounded(
  current: { text: string; bytes: number; truncated: boolean },
  chunk: Buffer | string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  if (current.bytes >= maxBytes) {
    return { ...current, truncated: true };
  }
  const chunkBytes = Buffer.byteLength(chunk);
  if (current.bytes + chunkBytes <= maxBytes) {
    return {
      text: current.text + chunk.toString(),
      bytes: current.bytes + chunkBytes,
      truncated: current.truncated,
    };
  }
  // This chunk crosses the budget: append ONLY the remaining budget and
  // drop the tail (RT-026 / F-042 — exact cap, no whole-chunk overshoot).
  const remaining = maxBytes - current.bytes;
  const sliced =
    typeof chunk === "string"
      ? Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8")
      : chunk.subarray(0, remaining).toString("utf8");
  return { text: current.text + sliced, bytes: maxBytes, truncated: true };
}

/**
 * RT-027 / F-043 — the client-facing rejection for a non-zero exec exit.
 * Extracted (pure) so the audit suite can pin the exact prose hermetically:
 * the message carries the command + exit code ONLY — device output is
 * NEVER interpolated into client-facing error text (it goes to the
 * server-side log at the rejection site in sshExecText).
 */
export function sshExecRejection(command: string, exitCode: number | null): SshError {
  return new SshError("SSH_EXEC_FAILED", `Command "${command}" exited with ${exitCode}`);
}

/**
 * Connect, execute ONE command on the exec channel, collect stdout,
 * disconnect. Non-zero exit surfaces as SSH_EXEC_FAILED (RT-027 / F-043:
 * the message carries the command + exit code ONLY — the device-output
 * excerpt stays server-side in worker.log, it never travels in the error
 * that reaches job records / control-plane clients).
 */
export async function sshExecText(
  creds: SshCredentials,
  command: string,
  timeoutMs = 20000,
  // R50-T025 — per-stream output budget (bytes). The worker's detection
  // probe passes the tighter ANALYSIS_MAX_BYTES; other surfaces keep the
  // 1 MiB default (no legitimate config excerpt approaches it).
  maxOutputBytes = 1_048_576,
): Promise<string> {
  const { client } = await openConnection(creds, timeoutMs);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SshError(
            "SSH_TIMEOUT",
            `Command timed out after ${timeoutMs} ms: ${command}`,
          ),
        );
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(new SshError("SSH_EXEC_FAILED", `exec "${command}" failed: ${err.message}`));
          return;
        }
        let out = "";
        let errOut = "";
        // R50-T025: bounded accumulation (see appendBounded above).
        let outAcc = { text: "", bytes: 0, truncated: false };
        let errAcc = { text: "", bytes: 0, truncated: false };
        let exitCode: number | null = null;
        stream.on("data", (chunk: Buffer) => {
          outAcc = appendBounded(outAcc, chunk, maxOutputBytes);
          out = outAcc.text;
        });
        stream.stderr?.on?.("data", (chunk: Buffer) => {
          errAcc = appendBounded(errAcc, chunk, maxOutputBytes);
          errOut = errAcc.text;
        });
        stream.on("exit", (code: number | null) => {
          exitCode = code;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (exitCode !== null && exitCode !== 0) {
            // RT-027 / F-043 — the 200-char device-output excerpt is
            // SERVER-SIDE ONLY (worker.log). The client-facing SshError
            // message carries the command + exit code; the code (not the
            // prose) is the contract, and device text must not travel in
            // error messages that end up in job records / the UI.
            void log(
              `SSH_EXEC_FAILED exit ${exitCode} on "${command}" — device output excerpt (server-side only): ${(errOut || out).slice(0, 200)}`,
            );
            reject(sshExecRejection(command, exitCode));
            return;
          }
          resolve(out);
        });
      });
    });
  } finally {
    try {
      client.end();
    } catch {
      /* already closed */
    }
  }
}

/* ─────────────── CLI session driver (Phase 23, controlled writes) ─────────────── */

/** Per-flavor CLI behavior contract for the interactive session driver. */
export interface CliSessionSpec {
  /**
   * Matches the device CLI prompt at the END of the output stream. Called
   * against the tail of the accumulated buffer after every data chunk.
   */
  promptPattern: RegExp;
  /** patterns that mark a REJECTED command in this vendor's CLI output */
  errorPatterns: RegExp[];
}

export interface CliCommandResult {
  command: string;
  /** false when the persona/device CLI printed a recognized error line */
  ok: boolean;
  /** raw output captured for this command (between the echo and the prompt) */
  output: string;
}

interface ShellChannel {
  write(chunk: string): void;
  end(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

/**
 * Drive an interactive PTY shell channel prompt-to-prompt: wait for the
 * login prompt, then per command write the line, wait for the next prompt,
 * and classify the delta output against the flavor's error patterns.
 *
 * Stop-on-first-rejected-command (controlled behavior): a failed
 * configuration step aborts the remaining plan instead of pushing a
 * half-valid command stack — the caller decides the recovery (the change
 * engine engages its rollback path).
 *
 * Only command-level REJECTIONS return ok:false in the results array;
 * transport-level failures (auth/timeout/unreachable/channel error) throw
 * typed SshErrors like every other routine in this module.
 */
export async function sshCliSession(
  creds: SshCredentials,
  commands: string[],
  spec: CliSessionSpec,
  timeoutMs = 25_000,
): Promise<CliCommandResult[]> {
  const { client } = await openConnection(creds, timeoutMs);
  try {
    return await new Promise<CliCommandResult[]>((resolve, reject) => {
      let buffer = "";
      let scanFrom = 0; // index where the current command's output starts
      let closed = false;
      let aborted = false;
      let channel: ShellChannel | null = null;
      let results: CliCommandResult[] = [];

      const finish = (fn: () => void): void => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        try {
          channel?.end();
        } catch {
          /* already closed */
        }
        try {
          client.end();
        } catch {
          /* already closed */
        }
        fn();
      };

      const failSession = (message: string): void =>
        finish(() => reject(new SshError("SSH_SESSION_FAILED", message)));

      // Global deadline: one bounded budget for the whole session.
      const deadline = setTimeout(
        () => failSession(`CLI session exceeded ${timeoutMs} ms budget`),
        timeoutMs,
      );

      /** Resolve when promptPattern matches the buffer tail after `scanFrom`. */
      let waiter: { test: (tail: string) => boolean; resolve: () => void } | null = null;
      let errorTimer: ReturnType<typeof setTimeout> | null = null;

      function onData(chunk: Buffer): void {
        if (closed || !waiter) {
          // Data before the first waiter is the initial banner — keep it
          // (it carries no per-command output) but cap the buffer.
          buffer += chunk.toString();
          if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
          return;
        }
        buffer += chunk.toString();
        if (buffer.length > 128_000) buffer = buffer.slice(-64_000);
        if (waiter.test(buffer)) {
          const w = waiter;
          waiter = null;
          if (errorTimer) {
            clearTimeout(errorTimer);
            errorTimer = null;
          }
          w.resolve();
        }
      }

      function waitForPrompt(): Promise<void> {
        return new Promise<void>((resolve) => {
          errorTimer = setTimeout(
            () => failSession("CLI prompt not observed — session aborted"),
            Math.min(timeoutMs, 10_000),
          );
          waiter = {
            test: (tail) => {
              const from = Math.max(0, scanFrom - 200); // prompt may precede scanFrom via echo
              return spec.promptPattern.test(tail.slice(from));
            },
            resolve: () => {
              errorTimer = null;
              resolve();
            },
          };
        });
      }

      client.shell(
        // ssh2 API: shell(window, cb) — the PseudoTtyOptions are the FIRST
        // argument; passing them requests a PTY before the shell opens.
        { rows: 80, cols: 400, term: "xterm" },
        (err: Error | undefined, stream: ShellChannel) => {
          if (err || !stream) {
            failSession(`shell channel failed: ${err?.message ?? "no channel"}`);
            return;
          }
          channel = stream;
          stream.on("data", onData);
          stream.on("error", (error: Error) =>
            failSession(`CLI session channel error: ${error.message}`)
          );
          stream.on("close", () => {
            // The channel closed before we finished — only a failure if the
            // plan was still in flight (a graceful end() also lands here).
            if (!closed && waiter) failSession("CLI session channel closed unexpectedly");
          });

          // Nudge the CLI (real devices wait for an initial Enter) and wait
          // for the operational prompt before the plan starts.
          stream.write("\n");

          (async () => {
            try {
              await waitForPrompt();
              scanFrom = buffer.length;

              for (const command of commands) {
                if (aborted) {
                  results.push({
                    command,
                    ok: false,
                    output: "not sent — an earlier command was rejected",
                  });
                  continue;
                }
                stream.write(`${command}\n`);
                await waitForPrompt();
                const output = buffer.slice(scanFrom, buffer.length).replace(/^\s*\n/, "");
                scanFrom = buffer.length;
                const rejected = spec.errorPatterns.some((pattern) => pattern.test(output));
                results.push({ command, ok: !rejected, output: output.trimEnd() });
                if (rejected) aborted = true; // stop-on-first-rejection
              }
              clearTimeout(deadline);
              finish(() => resolve(results));
            } catch (error) {
              clearTimeout(deadline);
              failSession((error as Error)?.message ?? "CLI session failed");
            }
          })();
        },
      );
    });
  } finally {
    try {
      client.end();
    } catch {
      /* already closed */
    }
  }
}
