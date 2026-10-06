/**
 * Wave-11 MACHINE plane — audit 15-c fixes (trace 1a10d76de6d970cd).
 *
 *   F-1 REPLAY GUARD    service-jwt.ts verifyServiceToken + the worker's
 *                       control-auth.ts verifyControlToken now enforce a
 *                       mint-cycle FRESHNESS WINDOW (not single-use): a
 *                       token whose iat is older than TTL+skew is
 *                       *_TOKEN_STALE no matter what its exp claims, and a
 *                       jti that reappears in a DIFFERENT mint cycle
 *                       (different iat/exp) is *_REPLAY_DETECTED. The
 *                       machine plane is a CACHED-TOKEN design — every
 *                       minter reuses ONE token for many requests until
 *                       60 s before expiry — so the same token MUST keep
 *                       verifying within its cycle (the loop-compat pins
 *                       below would fail under a seen-once deny-cache).
 *   F-2 EVENTS STRIP    /api/v1/events puts BEARER (API-client) principals
 *                       into the strip class ALWAYS: the bearer plane
 *                       resolves null claims → wildcard, which used to skip
 *                       the F-031 strip and hand the unstripped global
 *                       audit stream to a non-expiring alerts.read token.
 *                       Wildcard HUMAN sessions keep the documented
 *                       unstripped posture (contrast pin).
 *
 * Rig notes: the service-plane unit pins run fully hermetic — every
 * FAYANMS_SERVICE_* variable is sandboxed (the worktree .env keypair is a
 * MISMATCHED pair, batch-16 documented) and FAYANMS_SERVICE_ENV_FILE is
 * pinned empty (the R64 knob) so the worker's .env-file fallback cannot
 * re-supply ambient material behind the sandbox's back. The events pins
 * use the certified batch-25/wave-9 rig: real route handler, REAL next-auth
 * JWT, RUN-suffixed fixtures, surgical afterAll cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import {
  SERVICE_REPLAY_CACHE_MAX,
  SERVICE_TOKEN_MAX_AGE_S,
  bearerTokenOf,
  checkServiceReplay,
  resetServiceReplayCache,
  verifyServiceToken,
} from "../../src/lib/auth/service-jwt";
import {
  resetServiceTokenCache,
  serviceAuthToken,
} from "../../mini-services/worker/service-token";
import {
  checkControlReplay,
  resetControlReplayCache,
  verifyControlToken,
} from "../../mini-services/worker/control-auth";

/* ── hermetic service-env sandbox (service-identity.test.ts convention) ── */

const TEST_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_ENV_FILE",
] as const;

/** Full env sandbox — every service-plane variable is explicitly managed. */
async function withServiceEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  // The R64 hermeticity knob: explicit empty disables the worker's
  // repo-root .env fallback (the worktree .env carries key material).
  process.env.FAYANMS_SERVICE_ENV_FILE = "";
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ── hand-mint helpers (full control over iat/exp/jti) ──────────────────── */

