import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";

/**
 * Configuration-snapshot encryption at rest (Phase 19 / audit SEC-003).
 *
 * Envelope construction (one random 256-bit DEK per snapshot row):
 *   1. generate a fresh random DEK;
 *   2. encrypt rawText with AES-256-GCM(DEK, encIv) → encTag;
 *   3. encrypt normalizedText (when present) with the SAME DEK under a
 *      DIFFERENT IV (normIv/normTag) — GCM never reuses an (key, IV) pair;
 *   4. WRAP the DEK with the master key (KEK, FAYANMS_CONFIG_ENC_KEY) under
 *      its own IV + tag (wrapIv/wrapTag);
 *   5. persist base64 ciphertext in rawText/normalizedText + the envelope
 *      columns + keyId. The plaintext never touches the database.
 *
 * GCM auth tags make ANY ciphertext tampering fail decryption loudly.
 *
 * Master-key rotation: generate a new key, bump FAYANMS_CONFIG_ENC_KEY_ID
 * (e.g. "k1" → "k2"), re-run scripts/migrate-encrypt-snapshots.ts — it
 * re-encrypts every row under the new KEK and stamps the new keyId.
 * (Per-keyId keyring is a documented Phase 21 upgrade path.)
 *
 * Failure posture: if FAYANMS_CONFIG_ENC_KEY is absent or malformed, every
 * encrypt/decrypt call THROWS — writers fail their job with a clear error
 * and readers never silently trust ciphertext.
 *
 * Legacy rows (encKeyId = null) store pre-P19 plaintext; decryptSnapshotTexts
 * passes those through verbatim so seeded demo data keeps working until the
 * migration script runs.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

export interface SnapshotEnvelopeColumns {
  encKeyId: string;
  encIv: string;
  encTag: string;
  normIv: string | null;
  normTag: string | null;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
  /** AAD context bound into every GCM cipher of this envelope (may be null
   *  for legacy rows encrypted before Phase 19-C / audit CRYPTO-101). */
  encAad: string | null;
}

export interface SnapshotEnvelopeRow {
  encKeyId?: string | null;
  encIv?: string | null;
  encTag?: string | null;
  normIv?: string | null;
  normTag?: string | null;
  wrappedDek?: string | null;
  wrapIv?: string | null;
  wrapTag?: string | null;
  encAad?: string | null;
  /** sha256 over the PLAINTEXT rawText — verified on every decrypt. */
  sha256?: string | null;
}

/**
 * Canonical AAD context for a snapshot (audit CRYPTO-101 §13.4): binds the
 * ciphertext envelope to the row's identity so a ciphertext swapped between
 * rows/devices/types fails GCM authentication even when keys match.
 * Not secret — stored beside the envelope in encAad so decrypt can set the
 * identical AAD deterministically (and legacy rows stay readable: null AAD).
 */
export function snapshotAad(input: {
  deviceId: string;
  version: number;
  configType: string;
  source: string;
}): string {
  return `v1|${input.deviceId}|${input.version}|${input.configType}|${input.source}`;
}

function masterKeyMaterial(): { key: Buffer; keyId: string } {
  const hex = process.env.FAYANMS_CONFIG_ENC_KEY?.trim() ?? "";
  if (!HEX_64.test(hex)) {
    throw new Error(
      "FAYANMS_CONFIG_ENC_KEY is missing or not 64 hex chars — refusing to encrypt/decrypt configuration at rest (see .env.example)."
    );
  }
  const keyId = process.env.FAYANMS_CONFIG_ENC_KEY_ID?.trim() || "k1";
  return { key: Buffer.from(hex, "hex"), keyId };
}

