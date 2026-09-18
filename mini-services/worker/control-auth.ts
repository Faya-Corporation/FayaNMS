/**
 * FayaNMS worker — control-plane token verifier (Phase 19-C / audit
 * GATEWAY-101 + SVC-101; P1-007 asymmetric service identity).
 *
 * The worker's HTTP surface is reachable through the sandbox gateway
 * (XTransformPort=3030), so /simulate/* and /capabilities no longer answer
 * anonymous requests: callers must present a short-lived service JWT,
 * audience "fayanms:internal", issuer allowlisted to the Next.js control
 * plane ("fayanms:control") and — for the simulator mutation endpoints —
 * carrying the "simulate" scope.
 *
 * P1-007 (ULTRA audit: "HS256 shared-secret only; holder of the secret can
 * mint any token"): the worker verifies ASYMMETRIC control-plane identity.
 * With FAYANMS_SERVICE_PUBLIC_KEYS configured (the CONTROL side's Ed25519
 * public key — SPKI DER base64, comma-separated rotation list, PEM
 * tolerated), alg-EdDSA tokens are verified with crypto.verify: the worker
 * holds NO minting capability for control identities. HS256 remains
 * accepted while the shared secret is still configured (rotation Phase 1);
 * removing FAYANMS_SERVICE_SECRET everywhere completes Phase 2 — symmetric
 * tokens are then refused (WORKER_ALG_REJECTED), and a leaked worker-side
 * secret no longer mints control-plane identities. A malformed configured
 * key is a misconfiguration, not a soft skip (WORKER_KEYS_MISCONFIGURED).
 *
 * /health stays open (liveness probe; counters only, no device surface).
 *
 * Zero external dependencies: same wire format as the Next.js verifier
 * (src/lib/auth/service-jwt.ts) and the worker's own signer
 * (service-token.ts).
 */

import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUDIENCE = "fayanms:internal";
const CLOCK_SKEW_S = 30;

/**
 * Issuer allowlist: the Next.js control plane ("fayanms:control") drives
 * /simulate/* and /capabilities externally; the worker's own runner makes
 * authenticated loopback self-calls with its own identity
 * ("fayanms:worker", scopes include "simulate"). Both are allowlisted —
 * anything else is rejected.
 */
const ISSUER_ALLOWLIST = ["fayanms:control", "fayanms:worker"];

export interface ControlVerifyResult {
  ok: boolean;
  code: string;
  message: string;
}

/**
 * Read an env value from process.env first, then the repo-root .env, with
 * dotenv-style quote tolerance and escaped-\n PEM support. Exported for
 * identity-boot.ts (TASK-SVC-001-A worker startup validation).
 *
 * R64 hermeticity hardening: an EXPLICIT EMPTY process.env value is
 * authoritative — it SUPPRESSES the .env-file fallback and reads as
 * "unconfigured". The file fallback exists for processes that never had
 * the variable at all (the live worker convenience); a process that sets
 * the variable to "" has deliberately opted out (the unit gate pins its
 * green state in exactly this CI-shaped topology, where the sandbox dev
 * .env must not leak key material into in-process mint/verify round
 * trips — see tests/audit/r64-gate-hermeticity.test.ts).
 *
 * R64 (completion): the fallback FILE itself is knob-controlled via
 * FAYANMS_SERVICE_ENV_FILE — unset/blank-named falls back to the repo-root
 * .env exactly as before, a non-empty value names a different file, and an
 * EXPLICIT EMPTY value disables the file fallback entirely. The gate env
 * pins it empty: tests that DELETE a service variable (withServiceEnv
 * semantics: "this process has no such config") must not have dev .env
 * material re-supplied behind their backs.
 */