function handMintHS256(options: {
  iss?: string;
  sub?: string;
  iatOffsetS?: number; // iat = now + offset (negative = old)
  iat?: number; // overrides iatOffsetS
  expOffsetS?: number; // exp = iat + offset (default 300, the mint TTL)
  jti?: string | null;
  scopes?: string[];
}): string {
  const nowS = Math.floor(Date.now() / 1000);
  const iat = options.iat ?? nowS + (options.iatOffsetS ?? 0);
  const exp = iat + (options.expOffsetS ?? 300);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload: Record<string, unknown> = {
    iss: options.iss ?? "fayanms:worker",
    sub: options.sub ?? "worker-mini-service",
    aud: "fayanms:internal",
    iat,
    exp,
    scopes: options.scopes ?? ["jobs"],
  };
  if (options.jti !== null) payload.jti = options.jti ?? randomUUID();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", TEST_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Hand-mint a control token the way the worker's verifier expects it. */
function handMintControl(options: {
  iatOffsetS?: number;
  expOffsetS?: number;
  jti?: string | null;
  scopes?: string[];
}): string {
  return handMintHS256({
    iss: "fayanms:control",
    sub: "control-plane",
    scopes: options.scopes ?? ["simulate"],
    iatOffsetS: options.iatOffsetS,
    expOffsetS: options.expOffsetS,
    jti: options.jti,
  });
}

function workerRequest(token: string): Request {
  return new Request("http://worker:3030/simulate/start", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

/* ══════════════════════ source pins (the differential contract) ═════════ */

describe("wave11 machine: source contract", () => {
  test("the app verifier carries the freshness window + jti mint-cycle binding", () => {
    const src = readFileSync("src/lib/auth/service-jwt.ts", "utf8");
    expect(src).toContain("SERVICE_TOKEN_STALE");
    expect(src).toContain("SERVICE_REPLAY_DETECTED");
    expect(src).toContain("SERVICE_REPLAY_CACHE_MAX");
    expect(src).toContain("export function checkServiceReplay(");
    expect(src).toContain("export function resetServiceReplayCache(");
    // The guard runs inside verifyServiceToken, after the issuer allowlist.
    expect(src).toContain("Wave-11 replay guard (audit 15-c F-1)");
  });

  test("the worker verifier mirrors the SAME guard shape (WORKER_* codes)", () => {
    const src = readFileSync("mini-services/worker/control-auth.ts", "utf8");
    expect(src).toContain("WORKER_TOKEN_STALE");
    expect(src).toContain("WORKER_REPLAY_DETECTED");
    expect(src).toContain("CONTROL_REPLAY_CACHE_MAX");
    expect(src).toContain("export function checkControlReplay(");
    expect(src).toContain("export function resetControlReplayCache(");
    // Zero new dependencies (the worker mini-service has its own tree):
    // only node: builtins may appear.
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) expect(spec.startsWith("node:")).toBe(true);
  });

  test("the events route puts bearer principals into the strip class unconditionally", () => {
    const src = readFileSync("src/app/api/v1/events/route.ts", "utf8");
    expect(src).toContain("F-2 wave-11 (audit 15-c P3-3)");
    // P1-A05 (GA re-audit 2026-10-06): the bearer plane now resolves its
    // RESOURCE scope into claims too, so the strip-class key moved from
    // "claims === null" to "claims are not a human session" — the strip
    // class still applies to EVERY non-human principal unconditionally.
    expect(src).toContain("const bearerPrincipalId = claimsAreHuman ? null : principal.id;");
    // The bearer branch comes FIRST and ignores the resolved scope mode.
    expect(src).toContain("if (bearerPrincipalId !== null) {");
    expect(src).toContain("} else if (!isWildcard) {");
    // The wave-10 minimum-mitigation pins survive untouched.
    expect(src).toContain("MINIMUM MITIGATION ONLY");
    expect(src).toContain("siteScopeAllows(scope, d.site?.code ?? null)");
  });
});

/* ══════════════ F-1: the app verifier's replay guard (behavioral) ═══════ */

describe("wave11 F-1: app verifier replay window (SERVICE_*)", () => {
  test("a fresh token verifies and the SAME token re-verifies (cached-token reuse)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      const token = handMintHS256({});
      const first = verifyServiceToken(token);
      expect(first.ok).toBe(true);
      // Proxy pre-check + handler re-check + worker reuse: the same token
      // MUST keep verifying within its mint cycle — a seen-once deny-cache
      // would break the machine plane on the second request.
      for (let i = 0; i < 3; i += 1) {
        const again = verifyServiceToken(token);
        expect(again.ok).toBe(true);
      }
    });
  });

  test("a token with an OLD iat is refused even when its exp is still far out (SERVICE_TOKEN_STALE)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      // The captured-token shape that motivated 15-c F-1: minted long-lived
      // (exp claims hours), iat already outside the 300 s + 30 s window.
      const stale = handMintHS256({ iatOffsetS: -400, expOffsetS: 7200 - 400 });
      const result = verifyServiceToken(stale);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("SERVICE_TOKEN_STALE");
        expect(result.message).toMatch(/mint-cycle window/);
      }
    });
  });

  test("expiry still answers first: an expired token keeps SERVICE_TOKEN_EXPIRED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      const expired = handMintHS256({ iatOffsetS: -400, expOffsetS: -100 });
      const result = verifyServiceToken(expired);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_EXPIRED");
    });
  });

  test("a jti re-minted into a DIFFERENT mint cycle is refused (SERVICE_REPLAY_DETECTED)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      const jti = randomUUID();
      // Cycle 1 verifies and binds (jti → iat/exp).
      const cycleOne = handMintHS256({ iatOffsetS: -2, expOffsetS: 300, jti });
      expect(verifyServiceToken(cycleOne).ok).toBe(true);
      // A re-mint reusing the jti at a different iat — a minter bug or a
      // forged replay — fails closed.
      const reMint = handMintHS256({ iatOffsetS: 0, expOffsetS: 300, jti });
      const r1 = verifyServiceToken(reMint);
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.code).toBe("SERVICE_REPLAY_DETECTED");
      // Same jti + same iat but a different exp is the same collision class.
      const sameIatNewExp = handMintHS256({ iat: Math.floor(Date.now() / 1000) - 2, expOffsetS: 301, jti });
      const r2 = verifyServiceToken(sameIatNewExp);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.code).toBe("SERVICE_REPLAY_DETECTED");
    });
  });

  test("a token WITHOUT jti still verifies and re-verifies (the guard invents no requirements)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      const token = handMintHS256({ jti: null });
      expect(verifyServiceToken(token).ok).toBe(true);
      expect(verifyServiceToken(token).ok).toBe(true);
    });
  });

  test("the two-plane loop stays green: worker mint → verify → re-verify → RE-MINT → verify", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceReplayCache();
      resetServiceTokenCache();
      // The worker's real minter: ONE cached token, reused for many calls.
      const token = serviceAuthToken();
      const header = JSON.parse(
        Buffer.from(bearerTokenOf(`Bearer ${token}`)!.split(".")[0], "base64url").toString("utf8")
      ) as { alg: string };
      expect(header.alg).toBe("HS256"); // sandbox has no private key
      expect(verifyServiceToken(token).ok).toBe(true);
      expect(verifyServiceToken(token).ok).toBe(true);
      // Re-mint cycle (60 s before expiry in production): NEW jti, and the
      // new cycle verifies — the guard never wedges the loop.
      resetServiceTokenCache();
      const nextCycle = serviceAuthToken();
      expect(nextCycle).not.toBe(token);
      const result = verifyServiceToken(nextCycle);
      expect(result.ok).toBe(true);
      resetServiceTokenCache();
    });
  });

  test("the freshness window boundary and the cache eviction are exact (injected clock)", () => {
    resetServiceReplayCache();
    // Boundary: TTL + skew itself is inside the window, one second past is not.
    const now = 10_000;
    expect(checkServiceReplay("j-boundary", now - SERVICE_TOKEN_MAX_AGE_S, now + 300, now).ok).toBe(true);
    const past = checkServiceReplay("j-past", now - SERVICE_TOKEN_MAX_AGE_S - 1, now + 300, now);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.code).toBe("SERVICE_TOKEN_STALE");
    // A token without iat skips the window (the wire contract keeps iat
    // optional; minters always set it).
    expect(checkServiceReplay("j-no-iat", null, now + 300, now).ok).toBe(true);

    // Expiry eviction: a binding whose token can no longer be presented
    // LAPSES (dropped on sight on the get path), so its jti may legitimately
    // reappear in a LATER mint cycle — no over-rejection of live cycles.
    expect(checkServiceReplay("j-expired", 800, 1000, 900).ok).toBe(true);
    const afterExpiry = checkServiceReplay("j-expired", 1031, 1331, 1031);
    expect(afterExpiry.ok).toBe(true); // lapsed binding was dropped on sight

    // Hard cap: inserting past the cap evicts the OLDEST bindings — the map
    // stays bounded, and an evicted jti's collision protection lapses (the
    // stateless freshness window still applies).
    resetServiceReplayCache();
    for (let i = 0; i < SERVICE_REPLAY_CACHE_MAX; i += 1) {
      expect(checkServiceReplay(`cap-${i}`, 1000, 2000, 1000).ok).toBe(true);
    }
    expect(checkServiceReplay("cap-overflow", 1000, 2000, 1000).ok).toBe(true);
    // The overflow insert evicted cap-0 (the oldest binding) — cap-1 is
    // still bound to its mint cycle (read-only check, no insert happens).
    const stillBound = checkServiceReplay("cap-1", 1050, 2000, 1000);
    expect(stillBound.ok).toBe(false);
    if (!stillBound.ok) expect(stillBound.code).toBe("SERVICE_REPLAY_DETECTED");
    // Rebinding the EVICTED cap-0 is accepted again (and the insert itself
    // evicts the next-oldest entry to stay under the cap).
    expect(checkServiceReplay("cap-0", 1050, 2000, 1000).ok).toBe(true);
    resetServiceReplayCache();
  });
});

