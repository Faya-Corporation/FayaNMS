/**
 * Pure service-JWT verification core (SAFE-002 refactor; P1-007 asymmetric
 * service identity).
 *
 * Extracted from src/lib/auth/service-auth.ts so the proxy gate
 * (src/proxy.ts) can verify the machine plane WITHOUT importing the
 * heavyweight session module (which instantiates the Prisma client).
 * This module imports ONLY node:crypto — safe for the middleware/proxy
 * module graph, and unit-testable in isolation.
 *
 * Token contract (Phase 19 / audit SEC-002; P1-007 ULTRA audit):
 *   header  { alg: "HS256" | "EdDSA", typ: "JWT" }
 *   payload { iss, sub, aud: "fayanms:internal", iat, exp, jti, scopes }
 *
 * P1-007 (ULTRA audit: "HS256 shared-secret only; holder of the secret can
 * mint any token"): the machine plane now supports ASYMMETRIC service
 * identity. Ed25519 (alg "EdDSA") tokens are verified against a public-key
 * set, so verifiers hold NO minting capability — whoever holds only public
 * material can authenticate but can never mint. HS256 remains accepted
 * while the symmetric secret is still configured, which makes the rotation
 * a two-phase, flag-free operation:
 *
 *   Phase 1 (introduce): set FAYANMS_SERVICE_PUBLIC_KEYS on every verifier
 *     and FAYANMS_SERVICE_PRIVATE_KEY on every minter. Both algorithms are
 *     accepted; minters PREFER the private key and emit EdDSA immediately.
 *   Phase 2 (complete): remove FAYANMS_SERVICE_SECRET(S) from every
 *     process. HS256 becomes structurally impossible (SERVICE_ALG_REJECTED)
 *     and the shared-secret holder's minting power is gone.
 *
 * Identity modes (TASK-SVC-001-A — explicit, deterministic, derived ONLY
 * from configured server material, never from token-supplied metadata;
 * see src/lib/startup/security-policy.ts for the startup half):
 *
 *   eddsa-only    FAYANMS_SERVICE_PUBLIC_KEYS configured, NO symmetric
 *                 material anywhere. The RECOMMENDED production end state:
 *                 HS256 is structurally impossible (SERVICE_ALG_REJECTED),
 *                 so a leaked shared secret can never mint again.
 *   dual          Public keys AND shared secret configured — the documented
 *                 P1-007 rotation Phase 1 (time-boxed migration). Both
 *                 algorithms verify; minters prefer EdDSA.
 *   hs256-legacy  Shared secret only. Deprecated; symmetric strength is
 *                 enforced by the startup policy in this mode.
 *
 * The JWT header can never broaden the server's configured trust policy:
 * an algorithm whose plane is not configured is rejected before any key
 * resolution, "kid" is inert metadata (trust = a signature under a
 * CONFIGURED key, not a token-named identifier), and only Ed25519 key
 * material is accepted on the asymmetric plane (wrong-type keys fail
 * tight as SERVICE_KEYS_MISCONFIGURED, never silently skipped).
 *
 * Verification enforces, in order:
 *   1. well-formed compact JWT with alg "HS256" or "EdDSA" (typ "JWT");
 *   2. the presented alg's trust plane is CONFIGURED (EdDSA needs
 *      FAYANMS_SERVICE_PUBLIC_KEYS; HS256 needs FAYANMS_SERVICE_SECRET(S))
 *      — otherwise SERVICE_ALG_REJECTED, never a silent fallthrough;
 *   3. signature valid: Ed25519 (crypto.verify against ANY configured
 *      public key — the rotation list) or HMAC-SHA256 against ANY accepted
 *      secret (current + rotation list, timing-safe compare);
 *   4. audience exactly "fayanms:internal";
 *   5. not expired / not issued in the future (± 30 s clock skew);
 *   6. iss/sub present and issuer allowlisted (a shared symmetric secret
 *      alone would let any holder mint tokens with arbitrary identities —
 *      with asymmetric keys the issuer allowlist is defense in depth).
 *
 * Key material encoding (operator contract, see scripts/generate-service-
 * keys.ts):
 *   FAYANMS_SERVICE_PUBLIC_KEYS — comma-separated Ed25519 public keys in
 *     SPKI DER base64 (the generator's default output); a full PEM is also
 *     tolerated (may carry escaped \n newlines).
 *   FAYANMS_SERVICE_PRIVATE_KEY — PKCS8 PEM (escaped \n newlines allowed
 *     for single-line env values).
 *   A MALFORMED configured key is a misconfiguration, not a soft skip:
 *   verification refuses with SERVICE_KEYS_MISCONFIGURED (fail-tight — a
 *   silently-dropped rotated key would fake trust, not weaken it).
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export const SERVICE_AUDIENCE = "fayanms:internal";
const CLOCK_SKEW_S = 30;

/**
 * Issuer allowlist (Phase 19-C / audit SVC-101 §11.3). Override with
 * FAYANMS_SERVICE_ISSUERS (comma list) when additional machine identities
 * are introduced; each issuer must still present a valid signature under a
 * configured secret (HS256) or public key (EdDSA).
 */
