import { describe, expect, test } from "bun:test";

import {
  decryptAtRest,
  encryptAtRest,
  webhookSecretAad,
} from "../../src/lib/config/crypto";
import { maskSecret } from "../../src/lib/integrations/webhook-sign";
import { webhookSigningSecret } from "../../src/lib/integrations/webhooks";

/**
 * P1-011 — webhook signing secrets encrypted at rest (external ULTRA
 * audit). The finding: `WebhookEndpoint.secret` stored the raw HMAC key in
 * plaintext, so a database read (dump, replica, backup) exposed the value
 * that forges valid delivery signatures.
 *
 * These pins hold the contract:
 *   1. the stored form is a versioned KEK-encrypted envelope
 *      (enc1:<keyId>:<iv>:<tag>:<ct>) — the plaintext never appears in it;
 *   2. the AAD context binds the ciphertext to its row — a ciphertext
 *      transplanted onto another endpoint fails authentication;
 *   3. legacy plaintext rows (pre-P1-011) decrypt as pass-through so the
 *      migration script and the masked views keep working;
 *   4. a foreign keyId in the envelope fails loudly (key unavailable),
 *      never garbage;
 *   5. the view path masks the DECRYPTED plaintext (last-8 of the real
 *      secret), and the delivery path resolves through the same helper.
 */

const AAD_A = webhookSecretAad("wh-endpoint-a");
const AAD_B = webhookSecretAad("wh-endpoint-b");
const SECRET = "a".repeat(48) + "tail12345";

describe("encryptAtRest / decryptAtRest — envelope contract", () => {
  test("roundtrip returns the exact plaintext", () => {
    const envelope = encryptAtRest(SECRET, AAD_A);
    expect(decryptAtRest(envelope, AAD_A)).toBe(SECRET);
  });

  test("envelope shape: enc1 prefix, keyId, three base64 parts, no plaintext", () => {
    const envelope = encryptAtRest(SECRET, AAD_A);
    expect(envelope.startsWith("enc1:")).toBe(true);
    const parts = envelope.slice("enc1:".length).split(":");
    expect(parts.length).toBe(4);
    expect(parts[0].length).toBeGreaterThan(0); // keyId
    for (const part of parts.slice(1)) {
      expect(part.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(part)).toBe(true); // base64
    }
    expect(envelope.includes(SECRET)).toBe(false);
    expect(envelope.includes(SECRET.slice(-8))).toBe(false);
  });

  test("fresh IV per encryption — two envelopes of the same value differ", () => {
    const a = encryptAtRest(SECRET, AAD_A);
    const b = encryptAtRest(SECRET, AAD_A);
    expect(a).not.toBe(b);
  });

  test("a ciphertext transplanted onto another row fails authentication", () => {
    const envelope = encryptAtRest(SECRET, AAD_A);
    expect(() => decryptAtRest(envelope, AAD_B)).toThrow();
  });

  test("tampered ciphertext fails authentication", () => {
    const envelope = encryptAtRest(SECRET, AAD_A);
    const parts = envelope.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decryptAtRest(parts.join(":"), AAD_A)).toThrow();
  });

  test("legacy plaintext (no enc1 prefix) passes through untouched", () => {
    expect(decryptAtRest(SECRET, AAD_A)).toBe(SECRET);
  });

  test("a foreign keyId fails loudly with a greppable error", () => {
    const forged = `enc1:key-from-nowhere:${Buffer.from("iv").toString("base64")}:${Buffer.from("tag").toString("base64")}:${Buffer.from("ct").toString("base64")}`;
    expect(() => decryptAtRest(forged, AAD_A)).toThrow(/SECRET_AT_REST_KEY_UNAVAILABLE/);
  });

  test("a truncated envelope fails with a greppable error", () => {
    expect(() => decryptAtRest("enc1:only-keyid", AAD_A)).toThrow(
      /SECRET_AT_REST_MALFORMED/
    );
  });
});

describe("webhook view + delivery resolution paths", () => {
  const row = {
    id: "wh-endpoint-a",
    secret: encryptAtRest(SECRET, webhookSecretAad("wh-endpoint-a")),
  };

  test("maskSecret on the DECRYPTED plaintext shows the real secret's tail", () => {
    // The masked view must never leak envelope characters — only the last
    // 8 chars of the actual signing secret.
    const masked = maskSecret(webhookSigningSecret(row));
    expect(masked).toBe(`••••••••${SECRET.slice(-8)}`);
    expect(masked.startsWith("••••••••enc")).toBe(false);
  });

  test("the signing secret resolved for delivery equals the plaintext", () => {
    expect(webhookSigningSecret(row)).toBe(SECRET);
  });

  test("legacy plaintext rows resolve identically (pre-P1-011 data)", () => {
    expect(webhookSigningSecret({ id: "wh-old", secret: SECRET })).toBe(SECRET);
  });
});
