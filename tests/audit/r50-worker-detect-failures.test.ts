import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

import { handle } from "../../mini-services/worker/index";
import { serviceAuthHeader } from "../../mini-services/worker/service-token";
import {
  DETECT_COMMANDS,
} from "../../mini-services/worker/vendor-fingerprint";
import { startPersonaSshHarness, personaOutput } from "../../mini-services/worker/harness/persona-sshd";
import {
  DETECTION_ERROR_CODES,
  mapWorkerErrorToDetectionCode,
} from "../../src/lib/net/detection-contract";

/**
 * R50.8 — worker-plane /live/detect-vendor FAILURE matrix (roadmap §10.3 +
 * §10.4 cells that the earlier suites pinned only at mapper level or via
 * live-only evidence).
 *
 * What is NEWLY hermetic here (the cells marked GAP-CLOSED-R50.8 in
 * docs/audits/FayaNMS-R50.8-Test-Matrix-2026-09-17.md):
 *   - connect failure      → real ECONNREFUSED against a closed loopback
 *                            port → honest SSH_UNREACHABLE (200 ok:false);
 *   - auth failure         → real ssh2 password rejection → SSH_AUTH_FAILED;
 *   - host-key mismatch    → a valid-format FOREIGN fingerprint as the pin →
 *                            the handshake dies pre-auth (SSH_HOSTKEY_
 *                            MISMATCH) — the SAFE-001 enforcement path;
 *   - command rejected /
 *     probe fallback       → a persona that REJECTS "show version" and
 *                            "show system info" (authentic CLI lines) and
 *                            answers only probe #3 → the chain walks to
 *                            the informative answer (FortiOS shape);
 *   - output truncation    → a ~2 MiB persona answer still produces a
 *                            BOUNDED detection payload (evidence caps);
 *   - loopback target at the WORKER plane → SSH_TARGET_POLICY_REFUSED
 *                            BEFORE any connection (defense in depth: the
 *                            worker never trusts the app plane).
 *
 * HOW the loopback dial is legitimate: the documented lab escape hatch
 * (FAYANMS_PROBE_ALLOW_SPECIAL=true) — the same hatch whose app↔worker
 * parity is pinned in r50-authorization-budgets.test.ts. It is toggled
 * per-suite with save/restore discipline; WITHOUT it, the loopback-refusal
 * case pins the refusal. The vault uses the default env provider with a
 * suite-scoped secret name. Everything runs over REAL ssh2 protocol on
 * ephemeral loopback ports — no socket mocks.
 */

const WORKER_INDEX = readFileSync("mini-services/worker/index.ts", "utf8");

const VAULT_REF = "vault://ssh/r508-harness";
const VAULT_ENV_NAME = "FAYANMS_VAULT_SSH_R508_HARNESS";
const HARNESS_PASSWORD = "faya-r508-harness-secret";

const savedEnv = {
  hatch: process.env.FAYANMS_PROBE_ALLOW_SPECIAL,
  vaultSecret: process.env[VAULT_ENV_NAME],
};

/* Realistic FortiOS `get system status` shape (the probe the CLI answers
   after rejecting the two Cisco/PAN probes). */
const FORTIOS_STATUS = personaOutput([
  "FGT-60F-R508 (FortiGate-60F)",
  "Firmware Version: FortiOS v7.4.4",
  "Current Time: Thu Sep 17 10:00:00 2026",
]);

