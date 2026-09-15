/**
 * Startup security policy (Phase 19 / audit SEC-004; TASK-SVC-001-A).
 *
 * Fail-closed validation of secret material and demo-mode gating, executed
 * once per server process from src/instrumentation.ts (register()).
 *
 * Production (NODE_ENV=production) aborts startup when ANY of these fail:
 *   - NEXTAUTH_SECRET missing, shorter than 32 chars, or a known demo/repo value
 *   - the SERVICE IDENTITY configuration is invalid (see the mode matrix
 *     below — SVC-001: the legacy symmetric secret is NO LONGER unconditionally
 *     required; a complete Ed25519-only configuration boots clean)
 *   - FAYANMS_CONFIG_ENC_KEY missing, not 64 hex chars, or a known demo/repo
 *     value (config encryption KEK)
 *   - FAYANMS_DEMO_MODE=true (seeded shared-credential users are forbidden)
 *   - DATABASE_URL missing or not a postgres(ql):// URL (Phase 21 slice 1:
 *     production persistence is PostgreSQL — compose ships the `postgres`
 *     service; a stray SQLite file: URL must never serve production traffic)
 *
 * Service identity modes (TASK-SVC-001-A, derived EXCLUSIVELY from the
 * configured environment — never from token metadata; runtime half lives
 * in src/lib/auth/service-jwt.ts):
 *
 *   eddsa-only    FAYANMS_SERVICE_PUBLIC_KEYS set, NO symmetric material.
 *                 The recommended production end state: HS256 is
 *                 structurally impossible at runtime (SERVICE_ALG_REJECTED).
 *                 Requires the app's own Ed25519 private key — this process
 *                 mints control-plane service tokens and there is no
 *                 symmetric fallback (remediation prompt §11: "Ed25519
 *                 public keys but signing process missing required private
 *                 key → FAIL").
 *   dual          Public keys AND symmetric secret — the documented P1-007
 *                 rotation Phase 1 (time-boxed). Both algorithms verify;
 *                 minters prefer EdDSA. Symmetric strength rules apply in
 *                 full (64-hex primary, known-bad blocklist, indexed
 *                 rotation-entry checks).
 *   hs256-legacy  Symmetric secret only. Deprecated, kept for migration;
 *                 same strength rules. A private key WITHOUT public keys is
 *                 a conflict (minted EdDSA tokens could never verify) and
 *                 fails deterministically.
 *   unconfigured  No trust plane at all — production refuses to start.
 *
 * Malformed key material (public or private, including non-Ed25519 types)
 * fails at BOOT instead of at first token use — error messages describe
 * the defect and never echo key material (remediation prompt §14).
 *
 * P1-019 (external ULTRA audit): the shape checks alone used to ACCEPT the
 * deterministic sample secrets committed to .github/workflows/ci.yml — a
 * deployment that copied them into production would sail through validation.
 * The known-bad check covers ALL secret variables (not just the session
 * secret), and the committed CI sample itself is blocklisted.
 * tests/audit/config-hygiene.test.ts parses ci.yml and pins that EVERY
 * committed sample value is REFUSED by production validation, so a future
 * editor cannot reintroduce the footgun.
 *
 * Development never aborts: it warns when the session secret is missing or a
 * known-bad value, so local iteration stays friction-free while keeping the
 * signal visible.
 */

import {
  getServiceSecrets,
  parseServicePrivateKey,
  parseServicePublicKeys,
} from "@/lib/auth/service-jwt";

const MIN_SECRET_LENGTH = 32;

/**
 * Values that must never serve ANY production secret: the secret that
 * shipped in .env.example before Phase 19 (see audit SEC-004), a small
 * blocklist of classic weak defaults, and every deterministic sample value
 * committed to the repository (CI workflows) — repo-public material by
 * construction (P1-019, external ULTRA audit). CI itself runs in
 * non-production mode, where the blocklist only warns; production refuses.
 */
const KNOWN_BAD_SECRETS: readonly string[] = [
  // The pre-P19 committed example value — treat as public knowledge.
  "57c9048e4d3fec488f31976c609e348a959bb5cd383310eea59227971013ab2c",
  // The deterministic sample shared by .github/workflows/ci.yml (P1-019):
  // public by construction, must never pass production validation.
  "6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03",
  "faya123",
  "changeme",
  "change-me",
  "secret",
  "password",
  "nextauth-secret",
  "please-change-me",
];

const HEX_64 = /^[0-9a-f]{64}$/;

/** Production persistence contract (Phase 21 slice 1): PostgreSQL only. */
const POSTGRES_URL = /^postgres(ql)?:\/\//;

