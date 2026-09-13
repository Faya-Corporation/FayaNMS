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
 *     SSH_EXEC_FAILED / SSH_SESSION_FAILED) so the runner can map it to
 *     the job failure path verbatim and the UI can render an actionable
 *     message.
 *   - BOUNDED: every connect/exec/session carries an explicit timeout;
 *     sockets are always ended (success and failure paths both).
 */

import { Client } from "ssh2";

export class SshError extends Error {
  constructor(
    public readonly code:
      | "SSH_AUTH_FAILED"
      | "SSH_UNREACHABLE"
      | "SSH_TIMEOUT"
      | "SSH_EXEC_FAILED"
      | "SSH_SESSION_FAILED",
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
