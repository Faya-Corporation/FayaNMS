/**
 * FayaNMS worker — service-identity BOOT validation (TASK-SVC-001-A §12).
 *
 * The Next.js app enforces the startup security policy from
 * src/instrumentation.ts; the worker process has its own boot path (this
 * file, called from index.ts under import.meta.main). A process should
 * only require the cryptographic material its responsibility needs — and
 * should find out at BOOT, not at first authenticated request, when that
 * material is missing, malformed or self-contradictory:
 *
 *   legacy        FAYANMS_SERVICE_SECRET only (the certify/CI shape) —
 *                 boots. Symmetric strength is the operator's app-side
 *                 startup policy duty; the worker's HMAC verifier accepts
 *                 the configured secret as-is (the certification driver's
 *                 throwaway secret is deliberately not 64-hex).
 *   eddsa-only    FAYANMS_SERVICE_PUBLIC_KEYS set, no symmetric material —
 *                 the RECOMMENDED production shape. Requires the worker's
 *                 OWN private key: it signs the tokens the app verifies,
 *                 and there is no symmetric fallback to mint with.
 *   dual          Public keys + private key + secret — rotation Phase 1.
 *                 Boots.
 *   unconfigured  Nothing usable — the worker can neither verify control
 *                 tokens nor mint its own identity. Boot refuses.
 *
 * Self-contradictory configurations fail deterministically:
 *   - private key WITHOUT public keys: minted EdDSA tokens could never
 *     verify on the app (its FAYANMS_SERVICE_PUBLIC_KEYS would lack this
 *     key), while control-token verification would be dead too;
 *   - malformed/wrong-type key material (only Ed25519 is accepted).
 *
 * Error messages describe the defect and NEVER echo key material.
 *
 * Zero external dependencies; env resolution reuses control-auth.ts's
 * process.env → repo-root .env reader (the same values the runtime
 * verifier and signer see).
 */

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import { readRootEnvValue } from "./control-auth";

/** The resolved service-identity material this worker would run with. */
export interface WorkerIdentityEnv {
  readonly publicKeysRaw: string | null;
  readonly privateKeyRaw: string | null;
  readonly serviceSecretRaw: string | null;
}

/** Resolve the identity material exactly as the runtime would read it. */
export function resolveWorkerIdentityEnv(): WorkerIdentityEnv {
  return {
    publicKeysRaw: readRootEnvValue("FAYANMS_SERVICE_PUBLIC_KEYS"),
    privateKeyRaw: readRootEnvValue("FAYANMS_SERVICE_PRIVATE_KEY"),
    serviceSecretRaw: readRootEnvValue("FAYANMS_SERVICE_SECRET"),
  };
}

/**
 * Parse the PASSED public-key material (same contract as control-auth's
 * verifier parser: comma-separated SPKI DER base64 or PEM, escaped \n
 * tolerated, Ed25519-only) — deliberately reading the argument, NOT global
 * env, so the assert is pure and fully testable.
 */
