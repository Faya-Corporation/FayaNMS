import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing (Task 7-a) — node:crypto scrypt, no new dependencies.
 *
 * Stored format:  scrypt$<N>$<salthex>$<hashhex>
 *   - N:       the scrypt work factor (2^14)
 *   - salthex: 16 random bytes, hex-encoded
 *   - hashhex: 64-byte derived key, hex-encoded
 *
 * Plaintext secrets are never stored (audit finding F-12); only this
 * one-way derivation lives in User.passwordHash. Null passwordHash means
 * "login disabled" (the account has no usable credential).
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const SCRYPT_N = 1 << 14; // 16384 — OWASP-recommended interactive work factor
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Derive the storable hash string for a plaintext password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against the stored `scrypt$N$salt$hash`
 * string. Returns false for malformed/legacy values instead of throwing so
 * sign-in always answers with a clean credentials error.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2] ?? "", "hex");
    expected = Buffer.from(parts[3] ?? "", "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: n,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