export function getServiceIssuers(): string[] {
  const raw = process.env.FAYANMS_SERVICE_ISSUERS?.trim();
  const configured = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  return configured.length > 0 ? configured : ["fayanms:worker"];
}

/**
 * All accepted secrets: the current one plus any rotation-window values.
 * Env-parametrized so the startup policy (TASK-SVC-001-A) derives modes
 * from the EXACT same semantics the runtime verifier uses.
 */
export function getServiceSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets: string[] = [];
  const current = env.FAYANMS_SERVICE_SECRET?.trim();
  if (current) secrets.push(current);
  for (const raw of (env.FAYANMS_SERVICE_SECRETS ?? "").split(",")) {
    const value = raw.trim();
    if (value && !secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

/** Tolerate escaped newlines in single-line env values (PEM material). */
function unescapePem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

/**
 * The configured Ed25519 PUBLIC keys (rotation list). Parsed once per raw
 * configuration value; a malformed entry throws — callers map that to
 * SERVICE_KEYS_MISCONFIGURED (fail-tight, never silently dropped).
 *
 * TASK-SVC-001-A hardening (§7/§14): ONLY Ed25519 keys are accepted — a
 * wrong-type key (e.g. RSA) fails tight instead of poisoning the rotation
 * list — and duplicate entries are deduplicated by SPKI DER bytes so an
 * ambiguous list cannot exist.
 */
export function parseServicePublicKeys(raw: string): KeyObject[] {
  const keys: KeyObject[] = [];
  const seen = new Set<string>();
  const push = (key: KeyObject): void => {
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("service public key is not an Ed25519 key");
    }
    const der = key.export({ format: "der", type: "spki" }).toString("base64");
    if (!seen.has(der)) {
      seen.add(der);
      keys.push(key);
    }
  };
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    if (entry.startsWith("-----BEGIN")) {
      push(createPublicKey(unescapePem(entry)));
      continue;
    }
    push(
      createPublicKey({
        key: Buffer.from(entry, "base64"),
        format: "der",
        type: "spki",
      }),
    );
  }
  return keys;
}

let publicKeysCache: { raw: string; keys: KeyObject[] } | null = null;

/**
 * Configured Ed25519 public keys for VERIFYING machine tokens. Empty when
 * the asymmetric plane is not configured (HS256-only deployment).
 */
export function getServicePublicKeys(): KeyObject[] {
  const raw = (process.env.FAYANMS_SERVICE_PUBLIC_KEYS ?? "").trim();
  if (!raw) {
    publicKeysCache = null;
    return [];
  }
  if (publicKeysCache?.raw === raw) return publicKeysCache.keys;
  const keys = parseServicePublicKeys(raw); // throws on malformed entries
  publicKeysCache = { raw, keys };
  return keys;
}

let signingKeyCache: { raw: string; key: KeyObject } | null = null;

/**
 * Parse the Ed25519 PRIVATE signing key from raw env material (PKCS8 PEM,
 * escaped \n tolerated). Throws on malformed material AND on wrong key
 * types (TASK-SVC-001-A §14: only Ed25519 mints on the asymmetric plane).
 * Exported for the startup policy — misconfiguration must fail at BOOT,
 * not at first token mint.
 */
export function parseServicePrivateKey(raw: string): KeyObject {
  const key = createPrivateKey(unescapePem(raw));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("service private key is not an Ed25519 key");
  }
  return key;
}

/**
 * The configured Ed25519 PRIVATE key for MINTING machine tokens (the
 * control plane's own identity). Null when absent — minting then falls
 * back to HS256 (Phase 1 of the rotation), never silently when EdDSA is
 * expected (callers surface the fallback explicitly).
 */
export function getServiceSigningKey(): KeyObject | null {
  const raw = (process.env.FAYANMS_SERVICE_PRIVATE_KEY ?? "").trim();
  if (!raw) {
    signingKeyCache = null;
    return null;
  }
  if (signingKeyCache?.raw === raw) return signingKeyCache.key;
  const key = parseServicePrivateKey(raw);
  signingKeyCache = { raw, key };
  return key;
}

export interface ServicePrincipal {
  readonly kind: "service";
  readonly id: string;
  readonly issuer: string;
  readonly scopes: string[];
}

/**
 * Per-route scope catalog (Phase 19-C): jobs (worker job engine), simulate
 * (Next→worker simulator calls), alerts, reports, metrics.
 */
export type ServiceScope = "jobs" | "simulate" | "alerts" | "reports" | "metrics";

export type ServiceAuthResult =
  | { ok: true; principal: ServicePrincipal }
  | { ok: false; code: string; message: string };


