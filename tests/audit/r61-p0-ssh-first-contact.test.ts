import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { HostKeyCaptureSignal, resolveAdapter } from "../../mini-services/worker/adapter-router";
import { VaultError } from "../../mini-services/worker/vault";
import { captureSshHostKey, sshProbe, type SshCredentials } from "../../mini-services/worker/ssh-transport";
import { startIosSshHarness } from "../../mini-services/worker/harness/ios-sshd";
import type { PersonaHarness } from "../../mini-services/worker/harness/persona-sshd";
import { evaluateTargetPolicy as appPolicy } from "../../src/lib/net/target-policy";
import { classifyTargetAddress as workerPolicy } from "../../mini-services/worker/target-policy";

/**
 * R61 — the two P0 findings from the independent re-verification
 * (2026-09-19) of the release tree, with the invariants that close them.
 *
 * P0-1 — credential-free SSH first contact.
 *   BEFORE: enrollment mode resolved the REAL vault secret, built a
 *   credentialed connection, captured the host key through a hostVerifier
 *   that returned TRUE with no pin — password authentication proceeded
 *   BEFORE the operator ever saw the captured fingerprint. The old test
 *   even pinned the flawed behavior ("enrollment mode → adapter resolves").
 *   AFTER: first-contact capture is a credential-FREE connection (no
 *   username/password/privateKey in the connect config by construction)
 *   whose verifier captures the presented key and returns FALSE — the
 *   handshake aborts DURING key exchange, so the SSH protocol never
 *   reaches authentication. Pinned here at three layers:
 *     a. PROTOCOL (the gold pin): against a REAL in-process SSH persona,
 *        the capture yields the persona's true fingerprint and the
 *        server-side auth-attempt counter stays at ZERO; the sanity
 *        credentialed probe afterwards proves the counter works (≥1);
 *     b. ROUTER: enrollment mode throws HostKeyCaptureSignal and never
 *        consults the vault (bogus secretRef would surface VaultError);
 *     c. SOURCE: the legacy `onHostKey` capture mode is removed tree-wide
 *        — a credentialed connection without a pin is structurally
 *        impossible (SshCredentials enforcement).
 *
 * P0-2 — canonicalization-safe IPv6 policy.
 *   BEFORE: textual rules (`v === "::1"`, `startsWith("::ffff:")`) let
 *   equivalent EXPANDED forms (`0:0:0:0:0:0:0:1`, hex-form v4-mapped)
 *   fall through as allowed `ipv6-global` in BOTH target-policy copies.
 *   AFTER: the literal is parsed into its eight 16-bit groups (handling
 *   `::` compression, uppercase, dotted-quad tails) and classified on
 *   GROUP VALUES — one shared vector corpus pins APP and WORKER parity
 *   over every representation class.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PERSONA_USER = "netadmin";
const PERSONA_PASS = "faya-harness";

describe("R61 P0-1: credential-free SSH first-contact capture", () => {
  let harness: PersonaHarness;

  beforeAll(async () => {
    harness = await startIosSshHarness({ username: PERSONA_USER, password: PERSONA_PASS });
  });

  afterAll(async () => {
    await harness.close();
  });

  test("PROTOCOL: capture yields the persona's REAL fingerprint with ZERO auth attempts", async () => {
    expect(harness.hostKeyFingerprint ?? "").toMatch(/^SHA256:/);
    const before = harness.authAttempts;
    const capture = await captureSshHostKey({ host: "127.0.0.1", port: harness.port });
    expect(capture.fingerprint).toBe(harness.hostKeyFingerprint ?? "");
    expect(capture.keyType).toBe(harness.hostKeyType);
    expect(capture.latencyMs).toBeGreaterThanOrEqual(0);
    // THE invariant: the SSH protocol never reached authentication.
    expect(harness.authAttempts).toBe(before);
    expect(harness.authAttempts).toBe(0);
  });

  test("PROTOCOL sanity: a credentialed probe DOES authenticate (counter works, normal path intact)", async () => {
    const creds: SshCredentials = {
      host: "127.0.0.1",
      port: harness.port,
      username: PERSONA_USER,
      password: PERSONA_PASS,
    };
    const probe = await sshProbe(creds, 8000);
    expect(probe.negotiated).toBe("ssh2 (real transport)");
    expect(harness.authAttempts).toBeGreaterThanOrEqual(1);
  });

  test("ROUTER: enrollment mode signals the capture and NEVER consults the vault", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true"; // lab hatch: the persona lives on loopback
    try {
      let captured: HostKeyCaptureSignal | null = null;
      try {
        await resolveAdapter(
          {
            deviceId: "r61-enroll",
            hostname: "R61-ENROLL-01",
            vendor: "cisco",
            managementIp: "127.0.0.1",
            dataSource: "LIVE_SSH",
          },
          // An UNRESOLVABLE secretRef: if the vault were ever touched, the
          // typed VaultError would surface instead of the capture signal.
          { username: "netadmin", port: harness.port, secretRef: "vault://ssh/definitely-not-present" },
          { enrollmentMode: true },
        );
        expect.unreachable("enrollment must signal, never resolve an adapter");
      } catch (e) {
        expect(e).toBeInstanceOf(HostKeyCaptureSignal);
        expect(e).not.toBeInstanceOf(VaultError);
        captured = e as HostKeyCaptureSignal;
      }
      expect(captured).not.toBeNull();
      expect(captured!.capture.fingerprint).toBe(harness.hostKeyFingerprint ?? "");
    } finally {
      delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    }
  });

  test("SOURCE: the legacy onHostKey capture mode is removed tree-wide", () => {
    const router = readFileSync(path.join(REPO_ROOT, "mini-services/worker/adapter-router.ts"), "utf8");
    const transport = readFileSync(path.join(REPO_ROOT, "mini-services/worker/ssh-transport.ts"), "utf8");
    const workerIndex = readFileSync(path.join(REPO_ROOT, "mini-services/worker/index.ts"), "utf8");
    const demo = readFileSync(path.join(REPO_ROOT, "scripts/demo-fleet-probe.ts"), "utf8");
    for (const [name, src] of [
      ["adapter-router", router],
      ["ssh-transport", transport],
      ["worker index", workerIndex],
      ["demo-fleet-probe", demo],
    ] as const) {
      expect(src).not.toContain("onHostKey");
      void name;
    }
    // The capture path carries no credential material: its connect config
    // is built from host + port only (the helper's own text states it).
    expect(transport).toContain("NO password, NO privateKey");
    expect(transport).toContain("captureSshHostKey");
  });
});

describe("R61 P0-2: canonicalization-safe IPv6 target policy (APP ↔ WORKER parity)", () => {
  // {input, expectedClass, expectedAllowed} — every representation class
  // the old textual rules mishandled, plus the representations they got
  // right (zero regression). allowSpecial is OFF (default) for this corpus.
  const VECTORS: Array<[string, string, boolean]> = [
    // loopback — compressed, expanded, and zero-padded forms ALL refused
    ["::1", "loopback", false],
    ["0:0:0:0:0:0:0:1", "loopback", false],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback", false],
    // unspecified — expanded form refused (was: allowed ipv6-global)
    ["::", "unspecified", false],
    ["0:0:0:0:0:0:0:0", "unspecified", false],
    // IPv4-mapped — dotted AND hex forms classify the EMBEDDED v4
    ["::ffff:127.0.0.1", "loopback", false],
    ["0:0:0:0:0:ffff:7f00:1", "loopback", false],
    ["::FFFF:127.0.0.1", "loopback", false],
    ["::ffff:10.0.0.1", "private", true],
    ["0:0:0:0:0:ffff:a00:1", "private", true],
    ["::ffff:169.254.1.1", "link-local", false],
    ["::ffff:192.168.5.5", "private", true],
    // link-local fe80::/10 — compressed, expanded, uppercase, zone-stripped
    ["fe80::1", "link-local", false],
    ["fe80:0:0:0:0:0:0:1", "link-local", false],
    ["FE80:0:0:0:0:0:0:1", "link-local", false],
    ["fe80::1%eth0", "link-local", false],
    // multicast ff00::/8
    ["ff02::1", "multicast", false],
    ["ff02:0:0:0:0:0:0:1", "multicast", false],
    // policy-unchanged classes (global unicast, ULA, doc-range stay allowed)
    ["2001:db8::1", "ipv6-global", true],
    ["2001:db8:0:0:0:0:0:1", "ipv6-global", true],
    ["fd00::1", "ipv6-global", true],
    ["1:2:3:4:5:6:7:8", "ipv6-global", true],
    // unparsable IPv6-ish literals now FAIL CLOSED (was: allowed)
    ["::::", "malformed", false],
    ["1:2:3:4:5:6:7:8:9", "malformed", false],
    ["::zzzz", "malformed", false],
  ];

  test("the shared vector corpus passes on the APP implementation", () => {
    for (const [input, cls, allowed] of VECTORS) {
      const decision = appPolicy(input);
      expect(decision.addressClass).toBe(cls);
      expect(decision.allowed).toBe(allowed);
    }
  });

  test("the SAME corpus passes on the WORKER implementation (parity)", () => {
    for (const [input, cls, allowed] of VECTORS) {
      const decision = workerPolicy(input);
      expect(decision.addressClass).toBe(cls);
      expect(decision.allowed).toBe(allowed);
    }
  });

  test("v4 and hostname behavior is unchanged (zero regression)", () => {
    for (const [input, cls, allowed] of [
      ["127.0.0.1", "loopback", false],
      ["10.20.0.1", "private", true],
      ["169.254.169.254", "link-local", false],
      ["8.8.8.8", "public", true],
      ["example.com", "hostname", true],
    ] as Array<[string, string, boolean]>) {
      const app = appPolicy(input);
      const worker = workerPolicy(input);
      expect(app.addressClass).toBe(cls);
      expect(app.allowed).toBe(allowed);
      expect(worker.addressClass).toBe(cls);
    }
    // Empty input: the APP entry point classifies it honestly ("empty");
    // the WORKER mirror is only ever called with non-empty literals (its
    // entry point routes names to resolution first) — documented asymmetry.
    expect(appPolicy("").addressClass).toBe("empty");
  });
});
