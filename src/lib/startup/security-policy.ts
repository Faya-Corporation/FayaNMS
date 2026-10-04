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
 *   - the declared app replica count (FAYANMS_EXPECTED_REPLICAS, default 1)
 *     exceeds 1 while the rate/login budgets would stay PER-PROCESS
 *     (F-032 / A1-09: the in-memory store multiplies every budget by the
 *     instance count — N instances behind a load balancer allow N× the
 *     documented rate ceiling and keep login lockout state per instance).
 *     The shared store (FAYANMS_RATE_STORE=postgres — the SAME knob that
 *     drives both the API gate and the login guard, SCALE-001-A/B) is
 *     required before a multi-instance declaration may boot; a single
 *     instance (or an unset declaration) boots unchanged on the default.
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

import { RATE_STORE_ENV, resolveRateStoreKind } from "@/lib/api/rate-store";
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

/* ───────────────── F-032 / A1-09: rate-budget scale guard ───────────────── */

/**
 * The ONLY replica-count source this process accepts (F-032): compose
 * `--scale`/orchestrator state is not visible in-process, so the operator
 * DECLARES the intended instance count explicitly. Unset/empty means 1 —
 * the documented single-host default boots unchanged.
 */
export const EXPECTED_REPLICAS_ENV = "FAYANMS_EXPECTED_REPLICAS";

export type ExpectedReplicasResolution =
  | { ok: true; replicas: number }
  | { ok: false; reason: string };

/**
 * Pure parse of the declared app instance count. A positive integer ≥ 1 is
 * accepted; ANY other non-empty value is a fail-loud declaration error (an
 * operator who wrote a malformed count must not get a silently mis-scoped
 * guard decision).
 */
export function resolveExpectedReplicas(
  env: NodeJS.ProcessEnv = process.env
): ExpectedReplicasResolution {
  const raw = (env[EXPECTED_REPLICAS_ENV] ?? "").trim();
  if (raw === "") return { ok: true, replicas: 1 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      reason:
        `not a positive integer — declare the number of app instances ` +
        `behind the load balancer (e.g. ${EXPECTED_REPLICAS_ENV}=1); ` +
        "unset means 1",
    };
  }
  return { ok: true, replicas: parsed };
}

/**
 * F-032 (A1-09): the rate gate's budgets AND the login guard's
 * throttle/lockout state are PER-PROCESS unless the shared store is
 * selected — ONE knob (FAYANMS_RATE_STORE, SCALE-001-A/B) drives both
 * planes. With N declared instances on the in-memory default every
 * documented ceiling silently becomes N× (fleet rate budget) and login
 * lockout state stops propagating (a distributed attack rotates sources
 * AND instances). A multi-instance production declaration therefore
 * refuses to boot on anything but the shared store; the same guard warns
 * (never aborts) in development.
 */
export function findRateStoreScaleViolations(
  env: NodeJS.ProcessEnv = process.env
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const resolution = resolveExpectedReplicas(env);
  if (!resolution.ok) {
    violations.push({
      variable: EXPECTED_REPLICAS_ENV,
      reason: resolution.reason,
    });
    return violations;
  }
  const { replicas } = resolution;
  if (replicas <= 1) return violations;

  let storeKind: "memory" | "postgres";
  try {
    storeKind = resolveRateStoreKind(env);
  } catch {
    violations.push({
      variable: RATE_STORE_ENV,
      reason:
        `not a supported store — with ${EXPECTED_REPLICAS_ENV}=${replicas} the ` +
        "shared store is required before boot (supported values: unset/\"memory\" " +
        "single-host, \"postgres\" shared); per-instance budgets would multiply " +
        `every documented ceiling by ${replicas}`,
    });
    return violations;
  }
  if (storeKind === "postgres") return violations;

  violations.push({
    variable: RATE_STORE_ENV,
    reason:
      `the rate/login budget store is per-process (in-memory default) while ` +
      `${EXPECTED_REPLICAS_ENV}=${replicas} — every instance enforces its OWN ` +
      `budget, so N instances allow N× the documented rate ceiling and login ` +
      `lockout state never propagates between them. Set ` +
      `${RATE_STORE_ENV}=postgres (the shared store over the database the app ` +
      "already depends on) or correct the instance declaration.",
  });
  return violations;
}