const call = (payload: unknown): Promise<Response> =>
  handle(
    new Request("http://worker/live/detect-vendor", {
      method: "POST",
      headers: {
        authorization: serviceAuthHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );

/** The worker's pin shape is an OBJECT (parseHostKeyPin contract). */
const pin = (fingerprint: string | null) => ({ fingerprint });

const credential = (port: number) => ({
  username: "netadmin",
  port,
  secretRef: VAULT_REF,
});

/**
 * A real-shaped OpenSSH fingerprint that is NOT the harness key's — the
 * SAFE-001 enforcement compares FINGERPRINTS (string equality against the
 * presented key), so a valid-format foreign value drives the genuine
 * mismatch path without duplicating key generation here.
 */
function foreignFingerprint(): string {
  const digest = createHash("sha256").update("fayanms-r508-foreign-key").digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

describe("R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic)", () => {
  const harnessPromise = startPersonaSshHarness({
    // The persona REJECTS probes #1/#2 (authentic FortiOS behavior: unknown
    // command → error line) and answers ONLY probe #3 — the probe-fallback
    // cell drives the whole candidate chain.
    commands: { "get system status": FORTIOS_STATUS },
    invalidCommandLine: "Command fail. Return code -3",
    password: HARNESS_PASSWORD,
  });
  const giantPromise = startPersonaSshHarness({
    commands: {
      "show version": () =>
        personaOutput([
          "Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc3)",
        ]) + `noise ${"x".repeat(2 * 1024 * 1024)}\n`,
    },
    invalidCommandLine: "% Invalid input detected at '^' marker.",
    password: HARNESS_PASSWORD,
  });

  afterAll(async () => {
    const [harness, giant] = await Promise.all([harnessPromise, giantPromise]);
    await harness.close();
    await giant.close();
    if (savedEnv.hatch === undefined) delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    else process.env.FAYANMS_PROBE_ALLOW_SPECIAL = savedEnv.hatch;
    if (savedEnv.vaultSecret === undefined) delete process.env[VAULT_ENV_NAME];
    else process.env[VAULT_ENV_NAME] = savedEnv.vaultSecret;
  }, 30_000);

  test("R50-T050 probe fallback — rejections never stop the chain (probe #3 answers)", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    const harness = await harnessPromise;
    expect(harness.hostKeyFingerprint).toBeTruthy();

    const res = await call({
      host: "127.0.0.1",
      credential: credential(harness.port),
      sshHostKeyPin: pin(harness.hostKeyFingerprint),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      command?: string;
      detection?: { vendorKey: string; confidence: string; matchReasons?: string[] };
      dialedAddress?: string;
      targetPolicy?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("get system status");
    expect(body.detection?.vendorKey).toBe("fortinet");
    expect(body.detection?.confidence).toBe("high");
    expect((body.detection?.matchReasons ?? []).length).toBeGreaterThan(0);
    // The probe dialed the VALIDATED address with policy evidence (T022-fu).
    expect(body.dialedAddress).toBe("127.0.0.1");
    expect(body.targetPolicy).toBeDefined();
  });

  test("auth-failure control — the persona's REAL credentials succeed", async () => {
    // The control for the failure variant below: identical call, the vault
    // holds the persona's REAL password → the endpoint succeeds. Any
    // SSH_AUTH_FAILED seen in the failure case is therefore attributable
    // to the wrong secret, not to the harness wiring.
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    const harness = await harnessPromise;
    const res = await call({
      host: "127.0.0.1",
      credential: credential(harness.port),
      sshHostKeyPin: pin(harness.hostKeyFingerprint),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(true);
  });

  test("auth failure — wrong vault secret → SSH_AUTH_FAILED before any command", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    const harness = await harnessPromise;
    // The vault holds a DIFFERENT secret than the persona accepts.
    process.env[VAULT_ENV_NAME] = "definitely-not-the-persona-password";
    const res = await call({
      host: "127.0.0.1",
      credential: credential(harness.port),
      sshHostKeyPin: pin(harness.hostKeyFingerprint),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_AUTH_FAILED");
  });

  test("host-key mismatch — a real foreign pin kills the handshake pre-auth", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    const harness = await harnessPromise;
    const res = await call({
      host: "127.0.0.1",
      credential: credential(harness.port),
      sshHostKeyPin: pin(foreignFingerprint()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_HOSTKEY_MISMATCH");
  });

  test("connect failure — closed loopback port → honest SSH_UNREACHABLE", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    // Bind, read the port, close → the port answers ECONNREFUSED.
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        const value = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => resolve(value));
      });
    });
    expect(port).toBeGreaterThan(0);
    const res = await call({
      host: "127.0.0.1",
      credential: credential(port),
      sshHostKeyPin: pin(foreignFingerprint()), // shape-valid; never reached
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_UNREACHABLE");
  });

  test("output truncation — a ~2 MiB answer yields a BOUNDED detection payload", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    const giant = await giantPromise;
    const res = await call({
      host: "127.0.0.1",
      credential: credential(giant.port),
      sshHostKeyPin: pin(giant.hostKeyFingerprint),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      detection?: { vendorKey: string; evidence: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.detection?.vendorKey).toBe("cisco");
    const evidence = body.detection?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(3);
    const totalBytes = evidence.reduce((sum, line) => sum + line.length, 0);
    expect(totalBytes).toBeLessThanOrEqual(512);
  });

  test("worker-plane loopback refusal — SSH_TARGET_POLICY_REFUSED BEFORE any connection", async () => {
    // The hatch is UNSET here (save/restore guard): the worker refuses the
    // special-class literal itself — defense in depth, no app-plane trust.
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    process.env[VAULT_ENV_NAME] = HARNESS_PASSWORD;
    const harness = await harnessPromise;
    const res = await call({
      host: "127.0.0.1",
      credential: credential(harness.port),
      sshHostKeyPin: pin(harness.hostKeyFingerprint),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_TARGET_POLICY_REFUSED");
  });

  test("vault miss — CREDENTIAL_UNRESOLVED (400) without any dial", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    delete process.env[VAULT_ENV_NAME];
    const harness = await harnessPromise;
    const res = await call({
      host: "127.0.0.1",
      credential: { username: "netadmin", port: harness.port, secretRef: "vault://ssh/r508-missing" },
      sshHostKeyPin: pin(harness.hostKeyFingerprint),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("CREDENTIAL_UNRESOLVED");
  });

  test("timeout behavior — the total budget gates every handshake (worker source pin)", () => {
    // §10.3 timeout behavior: a hermetic black-hole connect is a slow,
    // flaky test — the BEHAVIOR is pinned three ways that never sleep:
    // (1) the candidate loop checks the total budget BEFORE each handshake;
    // (2) every exec carries the per-command timeout;
    // (3) the worker SSH_TIMEOUT/SSH_CONNECT_TIMEOUT strings map into the
    //     closed registry (pinned in r50-detection-contract.test.ts).
    expect(WORKER_INDEX).toContain("DETECT_TOTAL_BUDGET_MS");
    expect(WORKER_INDEX).toContain("Date.now() - startedAt > DETECT_TOTAL_BUDGET_MS");
    expect(WORKER_INDEX).toContain("sshExecText(creds, command, 15000");
    // The registry answers the timeout family with stable codes.
    expect(DETECTION_ERROR_CODES).toContain("SSH_CONNECT_TIMEOUT");
    expect(DETECTION_ERROR_CODES).toContain("DNS_TIMEOUT");
    expect(DETECTION_ERROR_CODES).not.toContain("SSH_TIMEOUT");
  });

  test("the exercised transport codes all map into the closed registry", () => {
    // The WORKER's raw codes are transport strings — the registry holds the
    // MAPPED identities (WORKER_CODE_MAP). Both directions pinned here.
    for (const [workerCode, registryCode] of [
      ["SSH_AUTH_FAILED", "SSH_AUTH_FAILED"],
      ["SSH_UNREACHABLE", "SSH_UNREACHABLE"],
      ["SSH_HOSTKEY_MISMATCH", "HOST_KEY_MISMATCH"],
      ["SSH_TARGET_POLICY_REFUSED", "TARGET_NOT_ALLOWED"],
      ["SSH_TIMEOUT", "SSH_CONNECT_TIMEOUT"],
    ] as const) {
      expect(mapWorkerErrorToDetectionCode(`${workerCode}: exercised by the R50.8 matrix`)).toBe(
        registryCode,
      );
      expect(DETECTION_ERROR_CODES).toContain(registryCode);
    }
    // And the allowlist contract still holds at the matrix level.
    expect(DETECT_COMMANDS).toEqual(["show version", "show system info", "get system status"]);
  });
});
