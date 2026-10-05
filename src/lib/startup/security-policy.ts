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
 *   - the proxy-hop trust contract is violated (wave-11 F-5, audit 15-c):
 *     FAYANMS_TRUST_PROXY_HOPS resolves to > 0 while NO appending reverse
 *     proxy is declared (FAYANMS_PUBLIC_PROXY) — with no proxy appending
 *     the real client address, X-Forwarded-For is attacker-chosen and
 *     rotating the header mints a fresh rate/login budget key per request
 *     (the pre-SAFE-002 bypass shape, reintroduced by topology). Boot is
 *     refused unless the operator either declares the appending proxy or
 *     sets FAYANMS_TRUST_PROXY_HOPS=0 (trust nothing). Development is
 *     unchanged: this check never fires outside production.
 *   - FAYANMS_METRICS_TOKEN is missing/empty or a repository-public
 *     placeholder (wave-12 F-1/F-2, audit 18-b — the A1-04 remedy): while
 *     the token is unset, /api/metrics answers 200 UNAUTHENTICATED (the
 *     documented dev/CI posture), and the wave-11 contract sanctions
 *     DIRECT-PUBLISH topologies (FAYANMS_TRUST_PROXY_HOPS=0) where the
 *     Caddy edge 404 for /api/metrics does NOT exist — the app-level
 *     posture must be self-sufficient. Repository-public placeholder
 *     values (the deploy templates' "SET_ON_HOST_ONLY", the production
 *     example's placeholder) are refused too: a verbatim deploy must not
 *     boot "configured" with a token any reader of this repo knows.
 *     Development is unchanged: this check never fires outside production.
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

/* ───────── Wave-11 F-5: proxy-hop trust contract (audit 15-c P3-2) ─────── */

/**
 * The operator's declaration that a reverse proxy APPENDS the real client
 * address to X-Forwarded-For in front of this app (the TLS compose
 * profile's Caddy). Truthy values are an explicit allowlist
 * (1/true/yes/on, case/space tolerant) so a typo can never silently
 * assert a proxy that is not there — anything else (including empty and
 * "false") means UNDECLARED.
 */
export const PUBLIC_PROXY_ENV = "FAYANMS_PUBLIC_PROXY";

const TRUTHY_PROXY_FLAGS = new Set(["1", "true", "yes", "on"]);

/**
 * Pure parse mirroring getTrustedProxyHops() in src/lib/api/rate-gate.ts
 * EXACTLY (that function reads process.env directly; the policy stays pure
 * over a literal env — batch-14 convention). Default 1, clamped 0..8,
 * non-numeric input falls back to the default 1. Drift between the two
 * parsers is pinned by a parity test in tests/audit/wave11-edge.test.ts.
 */
export function parseTrustedProxyHops(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return 1;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(8, Math.max(0, Math.floor(parsed)));
}

/**
 * Wave-11 F-5 (audit 15-c P3-2): the rate gate AND the login guard key
 * their budgets on the rightmost TRUSTED X-Forwarded-For hop
 * (FAYANMS_TRUST_PROXY_HOPS, default 1 — src/lib/api/rate-gate.ts
 * resolveClientIp). That default is only honest when a proxy actually
 * APPENDS the real client address. The base compose profile publishes the
 * app with NO appending proxy — there XFF is fully attacker-chosen and
 * rotating the header mints a fresh budget key per request (budget
 * bypass; the login guard shares resolveClientIp).
 *
 * Production therefore refuses to boot when hops > 0 without the explicit
 * declaration FAYANMS_PUBLIC_PROXY (same refusal block as every other
 * production posture violation — matching the F-032 severity convention;
 * dev behavior is unchanged). The remediation is one of:
 *   - run behind an appending proxy (the TLS compose profile) and declare
 *     it with FAYANMS_PUBLIC_PROXY=true; or
 *   - set FAYANMS_TRUST_PROXY_HOPS=0 — trust nothing: every caller shares
 *     the conservative "local" bucket (an attacker can annoy that shared
 *     bucket but can never bypass the budget).
 */
export function findProxyHopsViolations(
  env: NodeJS.ProcessEnv = process.env
): PolicyViolation[] {
  const hops = parseTrustedProxyHops(env.FAYANMS_TRUST_PROXY_HOPS);
  if (hops === 0) return [];

  const proxyDeclared = TRUTHY_PROXY_FLAGS.has(
    (env[PUBLIC_PROXY_ENV] ?? "").trim().toLowerCase()
  );
  if (proxyDeclared) return [];

  return [
    {
      variable: "FAYANMS_TRUST_PROXY_HOPS",
      reason:
        `resolves to ${hops} trusted proxy hop(s) while ${PUBLIC_PROXY_ENV} is ` +
        "not set — with no appending reverse proxy in front of the app, " +
        "X-Forwarded-For is attacker-chosen and rotating it mints a fresh " +
        "rate/login budget key per request (budget bypass). Run the app " +
        "behind an appending proxy (the TLS compose profile) and declare it " +
        `with ${PUBLIC_PROXY_ENV}=true, or set FAYANMS_TRUST_PROXY_HOPS=0 ` +
        '(trust nothing — every caller shares one conservative "local" bucket).',
    },
  ];
}

/* ────────── Wave-12 F-1/F-2: metrics bearer posture (audit 18-b) ────────── */

/**
 * The bearer token gating /api/metrics (and the worker's copy of the same
 * endpoint). Unset, the route answers 200 UNAUTHENTICATED — that is the
 * DOCUMENTED dev/CI posture (rt025/cloud-metrics pin it); the runtime
 * token-set branch is NOT changed by this policy (request-path semantics
 * stay byte-identical). What changes is the PRODUCTION BOOT posture below.
 */
export const METRICS_TOKEN_ENV = "FAYANMS_METRICS_TOKEN";

/**
 * F-2 (wave-12, audit 18-b): values that must never serve as the LIVE
 * metrics bearer token, compared trimmed/lowercase like isKnownBad().
 * The first two are the repository's own deploy placeholders — repo-public
 * by construction, so a verbatim copy must never boot "configured" with
 * one (the wave-12 known-bad scan extends to this variable exactly as
 * P1-019 extended it to the session/service/KEK secrets). The rest are
 * classic weak defaults; the shared KNOWN_BAD_SECRETS blocklist ALSO
 * applies via findMetricsTokenViolations (one bar for every secret).
 */
const KNOWN_BAD_METRICS_TOKENS: readonly string[] = [
  "SET_ON_HOST_ONLY", // deploy/oci/env.example (app + worker zones)
  "REPLACE_WITH_GENERATED_64_HEX_TOKEN", // docs/deploy/env.app.production.example
  "metrics",
  "metrics-token",
  "prometheus",
  "bearer",
];

function isKnownBadMetricsToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    // Entries are stored in their SHIPPED literal form (the deploy
    // templates' uppercase placeholders) — both sides normalize.
    KNOWN_BAD_METRICS_TOKENS.some((bad) => bad.trim().toLowerCase() === normalized) ||
    isKnownBad(value)
  );
}

