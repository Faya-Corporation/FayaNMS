import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

import { readRootEnvValue } from "../../mini-services/worker/control-auth";
import {
  resetServiceTokenCache,
  serviceAuthToken,
} from "../../mini-services/worker/service-token";

/**
 * R64 — unit-gate hermeticity: the sandbox dev .env must not leak key
 * material into in-process mint/verify round trips.
 *
 * Found during the R64 independent re-execution of the R61–R63 gates: the
 * repo-root `.env` (gitignored, absent in CI) had been regenerated with a
 * fresh EdDSA identity AFTER the last recorded green gate run. `bun test`
 * auto-loads it, and the worker's env readers fell back to reading the
 * FILE whenever `process.env` was empty/absent — so a freshly minted
 * app-side private key poisoned every in-process worker-plane pin (18–29
 * false failures on a byte-identical green tree; a future operator would
 * rightly distrust the suite). The hardening: an EXPLICIT EMPTY
 * process.env value is now authoritative — it suppresses the .env-file
 * fallback and reads as "unconfigured". Processes that never set the
 * variable (live worker via bun's env load, CI) are unaffected; the gate
 * env pins the two EdDSA variables to "" to opt the whole suite out of
 * the file fallback deterministically (CI topology reproduced, .env or
 * not — no stash dance required).
 *
 * Pins:
 *   A  behavioral — explicit-empty suppression: with the variable set to
 *      "" and only the shared secret configured, the worker token is
 *      minted as HS256 even when a root .env carries a private key.
 *   B  behavioral — the file fallback itself is INTACT: an UNSET variable
 *      + FAYANMS_SERVICE_ENV_FILE naming a FIXTURE file (never the dev
 *      .env — hermetic, CI-compatible) → the mint is still EdDSA (the
 *      live-worker convenience is preserved, not removed).
 *   C  SOURCE — both env-reader copies consult process.env BEFORE the
 *      file and treat explicit-empty as deliberate unset; identity-boot
 *      uses the canonical control-auth reader (the boot path inherits
 *      the hardening).
 *   D  SOURCE — the gate env contract (the EdDSA variables and the
 *      ENV_FILE knob pinned empty) is documented in the R64 evidence doc.
 *   E  behavioral — knob completion: ENV_FILE explicit-empty keeps
 *      DELETED service variables unconfigured even with a dev .env on
 *      disk (withServiceEnv compatibility) → HS256 mint under the
 *      shared secret.
 */

const saved: Record<string, string | undefined> = {
  FAYANMS_SERVICE_PRIVATE_KEY: process.env.FAYANMS_SERVICE_PRIVATE_KEY,
  FAYANMS_SERVICE_PUBLIC_KEYS: process.env.FAYANMS_SERVICE_PUBLIC_KEYS,
  FAYANMS_SERVICE_SECRET: process.env.FAYANMS_SERVICE_SECRET,
  FAYANMS_SERVICE_ENV_FILE: process.env.FAYANMS_SERVICE_ENV_FILE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServiceTokenCache();
}

const GATE_SECRET =
  "6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03";