/** Dev-path emitter: the same F-032 signal, never fatal outside production. */
export function warnRateStoreScale(env: NodeJS.ProcessEnv = process.env): void {
  for (const violation of findRateStoreScaleViolations(env)) {
    console.warn(`[security-policy] ${violation.variable}: ${violation.reason}`);
  }
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

  // F-032 (A1-09): a multi-instance production declaration on the per-process
  // budget store is an insecure posture — fail loud at boot (see the guard's
  // contract above; dev gets the same signal as a non-fatal warning).
  violations.push(...findRateStoreScaleViolations(env));

  return violations;
}

/**
 * SEC-ENV-001 (TASK-SEC-ENV-001-A): per-service secret-scope zones.
 *
 * Production secrets are split per service (compose now maps the app to
 * .env.production.app and the worker to .env.production.worker). These are
 * the variables that must NEVER reach the app process — they belong to the
 * worker/DB trust zones:
 *
 *   - FAYANMS_WEBAPI_CA_PEM   device TLS trust is resolved worker-side;
 *   - POSTGRES_PASSWORD       the app needs DATABASE_URL, not the password
 *                             itself (compose composes the URL host-side);
 *   - NEXT_BASE_URL/SELF_BASE_URL  worker-plane hops the app never dials.
 *
 * Device vault credentials (FAYANMS_VAULT_*) are caught by a wildcard rule
 * in findAppSecretScopeWarnings: the app stores only vault REFERENCES
 * (CredentialProfile.secretRef) — the WORKER resolves the actual secrets.
 * The worker mirrors this check in mini-services/worker/identity-boot.ts
 * (separate runtime, mirrored list).
 */
export const APP_ZONE_FORBIDDEN_VARS: readonly string[] = [
  "FAYANMS_WEBAPI_CA_PEM",
  "POSTGRES_PASSWORD",
  "NEXT_BASE_URL",
  "SELF_BASE_URL",
];

/** One out-of-zone variable the app process received. Values are NEVER included. */
export interface SecretScopeWarning {
  variable: string;
  reason: string;
}

const VAULT_ENV_PREFIX = "FAYANMS_VAULT_";

/**
 * Pure scope check: every variable present (non-empty) in `env` that the app
 * process must not receive. Empty/whitespace variables are not received
 * material. Reasons are static — they name the variable and the owning zone,
 * never a value.
 */
export function findAppSecretScopeWarnings(
  env: NodeJS.ProcessEnv = process.env
): SecretScopeWarning[] {
  const warnings: SecretScopeWarning[] = [];
  const push = (variable: string, detail: string): void => {
    warnings.push({
      variable,
      reason:
        `out-of-zone for the app process — ${detail} Remove it from the app ` +
        "env file (.env.production.app); per-service secret scopes (SEC-ENV-001) " +
        "become a production boot refusal after the deprecation window.",
    });
  };
  for (const variable of APP_ZONE_FORBIDDEN_VARS) {
    if ((env[variable] ?? "").toString().trim().length > 0) {
      push(variable, "worker/DB-zone material the app never reads.");
    }
  }
  for (const key of Object.keys(env)) {
    if (!key.startsWith(VAULT_ENV_PREFIX)) continue;
    if ((env[key] ?? "").toString().trim().length === 0) continue;
    push(
      key,
      "device vault credentials resolve in the worker only — the app stores " +
        "vault references (CredentialProfile.secretRef), never secret material."
    );
  }
  return warnings;
}

/** Deprecation-path emitter: warn once per out-of-zone variable at boot. */
export function warnAppSecretScope(env: NodeJS.ProcessEnv = process.env): void {
  for (const warning of findAppSecretScopeWarnings(env)) {
    console.warn(`[security-policy] SEC-ENV-001 ${warning.variable}: ${warning.reason}`);
  }
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
    // SEC-ENV-001 deprecation path: out-of-zone secret material in the app
    // env still boots, but it is flagged by name (values are never printed).
    // After the documented deprecation window this becomes a boot refusal —
    // operators should move each variable to its owning service's env file.
    warnAppSecretScope();
    return;
  }
  warnOnInsecureDevSecrets();
  // F-032 dev signal: the same scale guard, warn-only outside production.
  warnRateStoreScale();
}
