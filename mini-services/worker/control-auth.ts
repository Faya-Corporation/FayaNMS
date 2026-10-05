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
 * Wave-8 hardening: the HS256 plane accepts the SAME rotation list the app
 * accepts — FAYANMS_SERVICE_SECRETS (comma-separated) with
 * FAYANMS_SERVICE_SECRET as the primary — so a staged secret rotation
 * verifies on both planes (8-b F3); only Ed25519 keys are accepted in
 * FAYANMS_SERVICE_PUBLIC_KEYS (a well-formed RSA/EC entry is a
 * misconfiguration, not a silently-poisoned rotation list — 8-b F1); and a
 * control token must carry a non-empty `sub` (both minters always set one;
 * an anonymous subject fails closed — 8-b F3).
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
      // Plain prefix/slice parse instead of `new RegExp(`^${key}=...`)` — the
      // env-var NAME is an internal constant (never user input), and the
      // literal-prefix form avoids the non-literal-regexp footgun entirely.
      // Behavior is identical to the previous regex: anchored match at the
      // start of the trimmed line, requiring a non-empty remainder.
      const prefix = `${key}=`;
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith(prefix)) continue;
      const captured = trimmedLine.slice(prefix.length);
      if (!captured) continue; // `.+` required at least one character
      let value = captured.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* .env unreadable — fall through */
  }
  return null;
}

/**
 * All accepted HS256 secrets: the current FAYANMS_SERVICE_SECRET plus any
 * comma-separated FAYANMS_SERVICE_SECRETS rotation-window values (dedup,
 * primary first) — the exact iteration shape of the app verifier's
 * getServiceSecrets (src/lib/auth/service-jwt.ts), so a rotation staged
 * app-side verifies on the worker plane too (8-b F3).
 */
function configuredServiceSecrets(): string[] {
  const secrets: string[] = [];
  const primary = readRootEnvValue("FAYANMS_SERVICE_SECRET");
  if (primary) secrets.push(primary);
  const rotationRaw = readRootEnvValue("FAYANMS_SERVICE_SECRETS") ?? "";
  for (const raw of rotationRaw.split(",")) {
    const value = raw.trim();
    if (value && !secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

/**
 * The configured Ed25519 public keys for verifying CONTROL-plane tokens.
 * Throws on malformed material — callers map that to
 * WORKER_KEYS_MISCONFIGURED (fail-tight, never silently dropped).
 * Exported for identity-boot.ts (TASK-SVC-001-A worker startup validation).
 *
 * 8-b F1: ONLY Ed25519 keys are accepted — mirroring the boot parser
 * (identity-boot.ts parsePublicKeys) and the app verifier
 * (parseServicePublicKeys). A well-formed RSA/EC entry must fail TIGHT as
 * a keys-misconfiguration at the rotation boundary, not boot cleanly and
 * then degrade every EdDSA verification to WORKER_TOKEN_INVALID while
 * poisoning the rotation list.
 */
export function configuredPublicKeys(): KeyObject[] {
  const raw = readRootEnvValue("FAYANMS_SERVICE_PUBLIC_KEYS");
  if (!raw) return [];
  const keys: KeyObject[] = [];
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const pem = entry.includes("\\n") ? entry.replaceAll("\\n", "\n") : entry;
    const key = pem.startsWith("-----BEGIN")
      ? createPublicKey(pem)
      : createPublicKey({ key: Buffer.from(entry, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError(
        `not an Ed25519 key (got ${key.asymmetricKeyType ?? "unknown"} type)`,
      );
    }
    keys.push(key);
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

  const secrets = configuredServiceSecrets();
  let publicKeys: KeyObject[] = [];
  try {
    publicKeys = configuredPublicKeys();
  } catch {
    return {
      ok: false,
      code: "WORKER_KEYS_MISCONFIGURED",
      message: "FAYANMS_SERVICE_PUBLIC_KEYS contains malformed or non-Ed25519 key material (expected Ed25519 SPKI DER base64 or PEM).",
    };
  }
  if (secrets.length === 0 && publicKeys.length === 0) {
    return {
      ok: false,
      code: "WORKER_UNCONFIGURED",
      message: "No service trust plane is configured on the worker — set FAYANMS_SERVICE_PUBLIC_KEYS (Ed25519 control identity) and/or FAYANMS_SERVICE_SECRETS / FAYANMS_SERVICE_SECRET (legacy symmetric).",
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
    // 8-b F3: any secret in the rotation list verifies (the app side
    // iterates getServiceSecrets().some — same shape here).
    signatureValid = secrets.some((secret) =>
      timingSafeEqualBuffer(
        createHmac("sha256", secret).update(signingInput).digest(),
        presented,
      ),
    );
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
  // 8-b F3: a control token must name its principal. Both minters always
  // set a non-empty sub (the app mints "control-plane", the worker mints
  // "worker:sim-1"), so anything else is malformed by construction and
  // fails closed instead of surfacing as an anonymous identity on the
  // audit-carrying simulate/live surfaces.
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) {
    return {
      ok: false,
      code: "WORKER_TOKEN_INVALID",
      message: "Token subject (sub) must be a non-empty string.",
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

/**
 * Uniform 401/403 JSON response for rejected control calls.
 * RT-025 / F-040: a token that AUTHENTICATED but lacks the required scope
 * is an authorization failure — 403 semantics — while every "who are you"
 * failure stays 401. Clients can now distinguish the two classes.
 */
export function controlRejectResponse(result: ControlVerifyResult): Response {
  return Response.json(
    { ok: false, error: result.message, code: result.code },
    { status: result.code === "WORKER_SCOPE_INSUFFICIENT" ? 403 : 401 }
  );
}