/* ═════════════ F-1 mirror: the worker verifier's replay guard ═══════════ */

describe("wave11 F-1: worker verifier replay window (WORKER_*)", () => {
  test("a fresh control token verifies and re-verifies; a stale-iatted one is WORKER_TOKEN_STALE", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetControlReplayCache();
      const token = handMintControl({});
      expect(verifyControlToken(workerRequest(token), "simulate").ok).toBe(true);
      // Control-plane cached-token reuse (control-client.ts mints ONE
      // 300 s token and reuses it for many worker-bound calls).
      expect(verifyControlToken(workerRequest(token), "simulate").ok).toBe(true);

      const stale = handMintControl({ iatOffsetS: -400, expOffsetS: 6800 });
      const result = verifyControlToken(workerRequest(stale), "simulate");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("WORKER_TOKEN_STALE");
        expect(result.message).toMatch(/mint-cycle window/);
      }
    });
  });

  test("a re-minted jti is WORKER_REPLAY_DETECTED; the guard outranks the scope check (401 class)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetControlReplayCache();
      const jti = randomUUID();
      const cycleOne = handMintControl({ iatOffsetS: -1, jti });
      expect(verifyControlToken(workerRequest(cycleOne), "simulate").ok).toBe(true);

      // Re-mint the same jti into a new cycle, presented against an
      // endpoint whose scope it LACKS: the replay answer (authentication,
      // 401 class) must win over WORKER_SCOPE_INSUFFICIENT (authorization,
      // 403 class).
      const reMint = handMintControl({ iatOffsetS: 1, jti, scopes: ["jobs"] });
      const result = verifyControlToken(workerRequest(reMint), "simulate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("WORKER_REPLAY_DETECTED");
    });
  });

  test("worker precedence intact: an expired token still answers WORKER_TOKEN_EXPIRED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetControlReplayCache();
      const expired = handMintControl({ iatOffsetS: -400, expOffsetS: -100 });
      const result = verifyControlToken(workerRequest(expired), "simulate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("WORKER_TOKEN_EXPIRED");
    });
  });

  test("the worker's pure guard mirrors the freshness boundary exactly", () => {
    resetControlReplayCache();
    const now = 20_000;
    expect(checkControlReplay("c-boundary", now - 330, now + 300, now).ok).toBe(true);
    const past = checkControlReplay("c-past", now - 331, now + 300, now);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.code).toBe("WORKER_TOKEN_STALE");
    resetControlReplayCache();
  });
});

