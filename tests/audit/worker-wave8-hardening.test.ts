/**
 * Worker wave-8 hardening — fixes from the wave-8 read-only audit (agents
 * 8-fix-a / 8-fix-b), pinned source-level AND behaviorally:
 *
 *   P3 (8-b F1)   configuredPublicKeys() (mini-services/worker/control-auth.ts)
 *                 now accepts ONLY Ed25519 keys — mirroring the boot parser
 *                 (identity-boot.ts) and the app verifier
 *                 (src/lib/auth/service-jwt.ts). A well-formed RSA/EC entry
 *                 fails tight as WORKER_KEYS_MISCONFIGURED at the rotation
 *                 boundary instead of booting cleanly and degrading every
 *                 EdDSA verification to WORKER_TOKEN_INVALID.
 *   P3 (8-b F2)   FAYANMS_SERVICE_JWT_KID is a dead knob: the env TEMPLATES
 *                 carry no such variable and state the deliberate absence —
 *                 service tokens are trusted by signature under configured
 *                 keys; no kid selection exists (kid is inert metadata at
 *                 both verifiers). NOTE: .github/workflows/ci.yml is pinned
 *                 by RT-034 against non-comment diffs and was deliberately
 *                 NOT touched by this wave.
 *   P3 (8-b F3)   the worker HS256 plane accepts the SAME rotation list the
 *                 app accepts (FAYANMS_SERVICE_SECRETS comma list with
 *                 FAYANMS_SERVICE_SECRET primary — the getServiceSecrets
 *                 iteration shape), and verifyControlToken requires a
 *                 non-empty `sub` claim (both minters always set one).
 *   P3 (8-c F-1)  the WebAPI `ca` option is built as
 *                 [pinnedPem, ...tls.rootCertificates]: a bare `ca` REPLACES
 *                 the Node trust store, so the pinned anchor must EXTEND the
 *                 system roots — enrolling one private CA can never
 *                 un-trust every publicly-trusted WebAPI device.
 *   P3 (8-c F-2)  the SNMP_POLL dial plane (pollSnmpV3) now enforces the
 *                 same resolved-address target policy as the SSH/WebAPI
 *                 planes (R51-A1 parity): loopback/link-local/multicast/
 *                 reserved refuse fail-closed BEFORE any vault resolution
 *                 or socket activity; FAYANMS_PROBE_ALLOW_SPECIAL hatch
 *                 parity holds.
 *   P3 (8-c F-3)  the committed harness TLS keypair is inventoried in
 *                 docs/runbooks/secrets-management.md as test material.
 */

import { createHmac, createPrivateKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  configuredPublicKeys,
  verifyControlToken,
} from "../../mini-services/worker/control-auth";
import { assertWorkerServiceIdentity } from "../../mini-services/worker/identity-boot";
import { buildWebApiCa, webApiProbe, WebApiError } from "../../mini-services/worker/webapi-transport";
import { pollSnmpV3, SnmpPollError, type SnmpV3PollProfileReference } from "../../mini-services/worker/snmpv3-poller";
import {
  SFOS_HARNESS_API_KEY,
  startSfosWebApiHarness,
  type SfosWebApiHarness,
} from "../../mini-services/worker/harness/sfos-webapi";

const REPO_ROOT = join(import.meta.dir, "../..");

/* ── shared helpers ─────────────────────────────────────────────────────── */

const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_ENV_FILE",
] as const;

/**
 * Full env sandbox for the service-identity plane. FAYANMS_SERVICE_ENV_FILE
 * is pinned EMPTY during the body (r64 hermeticity semantics) so the
 * sandbox dev .env can never supply material behind the test's back.
 */
async function withServiceEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  process.env.FAYANMS_SERVICE_ENV_FILE = "";
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

function requestWithToken(token: string): Request {
  return new Request("https://worker.test/simulate/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Hand-mint an EdDSA control-plane token the way the app side would. */
function mintEdDSA(privateKeyPem: string, payloadOverrides: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const nowS = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify({
      iss: "fayanms:control",
      sub: "control-plane",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      scopes: ["simulate"],
      ...payloadOverrides,
    }),
  );
  const pem = privateKeyPem.includes("\\n") ? privateKeyPem.replaceAll("\\n", "\n") : privateKeyPem;
  const signature = ed25519Sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(pem))
    .toString("base64url");
  return `${head}.${body}.${signature}`;
}

