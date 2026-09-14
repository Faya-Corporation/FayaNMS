import { describe, expect, test } from "bun:test";

import {
  HOSTKEY_FINGERPRINT_RE,
  HostKeyPolicyError,
  parseHostKeyPin,
  parseTargetCredential,
  resolveAdapter,
} from "../../mini-services/worker/adapter-router";
import {
  computeHostKeyFingerprint,
  parseHostKeyType,
} from "../../mini-services/worker/ssh-transport";

/**
 * SAFE-001 (production-safety sprint, audit P0-001) — SSH host-key
 * enrollment + pinning. The external ULTRA audit: ssh-transport connect()
 * had no hostVerifier — the worker would authenticate against ANY server
 * presenting the endpoint's address, so a MITM could harvest device
 * credentials. This suite pins the request-level policy surface:
 *   - the fingerprint format contract (OpenSSH SHA256, no padding);
 *   - the deterministic fingerprint derivation the transport enforces;
 *   - pin payload parsing (malformed pins fail CLOSED, never ignored);
 *   - unpinned LIVE routing refused (SSH_HOSTKEY_UNENROLLED) while the
 *     simulator plane and enrollment-mode routing stay unaffected.
 * The transport-level enforcement (pre-auth verification, mismatch →
 * SSH_HOSTKEY_MISMATCH) is protocol-certified per flavor in certify.ts
 * against REAL persona host keys.
 */

const VALID_FP = "SHA256:oZFPeF/+vk9aOqGvPbG7rjJwp6PQES9ik1JAknq41uc";

