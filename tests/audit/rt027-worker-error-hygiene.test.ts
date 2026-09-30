import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  SshError,
  sshExecRejection,
  type SshCredentials,
} from "../../mini-services/worker/ssh-transport";
import { handle, internalErrorResponse } from "../../mini-services/worker/index";
import {
  LOG_MAX_BYTES,
  rotateLogIfOversized,
} from "../../mini-services/worker/next-client";
import { serviceAuthHeader } from "../../mini-services/worker/service-token";

/**
 * RT-027 / F-043 — worker control-plane error hygiene.
 *
 * BEFORE: the catch-all handler echoed raw `(e as Error)?.message` to
 * control-plane callers (internal vault file paths, DNS codes, stack-
 * adjacent text); SSH_EXEC_FAILED embedded 200 chars of DEVICE OUTPUT in
 * the message that lands in job records / the UI; worker.log grew
 * unbounded (and was a disclosure sink for the very messages above).
 *
 * Pinned here:
 *   1. the catch-all answers exactly "Internal worker error" + a
 *      correlationId; the full detail goes to the SERVER log only;
 *   2. the SSH_EXEC_FAILED rejection carries the command + exit code,
 *      NEVER the device output excerpt (pure helper pin +, when the
 *      sandbox provides ssh-keygen for the persona harness, the REAL
 *      transport rejection path with stderr device text);
 *   3. worker.log rotation triggers at the cap and never throws;
 *   4. typed error routes keep their exact contracts (regression);
 *   5. source police: nothing depends on device output inside the
 *      SSH_EXEC_FAILED prose (the code — not the prose — is the contract).
 */