/** Hand-mint an HS256 control-plane token (the legacy symmetric wire shape). */
function mintHS256(secret: string, payloadOverrides: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const nowS = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify({
      iss: "fayanms:control",
      sub: "control-plane",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      scopes: ["simulate"],
      ...payloadOverrides,
    }),
  );
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const CONTROL = generateKeyPairSync("ed25519");
const CONTROL_PRIV_PEM = CONTROL.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");

const PRIMARY_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const ROTATED_OUT_SECRET = "f0e1d2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0f1e2";

/* ── 8-b F1 — worker-side Ed25519-only key parser ───────────────────────── */

describe("wave8 8-b F1: configuredPublicKeys accepts ONLY Ed25519", () => {
  test("source pin: the runtime parser carries the same type gate as boot + app parsers", () => {
    const runtime = readFileSync(join(REPO_ROOT, "mini-services/worker/control-auth.ts"), "utf8");
    const boot = readFileSync(join(REPO_ROOT, "mini-services/worker/identity-boot.ts"), "utf8");
    const app = readFileSync(join(REPO_ROOT, "src/lib/auth/service-jwt.ts"), "utf8");
    for (const source of [runtime, boot, app]) {
      expect(source).toContain('asymmetricKeyType !== "ed25519"');
    }
  });

  test("a well-formed RSA SPKI entry throws a typed error naming the key kind", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: spki }, () => {
      let caught: unknown = null;
      try {
        configuredPublicKeys();
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as TypeError).message).toContain("not an Ed25519 key");
      expect((caught as TypeError).message).toContain("rsa");
    });
  });

  test("an EC PEM entry fails the same way (rotation list is never poisoned)", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = ec.publicKey.export({ format: "pem", type: "spki" }).toString("utf8");
    withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: pem }, () => {
      expect(() => configuredPublicKeys()).toThrow(/not an Ed25519 key/);
    });
  });

  test("verifyControlToken answers WORKER_KEYS_MISCONFIGURED (not WORKER_TOKEN_INVALID) for a wrong-type key", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: spki }, () => {
      const token = mintEdDSA(CONTROL_PRIV_PEM);
      const result = verifyControlToken(requestWithToken(token), "simulate");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("WORKER_KEYS_MISCONFIGURED");
      expect(result.code).not.toBe("WORKER_TOKEN_INVALID");
    });
  });

  test("the boot assertion refuses the same material (worker fails at BOOT, not at first request)", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() =>
      assertWorkerServiceIdentity({
        publicKeysRaw: spki,
        privateKeyRaw: null,
        serviceSecretRaw: null,
      }),
    ).toThrow(/FAYANMS_SERVICE_PUBLIC_KEYS/);
  });

  test("a genuine Ed25519 entry still parses (no over-refusal)", () => {
    const spki = CONTROL.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: spki }, () => {
      const keys = configuredPublicKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].asymmetricKeyType).toBe("ed25519");
    });
  });
});

/* ── 8-b F3 — HS256 rotation list + non-empty sub ───────────────────────── */