function isKnownBad(value: string): boolean {
  return KNOWN_BAD_SECRETS.includes(value.trim().toLowerCase());
}

export interface PolicyViolation {
  readonly variable: string;
  readonly reason: string;
}

/**
 * The explicit service-identity mode derived from the environment
 * (TASK-SVC-001-A §4). EdDSA-only and dual both require public keys;
 * the symmetric plane's presence is judged with the EXACT semantics the
 * runtime verifier uses (getServiceSecrets — primary + rotation list).
 */
export type ServiceIdentityMode =
  | "eddsa-only"
  | "dual"
  | "hs256-legacy"
  | "unconfigured";

export function resolveServiceIdentityMode(
  env: NodeJS.ProcessEnv = process.env
): ServiceIdentityMode {
  const hasKeys = (env.FAYANMS_SERVICE_PUBLIC_KEYS ?? "").trim().length > 0;
  const hasSecret = getServiceSecrets(env).length > 0;
  if (hasKeys && hasSecret) return "dual";
  if (hasKeys) return "eddsa-only";
  if (hasSecret) return "hs256-legacy";
  return "unconfigured";
}

/**
 * Service-identity validation for the APP process (the only process that
 * runs this policy — the worker enforces its own boot check in
 * mini-services/worker/identity-boot.ts, and the one-off provision
 * container needs no service identity at all).
 *
 * Implements the startup matrix from the SVC-001-A remediation prompt §11;
 * every row is pinned by tests/auth/service-identity-modes.test.ts.
 */
