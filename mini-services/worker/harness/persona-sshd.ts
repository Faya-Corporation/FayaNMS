/**
 * FayaNMS LIVE_SSH certification harness — generic REAL SSH server factory
 * wearing vendor personas (Phase 22 slice 2; Phase 23 adds config-mode
 * shells).
 *
 * What this IS: a genuine SSH protocol endpoint (ed25519 host key, real
 * handshake, real password authentication, real exec channels). The adapters
 * under certification exercise the genuine ssh2 client transport against
 * genuine ssh2 server machinery — only the DEVICE PERSONA (the CLI text) is
 * simulated. That makes every persona certification a TRANSPORT +
 * COMMAND-MAPPING certification, not a mock of the adapter itself.
 *
 * What this is NOT: physical hardware. Hardware certification (real devices
 * on a wire) stays open and is tracked per-flavor in the README
 * honest-status block — the harness proves the code, not the cable.
 *
 * Two surfaces:
 *   - exec  (Phase 22 read-only plane): one-shot command → output → exit 0,
 *     backed by the `commands` map (values may be functions so personas can
 *     expose MUTABLE config text).
 *   - shell (Phase 23 controlled-change plane): an interactive PTY session
 *     driven line-by-line by the persona's own state machine — config modes
 *     that accept the template verbs and mutate the persona config, so a
 *     post-apply fetch reflects the delta.
 *
 * SAFE-001: the persona EXPOSES its host-key fingerprint
 * (hostKeyFingerprint, computed with the same transport helper the worker
 * enforces with) so the certification driver can exercise the full
 * enroll → pin → verify → mismatch pipeline against a real key.
 *
 * The vendor-specific personas (command outputs, error-line behavior) live
 * next door: ios-sshd.ts, fortios-sshd.ts, aoscx-sshd.ts, junos-sshd.ts,
 * panos-sshd.ts.
 */

import { Server, utils, type Connection } from "ssh2";
import type { Socket } from "node:net";

import { computeHostKeyFingerprint, parseHostKeyType } from "../ssh-transport";

/** One line of CLI input handled by the persona shell. */
export interface PersonaShellAction {
  /** text printed after the line (before the next prompt) */
  output?: string;
  /** true → the persona's invalid-command line is printed instead */
  error?: boolean;
}

/** Persona-owned interactive CLI: prompt + per-line state machine. */
export interface PersonaShellSpec {
  /** the current prompt (personas change it across config modes) */
  prompt(): string;
  /** printed once when the session opens */
  motd?: string;
  /** handle ONE input line (without the trailing newline) */
  handle(line: string): PersonaShellAction | Promise<PersonaShellAction>;
}

export interface PersonaHarnessOptions {
  /** ephemeral port when omitted (0) */
  port?: number;
  username?: string;
  password?: string;
  /** command → raw output text (the persona's READ-ONLY exec allowlist) */
  commands: Record<string, string | (() => string)>;
  /** the authentic CLI line the persona prints for unknown commands */
  invalidCommandLine: string;
  /** interactive config-mode shell (Phase 23 controlled-change plane) */
  shell?: PersonaShellSpec;
}

export interface PersonaHarness {
  port: number;
  /**
   * SAFE-001 — OpenSSH-style fingerprint of this persona's host key
   * ("SHA256:…", same helper the worker transport enforces with). Null only
   * if the harness key could not be parsed (certification would fail).
   */
  hostKeyFingerprint: string | null;
  /** key algorithm the persona presents, e.g. "ssh-ed25519" */
  hostKeyType: string;
  close(): Promise<void>;
}

/** Join persona body lines into a raw command payload (trailing newline). */
export function personaOutput(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

async function driveShell(
  stream: {
    write(chunk: string): void;
    end(): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "close", listener: () => void): void;
  },
  shell: PersonaShellSpec,
  invalidCommandLine: string,
): Promise<void> {
  if (shell.motd) stream.write(shell.motd);
  stream.write(shell.prompt());
  let lineBuffer = "";

  const handleLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.replace(/\r$/, "");
    if (line.length > 0) {
      try {
        const action = await shell.handle(line);
        if (action.output) stream.write(action.output);
        if (action.error) stream.write(invalidCommandLine);
      } catch {
        stream.write(invalidCommandLine);
      }
    }
    stream.write(shell.prompt());
  };

  return new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      let index = lineBuffer.indexOf("\n");
      while (index >= 0) {
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        void handleLine(line);
        index = lineBuffer.indexOf("\n");
      }
    });
    stream.on("close", () => resolve());
  });
}