function b64urlToJson(part: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hmac(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function ed25519Sign(signingInput: string, key: KeyObject): Buffer {
  return cryptoSign(null, Buffer.from(signingInput), key);
}

function ed25519Verify(signingInput: string, signature: Buffer, keys: KeyObject[]): boolean {
  return keys.some((key) => {
    try {
      return cryptoVerify(null, Buffer.from(signingInput), key, signature);
    } catch {
      return false;
    }
  });
}

/**
 * Verify a compact JWS against the configured trust planes (secrets for
 * HS256, public keys for EdDSA). Returns the payload or a precise failure.
 * The caller guarantees at least one plane is configured.
 */
function verifyServiceJwt(
  token: string,
  secrets: string[],
  publicKeys: KeyObject[]
): { ok: true; payload: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token is not a compact JWS." };
  }
  const [headPart, bodyPart, sigPart] = parts;
  const header = b64urlToJson(headPart);
  if (!header || header.typ !== "JWT" || (header.alg !== "HS256" && header.alg !== "EdDSA")) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: 'Service token header must be {alg:"HS256"|"EdDSA",typ:"JWT"}.' };
  }
  const signature = Buffer.from(sigPart, "base64url");
  const signingInput = `${headPart}.${bodyPart}`;
  let valid = false;
  if (header.alg === "EdDSA") {
    if (publicKeys.length === 0) {
      return {
        ok: false,
        code: "SERVICE_ALG_REJECTED",
        message: "EdDSA service tokens are not accepted — no FAYANMS_SERVICE_PUBLIC_KEYS configured on this verifier.",
      };
    }
    try {
      valid = ed25519Verify(signingInput, signature, publicKeys);
    } catch {
      return {
        ok: false,
        code: "SERVICE_KEYS_MISCONFIGURED",
        message: "FAYANMS_SERVICE_PUBLIC_KEYS contains malformed key material (expected SPKI DER base64 or PEM).",
      };
    }
  } else {
    if (secrets.length === 0) {
      return {
        ok: false,
        code: "SERVICE_ALG_REJECTED",
        message: "HS256 service tokens are not accepted — the symmetric plane is retired (FAYANMS_SERVICE_SECRET removed).",
      };
    }
    valid = secrets.some((secret) =>
      timingSafeEqualBuffer(signature, hmac(signingInput, secret))
    );
  }
  if (!valid) {
    return { ok: false, code: "SERVICE_TOKEN_INVALID", message: "Service token signature verification failed." };
  }
  const payload = b64urlToJson(bodyPart);
  if (!payload) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token payload is not valid JSON." };
  }
  if (payload.aud !== SERVICE_AUDIENCE) {
    return { ok: false, code: "SERVICE_AUDIENCE_INVALID", message: `Service token audience must be "${SERVICE_AUDIENCE}".` };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  if (exp === null) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token must carry a numeric exp." };
  }
  if (exp + CLOCK_SKEW_S < now) {
    return { ok: false, code: "SERVICE_TOKEN_EXPIRED", message: "Service token has expired." };
  }
  if (iat !== null && iat - CLOCK_SKEW_S > now) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token iat is in the future." };
  }
  return { ok: true, payload };
}

/**
 * Verify a bearer service token end-to-end (signature + audience + expiry
 * + issuer allowlist). Returns the principal on success — the single
 * verification path used by BOTH the proxy gate (machine-plane exemption,
 * no scope) and the route handlers (authenticateServiceRequest + scope).
 */
export function verifyServiceToken(token: string): ServiceAuthResult {
  let secrets: string[] = [];
  let publicKeys: KeyObject[] = [];
  try {
    secrets = getServiceSecrets();
    publicKeys = getServicePublicKeys();
  } catch {
    return {
      ok: false,
      code: "SERVICE_KEYS_MISCONFIGURED",
      message: "Configured service key material is malformed (FAYANMS_SERVICE_PUBLIC_KEYS / FAYANMS_SERVICE_PRIVATE_KEY).",
    };
  }
  if (secrets.length === 0 && publicKeys.length === 0) {
    return {
      ok: false,
      code: "SERVICE_UNCONFIGURED",
      message: "No service trust plane is configured — set FAYANMS_SERVICE_PUBLIC_KEYS (Ed25519) and/or FAYANMS_SERVICE_SECRET (symmetric).",
    };
  }
  const verified = verifyServiceJwt(token, secrets, publicKeys);
  if (!verified.ok) return verified;

  const payload = verified.payload;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (sub.length === 0 || iss.length === 0) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token must carry iss and sub." };
  }
  if (!getServiceIssuers().includes(iss)) {
    return {
      ok: false,
      code: "SERVICE_ISSUER_INVALID",
      message: `Service token issuer "${iss}" is not in the allowlist.`,
    };
  }
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return {
    ok: true,
    principal: { kind: "service", id: sub, issuer: iss, scopes },
  };
}

/** Extract the bearer token from an Authorization header value (or null). */
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match ? match[1] : null;
}