describe("wave8 8-b F3: worker HS256 rotation list and sub requirement", () => {
  test("an HS256 token signed with a FAYANMS_SERVICE_SECRETS rotation entry verifies", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_SECRET: PRIMARY_SECRET,
        FAYANMS_SERVICE_SECRETS: `${ROTATED_OUT_SECRET},stale-third-secret`,
      },
      () => {
        const rotated = mintHS256(ROTATED_OUT_SECRET);
        expect(verifyControlToken(requestWithToken(rotated), "simulate").ok).toBe(true);

        const primary = mintHS256(PRIMARY_SECRET);
        expect(verifyControlToken(requestWithToken(primary), "simulate").ok).toBe(true);
      },
    );
  });

  test("the rotation list works as the ONLY symmetric material (primary removed)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRETS: ROTATED_OUT_SECRET }, () => {
      const token = mintHS256(ROTATED_OUT_SECRET);
      expect(verifyControlToken(requestWithToken(token), "simulate").ok).toBe(true);
    });
  });

  test("a secret outside both knobs still fails WORKER_TOKEN_INVALID", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_SECRET: PRIMARY_SECRET,
        FAYANMS_SERVICE_SECRETS: ROTATED_OUT_SECRET,
      },
      () => {
        const foreign = mintHS256("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2f3e4");
        const result = verifyControlToken(requestWithToken(foreign), "simulate");
        expect(result.ok).toBe(false);
        expect(result.code).toBe("WORKER_TOKEN_INVALID");
      },
    );
  });

  test("a signed token with a MISSING sub claim is rejected WORKER_TOKEN_INVALID", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: PRIMARY_SECRET }, () => {
      const noSub = mintHS256(PRIMARY_SECRET, { sub: undefined });
      const result = verifyControlToken(requestWithToken(noSub), "simulate");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("WORKER_TOKEN_INVALID");
      expect(result.message).toContain("sub");
    });
  });

  test("empty and whitespace-only sub claims fail closed too", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, () => {
      for (const sub of ["", "   "]) {
        const token = mintEdDSA(CONTROL_PRIV_PEM, { sub });
        const result = verifyControlToken(requestWithToken(token), "simulate");
        expect(result.ok).toBe(false);
        expect(result.code).toBe("WORKER_TOKEN_INVALID");
      }
    });
  });

  test("non-string sub (number) fails closed; a real principal still verifies (no regression)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: PRIMARY_SECRET }, () => {
      const numericSub = mintHS256(PRIMARY_SECRET, { sub: 42 });
      expect(verifyControlToken(requestWithToken(numericSub), "simulate").code).toBe("WORKER_TOKEN_INVALID");

      const good = mintHS256(PRIMARY_SECRET, { sub: "control-plane" });
      expect(verifyControlToken(requestWithToken(good), "simulate").ok).toBe(true);
    });
  });
});

/* ── 8-c F-1 — WebAPI ca option extends (never replaces) the trust store ── */