/**
 * Wave-12 F-1/F-2 (audit 18-b — the A1-04 remedy, wave-11 F-5 guard shape):
 * the wave-11 proxy-hop contract sanctions DIRECT-PUBLISH topologies
 * (FAYANMS_TRUST_PROXY_HOPS=0). In that topology there is no Caddy edge
 * 404 for /api/metrics (deploy/oci/Caddyfile:17-18,
 * docs/deploy/Caddyfile.tls:41-42 only exist in the proxy-fronted
 * profiles), so the app-level posture must be self-sufficient: production
 * REQUIRES a strong FAYANMS_METRICS_TOKEN and refuses repository-public
 * placeholder values. Wired into findProductionPolicyViolations
 * (fail-close, same refusal block as every other production posture
 * violation); NO dev-path emitter is wired — dev/CI open behavior is
 * unchanged, exactly like every other production guard in this file.
 */
export function findMetricsTokenViolations(
  env: NodeJS.ProcessEnv = process.env
): PolicyViolation[] {
  const token = env[METRICS_TOKEN_ENV]?.trim() ?? "";
  if (token.length === 0) {
    return [
      {
        variable: METRICS_TOKEN_ENV,
        reason:
          "missing — /api/metrics then answers 200 UNAUTHENTICATED (process " +
          "gauges), and in a direct-published topology " +
          "(FAYANMS_TRUST_PROXY_HOPS=0) no edge proxy blocks it. Set a " +
          "strong bearer token: openssl rand -hex 32",
      },
    ];
  }
  if (isKnownBadMetricsToken(token)) {
    return [
      {
        variable: METRICS_TOKEN_ENV,
        reason:
          "matches a repository-public placeholder/known-weak value — a " +
          "verbatim deploy must not boot \"configured\" with a token any " +
          "reader of this repository knows. Generate a strong bearer " +
          "token: openssl rand -hex 32",
      },
    ];
  }
  return [];
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

  // Wave-11 F-5: hops > 0 without a DECLARED appending proxy is an insecure
  // posture (attacker-chosen XFF budget keys — see the guard's contract
  // above). Production fails loud, same refusal block as every other
  // violation; development behavior is unchanged (no dev emitter wired).
  violations.push(...findProxyHopsViolations(env));

  // Wave-12 F-1/F-2: the metrics surface must be self-sufficient without an
  // edge (the F-5 direct-publish topology sanctions one) — production
  // requires a strong FAYANMS_METRICS_TOKEN and refuses repository-public
  // placeholders (see the guard's contract above; dev posture unchanged).
  violations.push(...findMetricsTokenViolations(env));

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
