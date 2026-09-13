/**
 * FayaNMS worker — real SSH transport (Phase 22 slice 1, READ-ONLY).
 *
 * A thin wrapper around the ssh2 client used exclusively by live-ssh.ts.
 * Invariants:
 *   - EXEC-ONLY: every command runs on the SSH "exec" channel. No shell
 *     channel, no PTY, no interactive session — strictly one
 *     request/response per command. This is the transport-level half of
 *     the read-only discipline; the command-level half is the allowlist in
 *     live-ssh.ts.
 *   - TYPED FAILURES: every error surfaces as an SshError with a stable
 *     code (SSH_AUTH_FAILED / SSH_UNREACHABLE / SSH_TIMEOUT /
 *     SSH_EXEC_FAILED) so the runner can map it to the job failure path
 *     verbatim and the UI can render an actionable message.
 *   - BOUNDED: every connect/exec carries an explicit timeout; sockets are
 *     always ended (success and failure paths both).
 */

import { Client } from "ssh2";

export class SshError extends Error {
  constructor(
    public readonly code:
      | "SSH_AUTH_FAILED"
      | "SSH_UNREACHABLE"
      | "SSH_TIMEOUT"
      | "SSH_EXEC_FAILED",
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

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already closed */
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

    try {
      client.connect({
        host: creds.host,
        port: creds.port,
        username: creds.username,
        password: creds.password,
        readyTimeout: timeoutMs,
        keepaliveInterval: 0,
      });
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
 * Connect, execute ONE command on the exec channel, collect stdout,
 * disconnect. Non-zero exit or stderr-backed failures surface as
 * SSH_EXEC_FAILED with a bounded excerpt.
 */
export async function sshExecText(
  creds: SshCredentials,
  command: string,
  timeoutMs = 20000,
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
        let exitCode: number | null = null;
        stream.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        stream.stderr?.on?.("data", (chunk: Buffer) => {
          errOut += chunk.toString();
        });
        stream.on("exit", (code: number | null) => {
          exitCode = code;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (exitCode !== null && exitCode !== 0) {
            reject(
              new SshError(
                "SSH_EXEC_FAILED",
                `Command "${command}" exited with ${exitCode}: ${(errOut || out).slice(0, 200)}`,
              ),
            );
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