function parsePublicKeys(raw: string): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const pem = entry.includes("\\n") ? entry.replaceAll("\\n", "\n") : entry;
    const key = pem.startsWith("-----BEGIN")
      ? createPublicKey(pem)
      : createPublicKey({ key: Buffer.from(entry, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("not an Ed25519 key");
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Fail-fast boot validation for the worker's service identity. Throws a
 * plain Error with a static, operator-actionable message on every
 * configuration that could not serve authenticated traffic.
 */
export function assertWorkerServiceIdentity(
  env: WorkerIdentityEnv = resolveWorkerIdentityEnv()
): void {
  const hasPublicKeys = (env.publicKeysRaw ?? "").trim().length > 0;
  const hasPrivateKey = (env.privateKeyRaw ?? "").trim().length > 0;
  const hasSecret = (env.serviceSecretRaw ?? "").trim().length > 0;

  if (!hasPublicKeys && !hasSecret) {
    throw new Error(
      "FayaNMS worker service identity is not configured — set FAYANMS_SERVICE_PUBLIC_KEYS (Ed25519 control identity, recommended) and FAYANMS_SERVICE_PRIVATE_KEY (this worker's signing key), or FAYANMS_SERVICE_SECRET (legacy symmetric) to boot."
    );
  }

  if (hasPublicKeys) {
    try {
      parsePublicKeys((env.publicKeysRaw as string).trim());
    } catch {
      throw new Error(
        "FayaNMS worker FAYANMS_SERVICE_PUBLIC_KEYS contains malformed key material (expected comma-separated Ed25519 SPKI DER base64 or PEM)."
      );
    }
  }

  if (hasPrivateKey) {
    try {
      const pem = (env.privateKeyRaw as string).includes("\\n")
        ? (env.privateKeyRaw as string).replaceAll("\\n", "\n")
        : (env.privateKeyRaw as string);
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "ed25519") {
        throw new TypeError("not an Ed25519 key");
      }
    } catch {
      throw new Error(
        "FayaNMS worker FAYANMS_SERVICE_PRIVATE_KEY is malformed or not an Ed25519 key (expected a PKCS8 PEM)."
      );
    }
  }

  if (hasPublicKeys && !hasSecret && !hasPrivateKey) {
    throw new Error(
      "FayaNMS worker in EdDSA-only mode requires FAYANMS_SERVICE_PRIVATE_KEY — it signs the tokens the app verifies and no symmetric fallback exists."
    );
  }

  if (hasPrivateKey && !hasPublicKeys) {
    throw new Error(
      "FayaNMS worker FAYANMS_SERVICE_PRIVATE_KEY is configured but FAYANMS_SERVICE_PUBLIC_KEYS is empty — minted EdDSA tokens could never verify and control-token verification is unconfigured; configure the public keys or remove the private key."
    );
  }
}

/**
 * SEC-ENV-001 (TASK-SEC-ENV-001-A): worker-zone secret scope.
 *
 * Production secrets are split per service (compose maps the worker to
 * .env.production.worker). These variables must NEVER reach the worker
 * process — they belong to the app/DB trust zones:
 *
 *   - NEXTAUTH_SECRET / NEXTAUTH_URL      browser sessions are an app concern;
 *   - FAYANMS_CONFIG_ENC_KEY(+_ID)        the KEK never leaves the app — the
 *                                         worker never decrypts snapshots;
 *   - POSTGRES_PASSWORD / DATABASE_URL    the worker NEVER touches PostgreSQL
 *                                         (all persistence goes through the
 *                                         app's service-authenticated API);
 *   - proxy/login/demo/build knobs        app-plane configuration the worker
 *                                         never reads.
 *
 * The app mirrors this check in src/lib/startup/security-policy.ts
 * (separate runtime, mirrored list — the app side additionally catches
 * FAYANMS_VAULT_* by wildcard).
 */
export const WORKER_ZONE_FORBIDDEN_VARS: readonly string[] = [
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "FAYANMS_CONFIG_ENC_KEY",
  "FAYANMS_CONFIG_ENC_KEY_ID",
  "FAYANMS_TRUST_PROXY_HOPS",
  "FAYANMS_LOGIN_WINDOW_SECONDS",
  "FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE",
  "FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT",
  "FAYANMS_DB_QUERY_LOG",
  "FAYANMS_DEMO_MODE",
  "SITE_URL",
  "WORKER_BASE_URL",
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
];

/** One out-of-zone variable the worker process received. Values are NEVER included. */
export interface WorkerSecretScopeWarning {
  variable: string;
  reason: string;
}

/**
 * Pure scope check: every variable present (non-empty) in `env` that the
 * worker process must not receive. Empty/whitespace variables are not
 * received material. Reasons are static — they name the variable and the
 * owning zone, never a value.
 */
export function findWorkerSecretScopeWarnings(
  env: NodeJS.ProcessEnv = process.env
): WorkerSecretScopeWarning[] {
  const warnings: WorkerSecretScopeWarning[] = [];
  for (const variable of WORKER_ZONE_FORBIDDEN_VARS) {
    if ((env[variable] ?? "").toString().trim().length === 0) continue;
    warnings.push({
      variable,
      reason:
        "out-of-zone for the worker process — the worker never touches browser " +
        "sessions, the config-encryption KEK, or PostgreSQL (all persistence " +
        "goes through the app API). Remove it from the worker env file " +
        "(.env.production.worker); per-service secret scopes (SEC-ENV-001) " +
        "become a boot refusal after the deprecation window.",
    });
  }
  return warnings;
}

/** Deprecation-path emitter: warn once per out-of-zone variable at boot. */
export function warnWorkerSecretScope(env: NodeJS.ProcessEnv = process.env): void {
  for (const warning of findWorkerSecretScopeWarnings(env)) {
    console.warn(`[worker] SEC-ENV-001 ${warning.variable}: ${warning.reason}`);
  }
}