export async function startPersonaSshHarness(
  opts: PersonaHarnessOptions,
): Promise<PersonaHarness> {
  const username = opts.username ?? "netadmin";
  const password = opts.password ?? "faya-harness";
  const keyPair = utils.generateKeyPairSync("ed25519");
  const hostKey = keyPair.private;
  // SAFE-001 — derive the persona's public key blob + fingerprint with the
  // SAME helpers the client transport enforces, so certify pins the real
  // value and a mismatch test proves the enforcement path end-to-end.
  const parsedKey = utils.parseKey(hostKey);
  const publicBlob = parsedKey instanceof Error ? null : parsedKey.getPublicSSH();
  const hostKeyFingerprint = publicBlob ? computeHostKeyFingerprint(publicBlob) : null;
  const hostKeyType = publicBlob ? parseHostKeyType(publicBlob) : "unknown";
  const connections = new Set<Connection>();
  const allowlist = new Set(Object.keys(opts.commands));
  // Raw TCP sockets (ssh2 wraps the real socket on the connection's
  // `_sock`) — tracked so close() can DESTROY lingering idle sessions.
  // In-process clients (the test matrix, the certify driver) keep
  // failed-auth / mismatched-handshake connections open past a graceful
  // end, and server.close() then never completes on runtimes without
  // net.Server#closeAllConnections (Bun). Purely teardown plumbing — the
  // SSH semantics of the harness are untouched.
  const rawSockets = new Set<Socket>();

  const server = new Server({ hostKeys: [hostKey] }, (ctx) => {
    connections.add(ctx);
    ctx.on("close", () => connections.delete(ctx));
    const rawSocket = (ctx as unknown as { _sock?: Socket })._sock;
    if (rawSocket) {
      rawSockets.add(rawSocket);
      rawSocket.once("close", () => rawSockets.delete(rawSocket));
    }
    ctx.on("authentication", (auth) => {
      if (auth.method !== "password") {
        auth.reject();
        return;
      }
      if (auth.username === username && auth.password === password) {
        auth.accept();
      } else {
        auth.reject();
      }
    });
    ctx.on("session", (accept) => {
      const session = accept();
      // Real devices grant the PTY request before any shell/exec — accept it
      // (the Phase 23 CLI session driver requests a PTY for prompt-driven
      // interaction).
      session.on("pty", (acceptPty) => {
        acceptPty();
      });
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        const command = (info.command ?? "").trim();
        const entry = allowlist.has(command) ? opts.commands[command] : undefined;
        if (entry !== undefined) {
          stream.stdout.write(typeof entry === "function" ? entry() : entry);
        } else {
          // Authentic persona behavior: unknown commands print the vendor
          // error line and the exec channel exits 0.
          stream.stdout.write(opts.invalidCommandLine);
        }
        stream.exit(0);
        stream.end();
      });
      session.on("shell", (acceptShell) => {
        if (!opts.shell) {
          // Persona without an interactive CLI: close the channel.
          acceptShell().end();
          return;
        }
        const stream = acceptShell();
        void driveShell(stream, opts.shell, opts.invalidCommandLine);
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    port,
    hostKeyFingerprint,
    hostKeyType,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) {
          try {
            conn.end();
          } catch {
            /* already closed */
          }
        }
        // Destroy lingering raw sockets — a graceful end cannot reach
        // connections whose in-process client never closes its side
        // (failed-auth, killed handshake); without this server.close()
        // never completes on runtimes without closeAllConnections.
        for (const rawSocket of rawSockets) {
          try {
            rawSocket.destroy();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      }),
  };
}