/** sha256 of the PLAINTEXT — integrity reference recorded before encryption. */
export function sha256Plaintext(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

function gcmEncrypt(key: Buffer, plain: string, aad: string | null): { ct: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ctB64: string, ivB64: string, tagB64: string, aad: string | null): string {
  // authTagLength: 16 pins the expected GCM tag length — a truncated/spoofed
  // shorter tag now fails loudly instead of being accepted (semgrep
  // gcm-no-tag-length hardening; the envelope always stores the full 16-byte
  // getAuthTag() output, so every legacy row stays decryptable).
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Build the encrypted column set for a snapshot write: encrypts rawText and
 * normalizedText (when present) under a fresh per-row DEK wrapped by the
 * master key, binding the whole envelope to `aad` via GCM additional
 * authenticated data when provided (Phase 19-C / audit CRYPTO-101 — a
 * ciphertext transplanted onto another row fails authentication).
 * Returns exactly the columns the caller spreads into the Prisma
 * create/update, with ciphertext already in rawText/normalizedText.
 */
export function prepareSnapshotColumns(
  rawText: string,
  normalizedText: string | null,
  aad: string | null = null
): { rawText: string; normalizedText: string | null } & SnapshotEnvelopeColumns {
  const { key, keyId } = masterKeyMaterial();
  const dek = randomBytes(32);

  const raw = gcmEncrypt(dek, rawText, aad);
  const norm = normalizedText !== null ? gcmEncrypt(dek, normalizedText, aad) : null;

  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", key, wrapIv);
  if (aad) wrap.setAAD(Buffer.from(aad, "utf8"));
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();

  return {
    rawText: raw.ct.toString("base64"),
    normalizedText: norm ? norm.ct.toString("base64") : null,
    encKeyId: keyId,
    encIv: raw.iv.toString("base64"),
    encTag: raw.tag.toString("base64"),
    normIv: norm ? norm.iv.toString("base64") : null,
    normTag: norm ? norm.tag.toString("base64") : null,
    wrappedDek: wrappedDek.toString("base64"),
    wrapIv: wrapIv.toString("base64"),
    wrapTag: wrapTag.toString("base64"),
    encAad: aad,
  };
}

/** Unwrap the row DEK with the master key (authenticates the wrap). */
function unwrapDek(
  wrappedDek: string,
  wrapIv: string,
  wrapTag: string,
  aad: string | null
): Buffer {
  const { key } = masterKeyMaterial();
  // authTagLength: 16 — same GCM tag-length pin as gcmDecrypt (see above).
  const unwrap = createDecipheriv("aes-256-gcm", key, Buffer.from(wrapIv, "base64"), {
    authTagLength: 16,
  });
  unwrap.setAuthTag(Buffer.from(wrapTag, "base64"));
  if (aad) unwrap.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([
    unwrap.update(Buffer.from(wrappedDek, "base64")),
    unwrap.final(),
  ]);
}

/** Timing-safe hex-digest comparison (equal length guaranteed by sha256). */
function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Decrypt the rawText/normalizedText pair of a fetched snapshot row.
 * Legacy rows (encKeyId null → plaintext) pass through untouched, so this
 * is safe to call unconditionally on any row. Throws on tampered or
 * incomplete envelopes.
 *
 * Phase 19-C integrity hardening (audit CRYPTO-101):
 *   1. AAD binding — rows carrying encAad have it set as GCM additional
 *      authenticated data on EVERY cipher (texts + DEK wrap); a ciphertext
 *      envelope transplanted from another row/device/type fails loudly.
 *      Rows without encAad (pre-19-C) decrypt AAD-free, unchanged.
 *   2. Plaintext digest verification — when the row carries sha256, the
 *      decrypted rawText is re-hashed and compared (timing-safe) BEFORE
 *      the value is returned; a mismatch throws CONFIG_INTEGRITY_FAIL.
 */
export function decryptSnapshotTexts<
  T extends SnapshotEnvelopeRow & { rawText: string; normalizedText?: string | null },
>(row: T): { rawText: string; normalizedText: string | null } {
  if (!row.encKeyId) {
    verifyPlaintextDigest(row.rawText, row.sha256 ?? null);
    return { rawText: row.rawText, normalizedText: row.normalizedText ?? null };
  }
  if (
    !row.encIv ||
    !row.encTag ||
    !row.wrappedDek ||
    !row.wrapIv ||
    !row.wrapTag
  ) {
    throw new Error(
      `Snapshot row has an incomplete encryption envelope (encKeyId=${row.encKeyId}).`
    );
  }
  const aad = row.encAad ?? null;
  const dek = unwrapDek(row.wrappedDek, row.wrapIv, row.wrapTag, aad);

  const rawText = gcmDecrypt(dek, row.rawText, row.encIv, row.encTag, aad);
  verifyPlaintextDigest(rawText, row.sha256 ?? null);
  let normalizedText: string | null = null;
  if (row.normalizedText) {
    if (!row.normIv || !row.normTag) {
      throw new Error(
        "Snapshot row has an encrypted normalizedText without normIv/normTag."
      );
    }
    normalizedText = gcmDecrypt(dek, row.normalizedText, row.normIv, row.normTag, aad);
  }
  return { rawText, normalizedText };
}

/** Throw CONFIG_INTEGRITY_FAIL when the stored digest disagrees with the plaintext. */
function verifyPlaintextDigest(rawText: string, expected: string | null): void {
  if (!expected) return;
  const actual = sha256Plaintext(rawText);
  if (!digestEquals(actual, expected)) {
    throw new Error(
      "CONFIG_INTEGRITY_FAIL — decrypted configuration does not match its recorded sha256 digest (possible ciphertext substitution)."
    );
  }
}

/* ───────────────────────────────────────────────────────────────────────
 * Small-value secrets at rest (P1-011 — external ULTRA audit).
 *
 * The snapshot envelope above is DEK-per-row (proportionate for large
 * configuration texts). Short high-entropy secrets (webhook HMAC signing
 * keys) use a DIRECT AES-256-GCM encryption under the master key with a
 * fresh IV per value and AAD binding the ciphertext to its row: the stored
 * form is the versioned envelope string
 *
 *   enc1:<keyId>:<ivB64>:<tagB64>:<ctB64>
 *
 * stored in the SAME column the plaintext used to occupy — no schema
 * change, and values without the prefix are treated as legacy plaintext
 * (pass-through decrypt), mirroring the snapshot legacy policy, until the
 * migration script (scripts/encrypt-webhook-secrets.ts) re-encrypts them.
 *
 * AAD binding means a ciphertext transplanted onto another row fails GCM
 * authentication even when keys match; a keyId in the envelope that the
 * current deployment does not hold fails loudly
 * (SECRET_AT_REST_KEY_UNAVAILABLE) instead of decrypting garbage.
 * ───────────────────────────────────────────────────────────────────── */

const AT_REST_PREFIX = "enc1:";

/** AAD context for a webhook endpoint signing secret. */
export function webhookSecretAad(endpointId: string): string {
  return `webhook-secret|v1|${endpointId}`;
}

/**
 * Encrypt a short secret at rest under the master key (AES-256-GCM, fresh
 * IV, AAD-bound). Returns the versioned envelope for the secret column.
 */
export function encryptAtRest(plain: string, aad: string): string {
  const { key, keyId } = masterKeyMaterial();
  const { ct, iv, tag } = gcmEncrypt(key, plain, aad);
  return `${AT_REST_PREFIX}${keyId}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt an at-rest secret. Values WITHOUT the enc1: prefix are legacy
 * plaintext and pass through untouched (same legacy policy as snapshots).
 * Throws on tampered ciphertext, a mismatched AAD context (transplanted
 * ciphertext), or an envelope encrypted under an unavailable keyId.
 */
export function decryptAtRest(stored: string, aad: string): string {
  if (!stored.startsWith(AT_REST_PREFIX)) return stored; // legacy plaintext
  const [keyId, ivB64, tagB64, ctB64] = stored.slice(AT_REST_PREFIX.length).split(":");
  if (!keyId || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("SECRET_AT_REST_MALFORMED — incomplete encryption envelope.");
  }
  const { key, keyId: currentKeyId } = masterKeyMaterial();
  if (keyId !== currentKeyId) {
    throw new Error(
      `SECRET_AT_REST_KEY_UNAVAILABLE — envelope was encrypted under key "${keyId}" but this deployment holds "${currentKeyId}".`
    );
  }
  return gcmDecrypt(key, ctB64, ivB64, tagB64, aad);
}