describe("wave8 8-c F-1: buildWebApiCa composes pin + system roots", () => {
  test("no pinned material → the ca option stays undefined (default store, byte-unchanged)", () => {
    expect(buildWebApiCa(undefined)).toBeUndefined();
  });

  test("a pinned anchor is PREPENDED to the Node root store (extend, not replace)", () => {
    const pinned = readFileSync(
      join(REPO_ROOT, "mini-services/worker/harness/tls/sfos-webapi-cert.pem"),
      "utf8",
    );
    const ca = buildWebApiCa(pinned);
    expect(Array.isArray(ca)).toBe(true);
    expect(ca![0]).toBe(pinned);
    // The Mozilla roots ride along — enrolling a private CA cannot
    // un-trust publicly-issued device certificates.
    expect(ca!.length).toBe(rootCertificates.length + 1);
    expect(rootCertificates.length).toBeGreaterThan(100); // Bun implements node:tls.rootCertificates
    for (const entry of ca!.slice(1)) {
      expect(entry.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
    }
  });

  test("source pin: the transport feeds buildWebApiCa into httpsRequest with verification always on", () => {
    const source = readFileSync(join(REPO_ROOT, "mini-services/worker/webapi-transport.ts"), "utf8");
    expect(source).toContain('import { rootCertificates } from "node:tls"');
    expect(source).toContain("buildWebApiCa(pinnedCaPem())");
    expect(source).toContain("[pinnedPem, ...rootCertificates]");
    expect(source).toContain("rejectUnauthorized: true");
    // The old claim ("ca ADDS a worker-pinned anchor") must not come back:
    // Node semantics are override, the module now says EXTENDS and compensates.
    expect(source).not.toContain("ca` ADDS");
    expect(source).toContain("EXTENDS the default store");
  });

  test("behavioral: a self-signed pinned device still verifies over the composed ca array", async () => {
    const harness: SfosWebApiHarness = await startSfosWebApiHarness();
    const savedPem = process.env.FAYANMS_WEBAPI_CA_PEM;
    process.env.FAYANMS_WEBAPI_CA_PEM = readFileSync(
      join(REPO_ROOT, "mini-services/worker/harness/tls/sfos-webapi-cert.pem"),
      "utf8",
    );
    try {
      const probe = await webApiProbe({
        host: "127.0.0.1",
        port: harness.port,
        apiKey: SFOS_HARNESS_API_KEY,
      });
      // The verified GetAuthStatus round-trip succeeding IS the assertion
      // (with the old override-only ca this pin path worked, but the composed
      // array must keep it working — and the unit pin above proves the roots
      // ride along). `negotiated` is best-effort (res.socket.getProtocol is
      // not available on every runtime) and is asserted only when present.
      expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
      if (probe.negotiated !== null) expect(probe.negotiated).toMatch(/^TLS/);
    } finally {
      await harness.stop();
      if (savedPem === undefined) delete process.env.FAYANMS_WEBAPI_CA_PEM;
      else process.env.FAYANMS_WEBAPI_CA_PEM = savedPem;
    }
  });

  test("behavioral: verification stays fail-closed when the device cert is untrusted", async () => {
    const harness: SfosWebApiHarness = await startSfosWebApiHarness();
    const savedPem = process.env.FAYANMS_WEBAPI_CA_PEM;
    delete process.env.FAYANMS_WEBAPI_CA_PEM; // no pin → self-signed harness must be refused
    try {
      let caught: unknown = null;
      try {
        await webApiProbe({ host: "127.0.0.1", port: harness.port, apiKey: SFOS_HARNESS_API_KEY });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WebApiError);
      expect((caught as WebApiError).code).toBe("WEBAPI_TLS_UNTRUSTED");
    } finally {
      await harness.stop();
      if (savedPem === undefined) delete process.env.FAYANMS_WEBAPI_CA_PEM;
      else process.env.FAYANMS_WEBAPI_CA_PEM = savedPem;
    }
  });
});

/* ── 8-c F-2 — SNMP dial plane target-policy guard ──────────────────────── */

const WAVE8_SNMP_ENV_KEYS = [
  "FAYANMS_PROBE_ALLOW_SPECIAL",
  "FAYANMS_VAULT_PROVIDER",
  "FAYANMS_VAULT_WAVE8_GUARD",
] as const;

async function withSnmpEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of WAVE8_SNMP_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of WAVE8_SNMP_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function snmpProfile(overrides: Partial<SnmpV3PollProfileReference> = {}): SnmpV3PollProfileReference {
  return {
    deviceId: "device-wave8",
    hostname: "wave8-probe",
    mgmtIp: "127.0.0.1",
    port: 1161,
    credentialProfileId: "profile-wave8",
    username: "wave8-user",
    secretRef: "vault://wave8/guard",
    engineIdHex: "80001f8880090807060504",
    engineBoots: 1,
    engineTime: 1,
    ...overrides,
  };
}

describe("wave8 8-c F-2: pollSnmpV3 enforces the resolved-address target policy", () => {
  test("source pin: the guard runs BEFORE any vault/credential resolution", () => {
    const source = readFileSync(join(REPO_ROOT, "mini-services/worker/snmpv3-poller.ts"), "utf8");
    expect(source).toContain("resolveTargetForDial(profile.mgmtIp)");
    expect(source).toContain("SNMP_TARGET_FORBIDDEN");
    const guardAt = source.indexOf("resolveTargetForDial(profile.mgmtIp)");
    const vaultAt = source.indexOf("resolveVaultSecret(profile.secretRef)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(vaultAt).toBeGreaterThan(guardAt);
  });

  test("loopback mgmtIp refuses typed BEFORE any socket activity or vault access", async () => {
    await withSnmpEnv({ FAYANMS_VAULT_PROVIDER: "env" }, async () => {
      let dialed = false;
      const transport = async (): Promise<Uint8Array> => {
        dialed = true;
        return new Uint8Array();
      };
      let caught: unknown = null;
      try {
        // secretRef has NO vault entry: if vault resolution ever ran before
        // the guard, this would fail as a VaultError instead.
        await pollSnmpV3(snmpProfile(), { transport, retries: 0 });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SnmpPollError);
      const snmpError = caught as SnmpPollError;
      expect(snmpError.code).toBe("SNMP_TARGET_FORBIDDEN");
      expect(snmpError.message).toContain("loopback");
      expect(snmpError.message).toContain(
        "the target network policy refuses this address class before any credential or connection work",
      );
      expect(dialed).toBe(false);
    });
  });

  test("cloud-metadata shape (169.254.169.254) refuses the same way", async () => {
    await withSnmpEnv({ FAYANMS_VAULT_PROVIDER: "env" }, async () => {
      let dialed = false;
      const transport = async (): Promise<Uint8Array> => {
        dialed = true;
        return new Uint8Array();
      };
      let caught: unknown = null;
      try {
        await pollSnmpV3(snmpProfile({ mgmtIp: "169.254.169.254" }), { transport, retries: 0 });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect((caught as SnmpPollError).code).toBe("SNMP_TARGET_FORBIDDEN");
      expect((caught as SnmpPollError).message).toContain("link-local");
      expect(dialed).toBe(false);
    });
  });

  test("the documented FAYANMS_PROBE_ALLOW_SPECIAL=true lab hatch lets loopback through the guard", async () => {
    await withSnmpEnv(
      { FAYANMS_PROBE_ALLOW_SPECIAL: "true", FAYANMS_VAULT_PROVIDER: "env", FAYANMS_VAULT_WAVE8_GUARD: "wave8-secret" },
      async () => {
        let dialed = false;
        const transport = async (): Promise<Uint8Array> => {
          dialed = true;
          return new Uint8Array([0x30, 0x03, 0x02, 0x01, 0xff]); // garbage → decode fails AFTER the dial
        };
        let caught: unknown = null;
        try {
          await pollSnmpV3(snmpProfile(), { transport, retries: 0, timeoutMs: 200 });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        // The hatch admits the target: the poll REACHED the transport (dial
        // happened) and the failure is the decode, never the target policy.
        expect(dialed).toBe(true);
        expect(caught).not.toBeInstanceOf(SnmpPollError);
        expect((caught as Error).message).not.toContain("target network policy");
      },
    );
  });
});

/* ── 8-b F2 + 8-c F-3 — template/doc pins ───────────────────────────────── */

describe("wave8 8-b F2 / 8-c F-3: env-template and secrets-runbook pins", () => {
  test("FAYANMS_SERVICE_JWT_KID appears in NO env template (dead knob never re-introduced)", () => {
    for (const template of [".env.example", "deploy/oci/env.example"]) {
      const content = readFileSync(join(REPO_ROOT, template), "utf8");
      expect(content.match(/^FAYANMS_SERVICE_JWT_KID=/m)).toBeNull();
    }
  });

  test("both templates state the deliberate absence (trust = signature under configured keys)", () => {
    for (const template of [".env.example", "deploy/oci/env.example"]) {
      const content = readFileSync(join(REPO_ROOT, template), "utf8");
      expect(content).toContain(
        "service tokens are trusted by signature under configured keys; no kid selection exists",
      );
    }
  });

  test("the kid is pinned inert at both verifiers (signature-only trust contract)", () => {
    const app = readFileSync(join(REPO_ROOT, "src/lib/auth/service-jwt.ts"), "utf8");
    expect(app).toContain('"kid" is inert metadata');
    expect(app).toContain("CONFIGURED key, not a token-named identifier");
    const runtime = readFileSync(join(REPO_ROOT, "mini-services/worker/control-auth.ts"), "utf8");
    // The worker verifier reads exactly the two documented knobs — no kid switch.
    expect(runtime).toContain('readRootEnvValue("FAYANMS_SERVICE_PUBLIC_KEYS")');
    expect(runtime).toContain('readRootEnvValue("FAYANMS_SERVICE_SECRETS")');
    expect(runtime).not.toContain("FAYANMS_SERVICE_JWT_KID");
  });

  test("the committed harness TLS keypair is inventoried as test material in the secrets runbook", () => {
    const runbook = readFileSync(join(REPO_ROOT, "docs/runbooks/secrets-management.md"), "utf8");
    expect(runbook).toContain("mini-services/worker/harness/tls/");
    expect(runbook).toContain("sfos-webapi-key.pem");
    expect(runbook).toContain("TEST-ONLY");
    expect(runbook).toContain("CN=localhost");
  });
});
