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

/* ─────────────────────────────────────────────────────────────────────────
 * F-034 phase 1 — role-aware password policy (enforced WHERE PASSWORDS
 * ARE SET: admin user creation, admin PATCH, admin reset; NEVER at login —
 * the login guard owns the authentication plane and a policy check there
 * would lock out accounts whose stored hash predates the policy).
 *
 * Two knobs, both checked on every password SET for every role:
 *   1. Minimum length: 8 for regular roles (unchanged), 12 for the
 *      privileged roles (admin, operator) — the accounts that can push
 *      configurations to network devices.
 *   2. An OFFLINE common-password denylist (embedded, ~300 entries) applied to
 *      ALL roles. The documented production follow-up is SHIPPED and
 *      CONFIG-GATED: the k-anonymity HIBP range-API breach check lives in
 *      src/lib/auth/hibp.ts (FAYANMS_HIBP_MODE — default off so offline
 *      environments stay hermetic; enforce sends only a 5-char SHA-1 prefix,
 *      refuses breached passwords with PASSWORD_BREACHED, and fails closed
 *      with PASSWORD_BREACH_CHECK_UNAVAILABLE when the check itself cannot
 *      complete). The denylist remains the always-on layer: with the mode
 *      off it is the only breach protection beyond the role-aware length.
 * ──────────────────────────────────────────────────────────────────────── */

export const MIN_PASSWORD_LENGTH = 8;
export const PRIVILEGED_PASSWORD_ROLES: readonly string[] = ["admin", "operator"];
export const PRIVILEGED_MIN_PASSWORD_LENGTH = 12;

/** Distinct machine-readable codes so the UI/API can explain each refusal. */
export type PasswordPolicyErrorCode =
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_SHORT_FOR_ROLE"
  | "PASSWORD_DENYLISTED";

export interface PasswordPolicyIssue {
  code: PasswordPolicyErrorCode;
  message: string;
}

/**
 * Offline common-password denylist (F-034 phase 1). Compact ~300-entry list —
 * the classic credential-stuffing corpus head. Comparison is a lowercase
 * exact match (no network calls, no leakage channel).
 */
const PASSWORD_DENYLIST_RAW = `
123456 password 123456789 12345678 12345 qwerty 1234567 111111 12345678910
123123 abc123 1234 password1 iloveyou 000000 qwerty123 zaq12wsx dragon sunshine
princess letmein football monkey welcome admin login abc123456 passw0rd master
hello freedom whatever qazwsx trustno1 batman superman baseball shadow michael
ninja mustang jordan harley andrew ranger buster hunter thomas robert soccer
hockey killer george sexy andy charlie jessica pepper daniel access 123654
summer winter master1 mike ashley bailey passw0rd! nicole chloe sophie amelia
lovely 1q2w3e4r 1qaz2wsx qwertyuiop zxcvbnm asdfgh asdfghjkl qwe123 123qwe
1q2w3e 1234qwer abcd1234 p@ssword p@ssw0rd pass123 pass1234 test test123
testing test1234 guest guest123 root toor administrator changeme default
system welcome1 welcome123 welcome2 welcome3 welcome1! letmein1 letmein2
iloveyou1 iloveyou2 sunlight purple pink blue red orange yellow green black
white flower rose lily daisy jasmine chocolate cookie cupcake muffin donut
pizza burger candy sugar honey ginger spice pepper1 bacon beer wine vodka
whisky whiskey money gold silver diamond platinum richard cash dollar billionaire
gaming gamer xbox playstation nintendo minecraft fortnite twitch steam netflix
youtube google facebook apple samsung amazon twitter tiktok instagram spotify
driver driver1 matrix terminator Rambo rocky apollo hercules zeus thor loki
odin phoenix dragon1 dragon2 tiger lion eagle falcon shark whale dolphin
panda koala monkey1 monkey2 rocket comet star moon sun planet universe galaxy
loveyou heart kiss hug smile happy lucky love beautiful handsome cutie
cutiepie angel devil heaven hell marvel hulk batman1 aquaman flash
superman1 spiderman ironman captain starwars yoda jedi vader skywalker
chewbacca hobbit frodo gandalf pokemon pikachu charizard charmander
bulbasaur squirtle naruto onering princess1 queen king prince crown castle knight armor sword
shield arrow archer hunter1 fisher fisher1 baker baker1 smith smith1
tigger pooh bear snoopy woodstock charliebrown linus lucy schroeder
a123456 a123456789 aa123456 abc@123 abcd1234! qwerty1 qwerty12
computer internet server network firewall router switch printer
office office1 work work1 home home1 mobile phone laptop desktop
`.trim();

export const PASSWORD_DENYLIST: ReadonlySet<string> = new Set(
  PASSWORD_DENYLIST_RAW.split(/\s+/).filter((token) => token.length > 0)
);

export function isPrivilegedPasswordRole(role: string): boolean {
  return PRIVILEGED_PASSWORD_ROLES.includes(role);
}

/**
 * Validate a NEW password for the given role. Returns null when the
 * password is acceptable; otherwise a typed issue with a distinct
 * machine-readable code:
 *   - PASSWORD_TOO_SHORT           — below the 8-char baseline (any role)
 *   - PASSWORD_TOO_SHORT_FOR_ROLE  — privileged role, below the 12-char bar
 *   - PASSWORD_DENYLISTED          — matches the offline common-password list
 * Order: role-aware length first, then the denylist (more specific refusal
 * wins for privileged roles).
 */
export function validatePasswordPolicy(
  password: string,
  role: string
): PasswordPolicyIssue | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      code: "PASSWORD_TOO_SHORT",
      message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (
    isPrivilegedPasswordRole(role) &&
    password.length < PRIVILEGED_MIN_PASSWORD_LENGTH
  ) {
    return {
      code: "PASSWORD_TOO_SHORT_FOR_ROLE",
      message: `passwords for the "${role}" role must be at least ${PRIVILEGED_MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (PASSWORD_DENYLIST.has(password.toLowerCase())) {
    return {
      code: "PASSWORD_DENYLISTED",
      message:
        "password appears in the common-password denylist — choose a less guessable password",
    };
  }
  return null;
}

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
