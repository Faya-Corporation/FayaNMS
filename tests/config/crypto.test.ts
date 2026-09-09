import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  decryptSnapshotTexts,
  prepareSnapshotColumns,
  sha256Plaintext,
  snapshotAad,
} from "../../src/lib/config/crypto";

/**
 * Configuration-envelope crypto tests (Phase 19-C / audit CRYPTO-101 §17.1
 * "Crypto" matrix): round trip, tampered ciphertext/tag, wrong context AAD,
 * plaintext digest verification, legacy (AAD-free) compatibility.
 */

const TEST_KEY = "f1e2d3c4b5a6978877665544332211ff0099887766554433221100ffeeddccb0";

function withEnv<T>(fn: () => T): T {
  const previous = process.env.FAYANMS_CONFIG_ENC_KEY;
  process.env.FAYANMS_CONFIG_ENC_KEY = TEST_KEY;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FAYANMS_CONFIG_ENC_KEY;
    else process.env.FAYANMS_CONFIG_ENC_KEY = previous;
  }
}

const RAW = "hostname HQ-Core-RTR-01\n!\ninterface GigabitEthernet0/0/0\n ip address 10.0.0.1 255.255.255.252\n!";
const NORM = "hostname HQ-CORE-RTR-01\ninterface Gi0/0/0\n ip address 10.0.0.1/30";

function aad(deviceId = "dev-1", version = 4): string {
  return snapshotAad({ deviceId, version, configType: "RUNNING", source: "SCHEDULED" });
}

describe("snapshot envelope crypto", () => {
  test("round trip with AAD returns the plaintext and verifies the digest", () => {
    withEnv(() => {
      const columns = prepareSnapshotColumns(RAW, NORM, aad());
      const row = {
        ...columns,
        rawText: columns.rawText,
        sha256: sha256Plaintext(RAW),
      };
      const texts = decryptSnapshotTexts(row);
      expect(texts.rawText).toBe(RAW);
      expect(texts.normalizedText).toBe(NORM);
    });
  });

  test("legacy rows without AAD (pre-19-C) still decrypt", () => {
    withEnv(() => {
      const columns = prepareSnapshotColumns(RAW, null, null);
      const texts = decryptSnapshotTexts({ ...columns, sha256: sha256Plaintext(RAW) });
      expect(texts.rawText).toBe(RAW);
      expect(texts.normalizedText).toBeNull();
    });
  });

  test("legacy plaintext rows (encKeyId null) pass through with digest verification", () => {
    const texts = decryptSnapshotTexts({ rawText: RAW, sha256: sha256Plaintext(RAW) });
    expect(texts.rawText).toBe(RAW);
    expect(() =>
      decryptSnapshotTexts({ rawText: "tampered", sha256: sha256Plaintext(RAW) })
    ).toThrow(/CONFIG_INTEGRITY_FAIL/);
  });

  test("a ciphertext envelope transplanted onto another row fails (AAD binding)", () => {
    withEnv(() => {
      const rowA = prepareSnapshotColumns(RAW, NORM, aad("dev-1", 4));
      // Row B on a DIFFERENT device reuses row A's ciphertext columns.
      const rowB = {
        ...rowA,
        encAad: aad("dev-2", 9),
      };
      expect(() => decryptSnapshotTexts(rowB)).toThrow();
    });
  });

  test("wrong configType/version in the AAD context fails", () => {
    withEnv(() => {
      const columns = prepareSnapshotColumns(RAW, null, aad("dev-1", 4));
      const swapped = {
        ...columns,
        encAad: snapshotAad({
          deviceId: "dev-1",
          version: 5,
          configType: "STARTUP",
          source: "SCHEDULED",
        }),
      };
      expect(() => decryptSnapshotTexts(swapped)).toThrow();
    });
  });

  test("tampered ciphertext is rejected by the GCM tag", () => {
    withEnv(() => {
      const columns = prepareSnapshotColumns(RAW, null, aad());
      const ct = Buffer.from(columns.rawText, "base64");
      ct[0] = ct[0] ^ 0xff;
      expect(() =>
        decryptSnapshotTexts({ ...columns, rawText: ct.toString("base64") })
      ).toThrow();
    });
  });

  test("decrypted plaintext that disagrees with the recorded sha256 is rejected", () => {
    withEnv(() => {
      // Valid envelope, but the stored digest belongs to a DIFFERENT
      // plaintext — i.e. the DB row was manipulated around the crypto.
      const wrongDigest = createHash("sha256").update("other config").digest("hex");
      const columns = prepareSnapshotColumns(RAW, null, aad());
      expect(() =>
        decryptSnapshotTexts({ ...columns, sha256: wrongDigest })
      ).toThrow(/CONFIG_INTEGRITY_FAIL/);
    });
  });

  test("missing or malformed master key fails closed", () => {
    const previous = process.env.FAYANMS_CONFIG_ENC_KEY;
    delete process.env.FAYANMS_CONFIG_ENC_KEY;
    try {
      expect(() => prepareSnapshotColumns(RAW, null, null)).toThrow(/FAYANMS_CONFIG_ENC_KEY/);
    } finally {
      if (previous === undefined) delete process.env.FAYANMS_CONFIG_ENC_KEY;
      else process.env.FAYANMS_CONFIG_ENC_KEY = previous;
    }
  });

  test("sha256Plaintext matches node's sha256", () => {
    expect(sha256Plaintext(RAW)).toBe(createHash("sha256").update(RAW).digest("hex"));
  });
});