export function findServiceIdentityViolations(
  env: NodeJS.ProcessEnv = process.env
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const mode = resolveServiceIdentityMode(env);

  if (mode === "unconfigured") {
    violations.push({
      variable: "FAYANMS_SERVICE_PUBLIC_KEYS",
      reason:
        "missing service identity — configure FAYANMS_SERVICE_PUBLIC_KEYS (Ed25519, recommended production mode) and/or FAYANMS_SERVICE_SECRET (legacy HS256)",
    });
    return violations;
  }

  // Structural key validation (§14): malformed or wrong-type material is a
  // boot failure, never a soft skip. Reasons are static — no key material
  // is ever echoed.
  const publicKeysRaw = (env.FAYANMS_SERVICE_PUBLIC_KEYS ?? "").trim();
  if (publicKeysRaw.length > 0) {
    try {
      parseServicePublicKeys(publicKeysRaw);
    } catch {
      violations.push({
        variable: "FAYANMS_SERVICE_PUBLIC_KEYS",
        reason:
          "malformed key material (expected comma-separated Ed25519 SPKI DER base64 or PEM) — generate with: bun run keys:service",
      });
    }
  }

  const privateKeyRaw = (env.FAYANMS_SERVICE_PRIVATE_KEY ?? "").trim();
  if (privateKeyRaw.length > 0) {
    try {
      parseServicePrivateKey(privateKeyRaw);
    } catch {
      violations.push({
        variable: "FAYANMS_SERVICE_PRIVATE_KEY",
        reason:
          "malformed key material (expected an Ed25519 PKCS8 PEM; other key types are not accepted) — generate with: bun run keys:service",
      });
    }
  }

  if (mode === "eddsa-only") {
    // §11 row 2: the app signs control-plane tokens — without its private
    // key, EdDSA-only minting has no fallback and control calls would fail
    // at runtime. Fail at boot instead.
    if (privateKeyRaw.length === 0) {
      violations.push({
        variable: "FAYANMS_SERVICE_PRIVATE_KEY",
        reason:
          "required in EdDSA-only mode — this process mints control-plane service tokens and no symmetric fallback exists",
      });
    }
    return violations;
  }

  if (mode === "hs256-legacy" && privateKeyRaw.length > 0) {
    // §11 row 9 (conflict): minters prefer EdDSA, but with no public keys
    // configured anywhere those tokens could never verify — a silently
    // broken control plane. Deterministic refusal.
    violations.push({
      variable: "FAYANMS_SERVICE_PRIVATE_KEY",
      reason:
        "configured but FAYANMS_SERVICE_PUBLIC_KEYS is empty — minted EdDSA tokens could never verify; configure the public keys or remove the private key",
    });
  }

  // Symmetric plane active (dual or hs256-legacy): strength rules apply in
  // full — unchanged from the pre-SVC-001-A policy for these modes.
  const serviceSecret = env.FAYANMS_SERVICE_SECRET?.trim() ?? "";
  if (!HEX_64.test(serviceSecret)) {
    violations.push({
      variable: "FAYANMS_SERVICE_SECRET",
      reason: "missing or not 64 hex chars (internal service authentication)",
    });
  } else if (isKnownBad(serviceSecret)) {
    violations.push({
      variable: "FAYANMS_SERVICE_SECRET",
      reason: "matches a known demo/repository default value",
    });
  }

  // Rotation list (P1-007 two-phase rotation): every entry is held to the
  // same bar as the primary secret — repo-public material included.
  const rotationEntries = (env.FAYANMS_SERVICE_SECRETS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  rotationEntries.forEach((entry, index) => {
    if (!HEX_64.test(entry)) {
      violations.push({
        variable: `FAYANMS_SERVICE_SECRETS[${index}]`,
        reason: "not 64 hex chars (service key rotation entry)",
      });
    } else if (isKnownBad(entry)) {
      violations.push({
        variable: `FAYANMS_SERVICE_SECRETS[${index}]`,
        reason: "matches a known demo/repository default value",
      });
    }
  });

  return violations;
}

/** Validate the production posture. Returns every violation found. */
export function findProductionPolicyViolations(
  env: NodeJS.ProcessEnv = process.env
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const sessionSecret = env.NEXTAUTH_SECRET?.trim() ?? "";
  if (sessionSecret.length === 0) {
    violations.push({
      variable: "NEXTAUTH_SECRET",
      reason: "missing — generate with: openssl rand -hex 32",
    });
  } else if (sessionSecret.length < MIN_SECRET_LENGTH) {
    violations.push({
      variable: "NEXTAUTH_SECRET",
      reason: `too short (${sessionSecret.length} chars, minimum ${MIN_SECRET_LENGTH})`,
    });
  } else if (isKnownBad(sessionSecret)) {
    violations.push({
      variable: "NEXTAUTH_SECRET",
      reason: "matches a known demo/repository default value",
    });
  }

  // SVC-001 (TASK-SVC-001-A): the unconditional FAYANMS_SERVICE_SECRET
  // requirement is REPLACED by mode-aware service-identity validation —
  // a complete Ed25519-only configuration now boots clean.
  violations.push(...findServiceIdentityViolations(env));

  const encKey = env.FAYANMS_CONFIG_ENC_KEY?.trim() ?? "";
  if (!HEX_64.test(encKey)) {
    violations.push({
      variable: "FAYANMS_CONFIG_ENC_KEY",
      reason: "missing or not 64 hex chars (configuration encryption master key)",
    });
  } else if (isKnownBad(encKey)) {
    violations.push({
      variable: "FAYANMS_CONFIG_ENC_KEY",
      reason: "matches a known demo/repository default value",
    });
  }

  if ((env.FAYANMS_DEMO_MODE ?? "").trim().toLowerCase() === "true") {
    violations.push({
      variable: "FAYANMS_DEMO_MODE",
      reason: "demo mode (shared-credential seeded users) is forbidden in production",
    });
  }

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl.length === 0) {
    violations.push({
      variable: "DATABASE_URL",
      reason:
        "missing — production persistence is PostgreSQL (compose.yml ships the `postgres` service and composes the URL from POSTGRES_PASSWORD)",
    });
  } else if (!POSTGRES_URL.test(databaseUrl)) {
    violations.push({
      variable: "DATABASE_URL",
      reason:
        "must start with postgresql:// or postgres:// — the SQLite provider was retired in Phase 21 slice 1 (2026-09-13)",
    });
  }

  return violations;
}

/** Dev-only soft check: warn (never throw) on session-secret problems. */
export function warnOnInsecureDevSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const sessionSecret = env.NEXTAUTH_SECRET?.trim() ?? "";
  if (
    sessionSecret.length === 0 ||
    sessionSecret.length < MIN_SECRET_LENGTH ||
    isKnownBad(sessionSecret)
  ) {
    console.warn(
      "[security-policy] NEXTAUTH_SECRET is missing/weak in this dev environment — " +
        "sessions fall back to a runtime-generated dev secret. Set it in .env for parity."
    );
  }
}

/**
 * Entry point invoked from src/instrumentation.ts register().
 * Throws in production on any violation (aborting startup); warns in dev.
 */
export function enforceStartupSecurityPolicy(): void {
  if (process.env.NODE_ENV === "production") {
    const violations = findProductionPolicyViolations();
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.variable}: ${v.reason}`)
        .join("\n");
      throw new Error(
        `[security-policy] REFUSING TO START in production — insecure configuration:\n${detail}\n` +
          "Fix the environment (see .env.example) and retry."
      );
    }
    return;
  }
  warnOnInsecureDevSecrets();
}