describe("R64 — unit-gate hermeticity (explicit-empty env suppression)", () => {
  test("A: explicit-empty FAYANMS_SERVICE_PRIVATE_KEY suppresses the root-.env fallback — the worker mint falls back to HS256 under the shared secret", () => {
    try {
      process.env.FAYANMS_SERVICE_PRIVATE_KEY = ""; // the R64 knob
      process.env.FAYANMS_SERVICE_SECRET = GATE_SECRET;
      delete process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
      resetServiceTokenCache();
      const token = serviceAuthToken();
      const header = JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
      ) as { alg: string };
      // EdDSA would prove the .env file leaked through; the empty knob
      // must read as "unconfigured" and force the legacy HS256 plane.
      expect(header.alg).toBe("HS256");
      // readRootEnvValue agrees directly (no value, no file fallback).
      expect(readRootEnvValue("FAYANMS_SERVICE_PRIVATE_KEY")).toBeNull();
    } finally {
      restoreEnv();
    }
  });

  test("B: the file fallback itself is intact — FAYANMS_SERVICE_ENV_FILE pointing at a FIXTURE file supplies key material to an otherwise-unconfigured process (live-worker convenience preserved, hermetically)", () => {
    let fixtureDir: string | null = null;
    try {
      // A throwaway identity + a fixture env file standing in for the dev
      // .env — the fallback path is exercised WITHOUT touching the real
      // one (works identically in CI and the sandbox).
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString("utf8")
        .trim()
        .replaceAll("\n", "\\n");
      fixtureDir = mkdtempSync(join("/tmp", "r64-fixture-"));
      const fixture = join(fixtureDir, "fixture.env");
      writeFileSync(fixture, `FAYANMS_SERVICE_PRIVATE_KEY="${pem}"\n`);
      delete process.env.FAYANMS_SERVICE_PRIVATE_KEY; // UNSET — the fallback scenario
      delete process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
      process.env.FAYANMS_SERVICE_SECRET = GATE_SECRET;
      process.env.FAYANMS_SERVICE_ENV_FILE = fixture; // the knob NAMES the file
      resetServiceTokenCache();
      const token = serviceAuthToken();
      const header = JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
      ) as { alg: string };
      expect(header.alg).toBe("EdDSA");
      expect(readRootEnvValue("FAYANMS_SERVICE_PRIVATE_KEY")).toBe(pem);
    } finally {
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
      restoreEnv();
    }
  });

  test("E: knob completion — FAYANMS_SERVICE_ENV_FILE explicit-empty keeps DELETED service variables unconfigured even with a dev .env on disk (withServiceEnv compatibility)", () => {
    try {
      delete process.env.FAYANMS_SERVICE_PRIVATE_KEY; // withServiceEnv semantics
      process.env.FAYANMS_SERVICE_ENV_FILE = ""; // the gate's hermetic pin
      expect(readRootEnvValue("FAYANMS_SERVICE_PRIVATE_KEY")).toBeNull();
      // And the worker mint falls back to HS256 under the shared secret.
      process.env.FAYANMS_SERVICE_SECRET = GATE_SECRET;
      resetServiceTokenCache();
      const token = serviceAuthToken();
      const header = JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
      ) as { alg: string };
      expect(header.alg).toBe("HS256");
    } finally {
      restoreEnv();
    }
  });

  test("C: SOURCE — both env-reader copies put process.env first with explicit-empty suppression; identity-boot rides the canonical reader", () => {
    const controlAuth = readFileSync(
      "mini-services/worker/control-auth.ts",
      "utf8",
    );
    const serviceToken = readFileSync(
      "mini-services/worker/service-token.ts",
      "utf8",
    );
    const identityBoot = readFileSync(
      "mini-services/worker/identity-boot.ts",
      "utf8",
    );
    for (const [name, src] of [
      ["control-auth.ts", controlAuth],
      ["service-token.ts", serviceToken],
    ] as const) {
      // process.env is consulted as a STRING PRESENCE check (the empty
      // value reaches the suppression branch), then explicit-empty is
      // documented as deliberate unset.
      expect(
        src.includes('if (typeof fromProcess === "string") {'),
        `${name}: process.env presence check`,
      ).toBe(true);
      expect(
        src.includes("explicit empty = deliberate unset"),
        `${name}: suppression marker`,
      ).toBe(true);
      expect(
        src.includes("R64 hermeticity hardening"),
        `${name}: rationale comment`,
      ).toBe(true);
    }
    expect(
      identityBoot.includes('from "./control-auth"'),
      "identity-boot imports the canonical reader",
    ).toBe(true);
  });

  test("D: SOURCE — the gate env contract (EdDSA variables pinned empty) is documented in the R64 evidence doc", () => {
    const doc = readFileSync(
      "docs/audits/FayaNMS-R64-Gate-Reexecution-and-Hermeticity-2026-09-19.md",
      "utf8",
    );
    expect(doc).toContain("FAYANMS_SERVICE_PRIVATE_KEY=");
    expect(doc).toContain("FAYANMS_SERVICE_PUBLIC_KEYS=");
    expect(doc).toContain("967");
    expect(doc).toContain("8,214");
  });
});