const SSH_TRANSPORT_SOURCE = readFileSync("mini-services/worker/ssh-transport.ts", "utf8");
const WORKER_INDEX_SOURCE = readFileSync("mini-services/worker/index.ts", "utf8");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("RT-027 — catch-all response carries no internal detail", () => {
  test("response error is exactly 'Internal worker error' + correlationId; detail only in the log call", async () => {
    const secretDetail =
      "vault file /etc/fayanms/secrets/vault.json unreadable: ENOTFOUND vault-internal.fayanms.svc";
    const err = new Error(secretDetail);

    const logSpy = spyOn(console, "log");
    try {
      const res = internalErrorResponse(err);
      expect(res.status).toBe(500);
      // The response JSON carries ONLY the generic message + correlation id.
      const parsed = (await res.json()) as {
        ok: boolean;
        error: string;
        correlationId: string;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe("Internal worker error");
      expect(parsed.correlationId).toMatch(UUID_RE);
      expect(JSON.stringify(parsed)).not.toContain("vault.json");
      expect(JSON.stringify(parsed)).not.toContain("ENOTFOUND");

      // The FULL error detail appears in the SERVER log call, keyed by
      // the SAME correlation id (log() console-writes synchronously).
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(secretDetail);
      expect(logged).toContain(parsed.correlationId);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("non-Error throwables are genericized too (String(e) stays server-side)", async () => {
    const logSpy = spyOn(console, "log");
    try {
      const res = internalErrorResponse("raw thrown string with topology 10.255.0.1");
      expect(res.status).toBe(500);
      const parsed = (await res.json()) as { error: string; correlationId: string };
      expect(parsed.error).toBe("Internal worker error");
      expect(parsed.correlationId).toMatch(UUID_RE);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("10.255.0.1");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("RT-027 — SSH_EXEC_FAILED omits device output", () => {
  const DEVICE_SECRET_MARKER = "DEVICE-OUTPUT-MARKER rt027 % Invalid input detected at '^' marker.";

  test("the rejection helper (the exact client-facing prose) carries code + exit, no device text", () => {
    const err = sshExecRejection("show version", 7);
    expect(err).toBeInstanceOf(SshError);
    expect(err.code).toBe("SSH_EXEC_FAILED");
    expect(err.message).toBe('Command "show version" exited with 7');
    expect(err.message).not.toContain(DEVICE_SECRET_MARKER);
    expect(err.message).not.toContain("Invalid input");
    // A null exit code (channel closed without an exit signal) is honest too.
    expect(sshExecRejection("show run", null).message).toBe('Command "show run" exited with null');
  });

  // End-to-end against a REAL persona exec failure — requires ssh-keygen
  // for the ephemeral harness host key (same environment precondition as
  // the R50.8/R61 persona suites; skipped cleanly where it cannot run).
  const HAS_SSH_KEYGEN = Bun.which("ssh-keygen") !== null;

  test.skipIf(!HAS_SSH_KEYGEN)(
    "the transport rejection path logs the excerpt server-side and rejects WITHOUT it",
    async () => {
      const { startPersonaSshHarness } = await import(
        "../../mini-services/worker/harness/persona-sshd"
      );
      const harness = await startPersonaSshHarness({
        commands: {},
        invalidCommandLine: "Command fail. Return code -3",
        password: "faya-rt027-harness-secret",
        failingCommands: {
          "show version": { exitCode: 7, stderr: `${DEVICE_SECRET_MARKER}\n` },
        },
      });
      try {
        const creds: SshCredentials = {
          host: "127.0.0.1",
          port: harness.port,
          username: "netadmin",
          password: "faya-rt027-harness-secret",
        };
        const { sshExecText } = await import("../../mini-services/worker/ssh-transport");

        const logSpy = spyOn(console, "log");
        try {
          let caught: unknown = null;
          try {
            await sshExecText(creds, "show version", 15_000);
            expect.unreachable("non-zero exit must reject");
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(SshError);
          const sshErr = caught as SshError;
          // The CODE is unchanged (the contract).
          expect(sshErr.code).toBe("SSH_EXEC_FAILED");
          // The message carries the command + exit code and NO device text.
          expect(sshErr.message).toBe('Command "show version" exited with 7');
          expect(sshErr.message).not.toContain(DEVICE_SECRET_MARKER);
          expect(sshErr.message).not.toContain("Invalid input");

          // The device-output excerpt IS in the server-side log call.
          const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain(DEVICE_SECRET_MARKER);
          expect(logged).toContain("SSH_EXEC_FAILED");
        } finally {
          logSpy.mockRestore();
        }
      } finally {
        await harness.close();
      }
    },
    30_000,
  );
});

describe("RT-027 — worker.log size-capped rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "fayanms-rt027-log-"));

  afterEach(() => {
    rmSync(join(dir, "log-a.log.1"), { force: true });
  });

  test("a file seeded over the cap rotates to .log.1; appends continue on a fresh file", () => {
    const logPath = join(dir, "log-a.log");
    writeFileSync(logPath, "x".repeat(40), "utf8");
    rotateLogIfOversized(logPath, 16); // cap of 16 bytes, file is 40
    // The old generation moved to .1; the live path is gone (append recreates).
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("x".repeat(40));
    expect(existsSync(logPath)).toBe(false);
    // "Appends continue" — the post-rotation append recreates the live file.
    writeFileSync(logPath, "[ts] next generation\n", "utf8");
    expect(statSync(logPath).size).toBeLessThan(40);
  });

  test("a file under the cap is NOT rotated", () => {
    const logPath = join(dir, "log-b.log");
    writeFileSync(logPath, "small\n", "utf8");
    rotateLogIfOversized(logPath, LOG_MAX_BYTES);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, "utf8")).toBe("small\n");
  });

  test("never throws: missing file and missing directory are swallowed", () => {
    expect(() => rotateLogIfOversized(join(dir, "does-not-exist.log"))).not.toThrow();
    expect(() =>
      rotateLogIfOversized(join(dir, "no", "such", "dir", "worker.log"))
    ).not.toThrow();
  });

  test("the shipped cap is 5 MiB and log() rotates before appending (source pin)", () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    const source = readFileSync("mini-services/worker/next-client.ts", "utf8");
    expect(source).toContain("rotateLogIfOversized(LOG_FILE)");
    expect(source).toContain('renameSync(path, `${path}.1`)');
  });
});

describe("RT-027 — typed error contracts unchanged (regression)", () => {
  test("HostKeyPolicyError still answers its exact 400 shape through handle()", async () => {
    const res = await handle(
      new Request("http://worker:3030/simulate/connect", {
        method: "POST",
        headers: { authorization: serviceAuthHeader() },
        body: JSON.stringify({
          vendor: "cisco-ios",
          host: "10.0.0.1",
          dataSource: "LIVE_SSH",
          credential: { username: "netadmin", port: 22, secretRef: "vault://ssh/x" },
          sshHostKeyPin: { fingerprint: "not-a-valid-fingerprint" },
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_HOSTKEY_PIN_INVALID");
  });

  test("VaultError (credential unresolved) still answers its exact 400 shape", async () => {
    const savedHatch = process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    try {
      const res = await handle(
        new Request("http://worker:3030/simulate/connect", {
          method: "POST",
          headers: { authorization: serviceAuthHeader() },
          body: JSON.stringify({
            vendor: "cisco-ios",
            host: "10.0.0.1",
            dataSource: "LIVE_SSH",
            credential: {
              username: "netadmin",
              port: 22,
              secretRef: "vault://ssh/rt027-missing-secret",
            },
            sshHostKeyPin: { fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
          }),
        })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("CREDENTIAL_UNRESOLVED");
    } finally {
      if (savedHatch === undefined) delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
      else process.env.FAYANMS_PROBE_ALLOW_SPECIAL = savedHatch;
    }
  });
});

describe("RT-027 — runner failure records stay code-keyed (source police)", () => {
  test("no code path depends on device output inside SSH_EXEC_FAILED prose", () => {
    // The client-facing message is the exact code+exit-code shape.
    expect(SSH_TRANSPORT_SOURCE).toContain(
      '`Command "${command}" exited with ${exitCode}`',
    );
    // The excerpt survives ONLY in the server-side log() call — exactly ONE
    // `(errOut || out)` interpolation remains in the file, and it is inside
    // the void log(...) statement, not an SshError constructor.
    const occurrences = SSH_TRANSPORT_SOURCE.split("errOut || out").length - 1;
    expect(occurrences).toBe(1);
    const logCallIdx = SSH_TRANSPORT_SOURCE.indexOf("void log(");
    const excerptIdx = SSH_TRANSPORT_SOURCE.indexOf("errOut || out");
    expect(logCallIdx).toBeGreaterThan(-1);
    expect(excerptIdx).toBeGreaterThan(logCallIdx);
    // The rejection site uses the extracted helper.
    expect(SSH_TRANSPORT_SOURCE).toContain("reject(sshExecRejection(command, exitCode))");
    // The runner records failures as `${code}: ${message}` — code-keyed.
    expect(WORKER_INDEX_SOURCE).toContain("lastError = `${e.code}: ${e.message}`");
  });

  test("the catch-all no longer echoes raw error messages", () => {
    expect(WORKER_INDEX_SOURCE).not.toContain('(e as Error)?.message ?? "internal error"');
    expect(WORKER_INDEX_SOURCE).toContain('"Internal worker error"');
    expect(WORKER_INDEX_SOURCE).toContain("randomUUID()");
  });
});