/* ═════════════ F-2: the events strip class covers bearer principals ═════ */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const CLIENT_TOKEN = `${RUN}${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`
  .replaceAll("-", "")
  .slice(0, 43);
const EVENT_CORRELATION = `w11-${RUN}`;
const HUMAN_EMAIL = `w11-human-${RUN.toLowerCase()}@faya.local`;

let humanActorId = "";
let clientId = "";

type EventRow = {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  resourceId: string | null;
  resourceLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  beforeJson: unknown;
  afterJson: unknown;
};

type Envelope = { data?: unknown; error?: { code?: string } };

async function eventsGet(headers: Record<string, string>): Promise<Response> {
  const mod = (await import("../../src/app/api/v1/events/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  return mod.GET(
    new NextRequest(`http://app.local/api/v1/events?correlationId=${EVENT_CORRELATION}&pageSize=10`, {
      method: "GET",
      headers,
    })
  );
}

/** The certified wave-10 session-mint helper (real next-auth encode). */
async function humanWildcardJwt(): Promise<string> {
  return encode({
    token: {
      id: humanActorId,
      email: HUMAN_EMAIL,
      name: "W11 Machine Human",
      role: "admin",
      // NO sites claim — the wildcard human contrast principal.
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

beforeAll(async () => {
  // The admin role (ROLE_MATRIX) backs the wildcard human session — the
  // certified batch-25 pattern; the user rows are RUN-suffixed throwaways.
  const human = await db.user.create({
    data: { email: HUMAN_EMAIL, name: "W11 Machine Human", role: "admin", isActive: true },
    select: { id: true },
  });
  humanActorId = human.id;

  const client = await db.apiClient.create({
    data: {
      name: `w11-client-${RUN}`,
      tokenHash: createHash("sha256").update(CLIENT_TOKEN, "utf8").digest("hex"),
      tokenPrefix: CLIENT_TOKEN.slice(0, 8),
      scopesJson: JSON.stringify(["alerts.read"]), // /api/v1/events → alert.read
      isActive: true,
    },
    select: { id: true },
  });
  clientId = client.id;

  // Two rows with full identity payloads. Row C is CLIENT-attributed the
  // way auditAttribution writes it (actorId NULL — AuditEvent.actorId is a
  // User FK — with the "api-client:" name); row H is the human actor's.
  // resourceType Device with an arbitrary id: the bearer plane can never
  // prove anything in-scope, so the identity fields must strip regardless.
  // Per-row create (db.auditEvent.createMany refuses to bypass the
  // tamper-evident chain stamping — RT-012/F-014).
  await db.auditEvent.create({
    data: {
      actorId: null,
      actorName: `api-client: w11-client-${RUN}`,
      action: "DEVICE_UPDATED",
      resourceType: "Device",
      resourceId: `w11-dev-${RUN}`,
      resourceLabel: `w11-host-${RUN.toLowerCase()}`,
      result: "SUCCESS",
      ip: "192.0.2.11",
      userAgent: "w11-machine-agent",
      correlationId: EVENT_CORRELATION,
      beforeJson: JSON.stringify({ w11: "c-before" }),
      afterJson: JSON.stringify({ w11: "c-after" }),
    },
  });
  await db.auditEvent.create({
    data: {
      actorId: humanActorId,
      actorName: "W11 Machine Human",
      action: "DEVICE_UPDATED",
      resourceType: "Device",
      resourceId: `w11-dev-${RUN}`,
      resourceLabel: `w11-host-${RUN.toLowerCase()}`,
      result: "SUCCESS",
      ip: "192.0.2.12",
      userAgent: "w11-human-agent",
      correlationId: EVENT_CORRELATION,
      beforeJson: JSON.stringify({ w11: "h-before" }),
      afterJson: JSON.stringify({ w11: "h-after" }),
    },
  });
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { correlationId: EVENT_CORRELATION } });
  if (clientId) await db.apiClient.deleteMany({ where: { id: clientId } });
  if (humanActorId) await db.user.deleteMany({ where: { id: humanActorId } });
});

describe("wave11 F-2: GET /api/v1/events bearer strip class", () => {
  test("an API-client bearer principal gets the STRIPPED stream (ip/UA/labels/payloads)", async () => {
    const res = await eventsGet({ authorization: `Bearer ${CLIENT_TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as EventRow[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Identity fields strip fail-closed for the bearer plane — including
      // the row the client itself "authored" (its attribution is actorId
      // null, so the own-actor carve-out cannot exempt it).
      expect(row.resourceLabel).toBeNull();
      expect(row.ip).toBeNull();
      expect(row.userAgent).toBeNull();
      expect(row.beforeJson).toBeNull();
      expect(row.afterJson).toBeNull();
      // Non-identity envelope survives (the row stays usable telemetry).
      expect(row.action).toBe("DEVICE_UPDATED");
      expect(row.resourceId).toBe(`w11-dev-${RUN}`);
    }
  });

  test("contrast: a wildcard HUMAN session keeps the verbatim rows (documented posture)", async () => {
    const res = await eventsGet({ cookie: `next-auth.session-token=${await humanWildcardJwt()}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as EventRow[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.resourceLabel).toBe(`w11-host-${RUN.toLowerCase()}`);
      expect(row.ip).not.toBeNull();
      expect(row.userAgent).not.toBeNull();
      expect(row.beforeJson).toEqual(row.actorId === humanActorId ? { w11: "h-before" } : { w11: "c-before" });
    }
  });
});
