import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
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

function gcmEncrypt(key: Buffer, plain: string): { ct: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ctB64: string, ivB64: string, tagB64: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Build the encrypted column set for a snapshot write: encrypts rawText and
 * normalizedText (when present) under a fresh per-row DEK wrapped by the
 * master key. Returns exactly the columns the caller spreads into the
 * Prisma create/update, with ciphertext already in rawText/normalizedText.
 */
export function prepareSnapshotColumns(
  rawText: string,
  normalizedText: string | null
): { rawText: string; normalizedText: string | null } & SnapshotEnvelopeColumns {
  const { key, keyId } = masterKeyMaterial();
  const dek = randomBytes(32);

  const raw = gcmEncrypt(dek, rawText);
  const norm = normalizedText !== null ? gcmEncrypt(dek, normalizedText) : null;

  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", key, wrapIv);
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
  };
}

/** Unwrap the row DEK with the master key (authenticates the wrap). */
function unwrapDek(
  wrappedDek: string,
  wrapIv: string,
  wrapTag: string
): Buffer {
  const { key } = masterKeyMaterial();
  const unwrap = createDecipheriv("aes-256-gcm", key, Buffer.from(wrapIv, "base64"));
  unwrap.setAuthTag(Buffer.from(wrapTag, "base64"));
  return Buffer.concat([
    unwrap.update(Buffer.from(wrappedDek, "base64")),
    unwrap.final(),
  ]);
}

/**
 * Decrypt the rawText/normalizedText pair of a fetched snapshot row.
 * Legacy rows (encKeyId null → plaintext) pass through untouched, so this
 * is safe to call unconditionally on any row. Throws on tampered or
 * incomplete envelopes.
 */
export function decryptSnapshotTexts<
  T extends SnapshotEnvelopeRow & { rawText: string; normalizedText?: string | null },
>(row: T): { rawText: string; normalizedText: string | null } {
  if (!row.encKeyId) {
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
  const dek = unwrapDek(row.wrappedDek, row.wrapIv, row.wrapTag);

  const rawText = gcmDecrypt(dek, row.rawText, row.encIv, row.encTag);
  let normalizedText: string | null = null;
  if (row.normalizedText) {
    if (!row.normIv || !row.normTag) {
      throw new Error(
        "Snapshot row has an encrypted normalizedText without normIv/normTag."
      );
    }
    normalizedText = gcmDecrypt(dek, row.normalizedText, row.normIv, row.normTag);
  }
  return { rawText, normalizedText };
}
