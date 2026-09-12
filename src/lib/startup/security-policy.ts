/**
 * Startup security policy (Phase 19 / audit SEC-004).
 *
 * Fail-closed validation of secret material and demo-mode gating, executed
 * once per server process from src/instrumentation.ts (register()).
 *
 * Production (NODE_ENV=production) aborts startup when ANY of these fail:
 *   - NEXTAUTH_SECRET missing, shorter than 32 chars, or a known demo/repo value
 *   - FAYANMS_SERVICE_SECRET missing or not 64 hex chars (internal service JWTs)
 *   - FAYANMS_CONFIG_ENC_KEY missing or not 64 hex chars (config encryption KEK)
 *   - FAYANMS_DEMO_MODE=true (seeded shared-credential users are forbidden)
 *   - DATABASE_URL missing or not a postgres(ql):// URL (Phase 21 slice 1:
 *     production persistence is PostgreSQL — compose ships the `postgres`
 *     service; a stray SQLite file: URL must never serve production traffic)
 *
 * Development never aborts: it warns when the session secret is missing or a
 * known-bad value, so local iteration stays friction-free while keeping the
 * signal visible.
 */

const MIN_SECRET_LENGTH = 32;

/**
 * Values that must never serve as a production session secret: the secret
 * that shipped in .env.example before Phase 19 (see audit SEC-004) and a
 * small blocklist of classic weak defaults.
 */
const KNOWN_BAD_SECRETS: readonly string[] = [
  // The pre-P19 committed example value — treat as public knowledge.
  "57c9048e4d3fec488f31976c609e348a959bb5cd383310eea59227971013ab2c",
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

  const serviceSecret = env.FAYANMS_SERVICE_SECRET?.trim() ?? "";
  if (!HEX_64.test(serviceSecret)) {
    violations.push({
      variable: "FAYANMS_SERVICE_SECRET",
      reason: "missing or not 64 hex chars (internal service authentication)",
    });
  }

  const encKey = env.FAYANMS_CONFIG_ENC_KEY?.trim() ?? "";
  if (!HEX_64.test(encKey)) {
    violations.push({
      variable: "FAYANMS_CONFIG_ENC_KEY",
      reason: "missing or not 64 hex chars (configuration encryption master key)",
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