export function readRootEnvValue(key: string): string | null {
  const fromProcess = process.env[key];
  if (typeof fromProcess === "string") {
    const trimmed = fromProcess.trim();
    return trimmed ? trimmed : null; // explicit empty = deliberate unset
  }
  const envFile = process.env.FAYANMS_SERVICE_ENV_FILE;
  if (typeof envFile === "string" && !envFile.trim()) {
    return null; // explicit empty knob = fully hermetic, no file fallback
  }
  try {
    const envPath =
      envFile && envFile.trim()
        ? envFile.trim()
        : join(import.meta.dir, "..", "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const match = new RegExp(`^${key}=(.+)$`).exec(line.trim());
      if (match) {
        let value = match[1].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    /* .env unreadable — fall through */
  }
  return null;
}

/**
 * The configured Ed25519 public keys for verifying CONTROL-plane tokens.
 * Throws on malformed material — callers map that to
 * WORKER_KEYS_MISCONFIGURED (fail-tight, never silently dropped).
 * Exported for identity-boot.ts (TASK-SVC-001-A worker startup validation).
 */
export function configuredPublicKeys(): KeyObject[] {
  const raw = readRootEnvValue("FAYANMS_SERVICE_PUBLIC_KEYS");
  if (!raw) return [];
  const keys: KeyObject[] = [];
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const pem = entry.includes("\\n") ? entry.replaceAll("\\n", "\n") : entry;
    if (pem.startsWith("-----BEGIN")) {
      keys.push(createPublicKey(pem));
      continue;
    }
    keys.push(
      createPublicKey({ key: Buffer.from(entry, "base64"), format: "der", type: "spki" })
    );
  }
  return keys;
}

function b64urlToJson(part: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify the Bearer token on a worker control request. Optionally requires
 * a scope (e.g. "simulate" for the /simulate/* mutation endpoints).
 */
export function verifyControlToken(
  req: Request,
  requiredScope?: string
): ControlVerifyResult {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return {
      ok: false,
      code: "WORKER_UNAUTHENTICATED",
      message: "This worker endpoint requires a Bearer service token.",
    };
  }

  let secrets: string[] = [];
  let publicKeys: KeyObject[] = [];
  const sharedSecret = readRootEnvValue("FAYANMS_SERVICE_SECRET");
  if (sharedSecret) secrets.push(sharedSecret);
  try {
    publicKeys = configuredPublicKeys();
  } catch {
    return {
      ok: false,
      code: "WORKER_KEYS_MISCONFIGURED",
      message: "FAYANMS_SERVICE_PUBLIC_KEYS contains malformed key material (expected SPKI DER base64 or PEM).",
    };
  }
  if (secrets.length === 0 && publicKeys.length === 0) {
    return {
      ok: false,
      code: "WORKER_UNCONFIGURED",
      message: "No service trust plane is configured on the worker — set FAYANMS_SERVICE_PUBLIC_KEYS (Ed25519 control identity) and/or FAYANMS_SERVICE_SECRET (legacy symmetric).",
    };
  }

  const parts = match[1].split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token is not a compact JWS." };
  }
  const [headPart, bodyPart, sigPart] = parts;
  const headerJson = b64urlToJson(headPart);
  if (
    !headerJson ||
    headerJson.typ !== "JWT" ||
    (headerJson.alg !== "HS256" && headerJson.alg !== "EdDSA")
  ) {
    return {
      ok: false,
      code: "WORKER_TOKEN_MALFORMED",
      message: 'Token header must be {alg:"HS256"|"EdDSA",typ:"JWT"}.',
    };
  }
  const signingInput = `${headPart}.${bodyPart}`;
  const presented = Buffer.from(sigPart, "base64url");
  let signatureValid = false;
  if (headerJson.alg === "EdDSA") {
    if (publicKeys.length === 0) {
      return {
        ok: false,
        code: "WORKER_ALG_REJECTED",
        message: "EdDSA control tokens are not accepted — no FAYANMS_SERVICE_PUBLIC_KEYS configured on this worker.",
      };
    }
    signatureValid = publicKeys.some((key) => {
      try {
        return cryptoVerify(null, Buffer.from(signingInput), key, presented);
      } catch {
        return false;
      }
    });
  } else {
    if (secrets.length === 0) {
      return {
        ok: false,
        code: "WORKER_ALG_REJECTED",
        message: "HS256 control tokens are not accepted — the symmetric plane is retired on this worker.",
      };
    }
    const expected = createHmac("sha256", sharedSecret as string)
      .update(signingInput)
      .digest();
    signatureValid = timingSafeEqualBuffer(expected, presented);
  }
  if (!signatureValid) {
    return { ok: false, code: "WORKER_TOKEN_INVALID", message: "Token signature verification failed." };
  }
  const payload = b64urlToJson(bodyPart);
  if (!payload) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token payload is not valid JSON." };
  }
  if (payload.aud !== AUDIENCE) {
    return { ok: false, code: "WORKER_AUDIENCE_INVALID", message: `Token audience must be "${AUDIENCE}".` };
  }
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!ISSUER_ALLOWLIST.includes(iss)) {
    return {
      ok: false,
      code: "WORKER_ISSUER_INVALID",
      message: `Token issuer "${iss}" is not in the allowlist.`,
    };
  }
  const nowS = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  if (exp === null || exp + CLOCK_SKEW_S < nowS) {
    return { ok: false, code: "WORKER_TOKEN_EXPIRED", message: "Token has expired." };
  }
  if (iat !== null && iat - CLOCK_SKEW_S > nowS) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token iat is in the future." };
  }
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (requiredScope && !scopes.includes(requiredScope)) {
    return {
      ok: false,
      code: "WORKER_SCOPE_INSUFFICIENT",
      message: `Token lacks the "${requiredScope}" scope required by this endpoint.`,
    };
  }
  return { ok: true, code: "OK", message: "verified" };
}

/** Uniform 401/403 JSON response for rejected control calls. */
export function controlRejectResponse(result: ControlVerifyResult): Response {
  return Response.json(
    { ok: false, error: result.message, code: result.code },
    { status: 401 }
  );
}