describe("SAFE-001 — host-key fingerprint format", () => {
  test("accepts canonical OpenSSH SHA256 fingerprints", () => {
    expect(HOSTKEY_FINGERPRINT_RE.test(VALID_FP)).toBe(true);
    expect(HOSTKEY_FINGERPRINT_RE.test(`SHA256:${"a".repeat(43)}`)).toBe(true);
    expect(HOSTKEY_FINGERPRINT_RE.test(`SHA256:${"a".repeat(40)}+/9`)).toBe(true);
  });

  test("rejects missing prefix, wrong length, padding, bad charset", () => {
    expect(HOSTKEY_FINGERPRINT_RE.test("oZFPeF/+vk9aOqGvPbG7rjJwp6PQES9ik1JAknq41uc")).toBe(false);
    expect(HOSTKEY_FINGERPRINT_RE.test("MD5:aa:bb:cc")).toBe(false);
    expect(HOSTKEY_FINGERPRINT_RE.test("SHA256:short")).toBe(false);
    expect(HOSTKEY_FINGERPRINT_RE.test("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false
    ); // 44 chars (padding not stripped)
    expect(HOSTKEY_FINGERPRINT_RE.test("SHA256:@@@@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false
    );
    expect(HOSTKEY_FINGERPRINT_RE.test("")).toBe(false);
  });
});

describe("SAFE-001 — fingerprint derivation (transport enforcement input)", () => {
  test("deterministic SHA256 vector (padding stripped)", () => {
    const blob = Buffer.from("faya-safe001-test-blob");
    expect(computeHostKeyFingerprint(blob)).toBe(VALID_FP);
  });

  test("derivation is exactly sha256 → base64 → strip '='", () => {
    const blob = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const fp = computeHostKeyFingerprint(blob);
    expect(fp.startsWith("SHA256:")).toBe(true);
    expect(fp.slice("SHA256:".length)).toHaveLength(43);
    expect(fp.endsWith("=")).toBe(false);
  });
});

describe("SAFE-001 — key-type extraction from the wire blob", () => {
  test("reads the first length-prefixed string field", () => {
    const name = Buffer.from("ssh-ed25519");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(name.length, 0);
    const blob = Buffer.concat([len, name, Buffer.from([0x01, 0x02, 0x03])]);
    expect(parseHostKeyType(blob)).toBe("ssh-ed25519");
  });

  test("malformed blobs degrade to unknown (never throw)", () => {
    expect(parseHostKeyType(Buffer.alloc(0))).toBe("unknown");
    expect(parseHostKeyType(Buffer.from([0, 0, 0, 0]))).toBe("unknown");
    expect(parseHostKeyType(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe("unknown");
  });
});

describe("SAFE-001 — pin payload parsing (fail-closed)", () => {
  test("absent pin → null (the worker then refuses live connections)", () => {
    expect(parseHostKeyPin(null)).toBeNull();
    expect(parseHostKeyPin(undefined)).toBeNull();
  });

  test("valid pin block → the fingerprint string", () => {
    expect(parseHostKeyPin({ fingerprint: VALID_FP })).toBe(VALID_FP);
    expect(parseHostKeyPin({ fingerprint: `  ${VALID_FP}  ` })).toBe(VALID_FP);
  });

  test("malformed pins throw SSH_HOSTKEY_PIN_INVALID — never silently ignored", () => {
    const bad: unknown[] = [
      "SHA256:string-not-object",
      42,
      {},
      { fingerprint: "" },
      { fingerprint: "not-a-fingerprint" },
      { fingerprint: "SHA256:short" },
      { fingerprint: VALID_FP.slice(0, -1) }, // 42 chars
      { fingerprint: VALID_FP + "=" }, // padding kept
      { fingerprint: null },
    ];
    for (const raw of bad) {
      try {
        parseHostKeyPin(raw);
        expect.unreachable(`expected SSH_HOSTKEY_PIN_INVALID for ${JSON.stringify(raw)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(HostKeyPolicyError);
        expect((e as HostKeyPolicyError).code).toBe("SSH_HOSTKEY_PIN_INVALID");
      }
    }
  });
});

describe("SAFE-001 — routing policy (fail-closed before any connection)", () => {
  const target = {
    deviceId: "dev-1",
    hostname: "HQ-CORE-01",
    vendor: "cisco",
    managementIp: "10.20.0.1",
    dataSource: "LIVE_SSH",
  };
  const credential = parseTargetCredential({
    username: "netadmin",
    port: 22,
    secretRef: "vault://ssh/guard-test",
  });
  // Vault entry for the credential reference (worker-side resolution).
  process.env.FAYANMS_VAULT_SSH_GUARD_TEST = "guard-secret";

  test("LIVE without a pin → SSH_HOSTKEY_UNENROLLED", async () => {
    try {
      await resolveAdapter(target, credential);
      expect.unreachable("expected SSH_HOSTKEY_UNENROLLED");
    } catch (e) {
      expect(e).toBeInstanceOf(HostKeyPolicyError);
      expect((e as HostKeyPolicyError).code).toBe("SSH_HOSTKEY_UNENROLLED");
    }
  });

  test("LIVE without a pin but in enrollment mode → adapter resolves (audited probe only)", async () => {
    const adapter = await resolveAdapter(target, credential, { enrollmentMode: true });
    expect(adapter.adapter).toBe("cisco-ios-live");
  });

  test("LIVE with a valid pin → adapter resolves and rides the pin", async () => {
    const adapter = await resolveAdapter(target, credential, { hostKeyPin: VALID_FP });
    expect(adapter.adapter).toBe("cisco-ios-live");
    expect(adapter.capabilities).toContain("connect");
  });

  test("LIVE with a malformed pin → SSH_HOSTKEY_PIN_INVALID (no fallback)", async () => {
    try {
      await resolveAdapter(target, credential, { hostKeyPin: "garbage" });
      expect.unreachable("expected SSH_HOSTKEY_PIN_INVALID");
    } catch (e) {
      expect((e as HostKeyPolicyError).code).toBe("SSH_HOSTKEY_PIN_INVALID");
    }
  });

  test("SIMULATOR routing ignores the pin entirely (zero regression)", async () => {
    const sim = await resolveAdapter(
      { deviceId: "sim-1", hostname: "sim-01", vendor: "cisco" },
      null,
      { hostKeyPin: VALID_FP }
    );
    expect(sim.adapter).toBe("cisco-ios");
  });
});
