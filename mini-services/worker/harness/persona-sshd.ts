/**
 * FayaNMS LIVE_SSH certification harness — generic REAL SSH server factory
 * wearing vendor personas (Phase 22 slice 2).
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
 * The vendor-specific personas (command outputs, error-line behavior) live
 * next door: ios-sshd.ts, fortios-sshd.ts, aoscx-sshd.ts.
 */

import { Server, utils, type Connection } from "ssh2";

export interface PersonaHarnessOptions {
  /** ephemeral port when omitted (0) */
  port?: number;
  username?: string;
  password?: string;
  /** command → raw output text (the persona's READ-ONLY exec allowlist) */
  commands: Record<string, string>;
  /** the authentic CLI line the persona prints for unknown commands */
  invalidCommandLine: string;
}

export interface PersonaHarness {
  port: number;
  close(): Promise<void>;
}

/** Join persona body lines into a raw command payload (trailing newline). */
export function personaOutput(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export async function startPersonaSshHarness(
  opts: PersonaHarnessOptions,
): Promise<PersonaHarness> {
  const username = opts.username ?? "netadmin";
  const password = opts.password ?? "faya-harness";
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const connections = new Set<Connection>();
  const allowlist = new Set(Object.keys(opts.commands));

  const server = new Server({ hostKeys: [hostKey] }, (ctx) => {
    connections.add(ctx);
    ctx.on("close", () => connections.delete(ctx));
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
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        const command = (info.command ?? "").trim();
        if (allowlist.has(command)) {
          stream.stdout.write(opts.commands[command]);
        } else {
          // Authentic persona behavior: unknown commands print the vendor
          // error line and the exec channel exits 0.
          stream.stdout.write(opts.invalidCommandLine);
        }
        stream.exit(0);
        stream.end();
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) {
          try {
            conn.end();
          } catch {
            /* already closed */
          }
        }
        server.close(() => resolve());
      }),
  };
}
