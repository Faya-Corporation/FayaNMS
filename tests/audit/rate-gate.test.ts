/**
 * SAFE-002 rate-gate contract tests (external ULTRA audit P0-002).
 *
 * Pins the two defect fixes at the unit level:
 *   1. PRE-HANDLER GATING — the response builders (ok/fail/failWithDetail)
 *      no longer consume rate slots; the only budget-consuming path is
 *      takeRateSlot(), which the proxy (src/proxy.ts) calls BEFORE any
 *      route handler runs. A rate-limited request therefore can never
 *      commit side effects first and answer 429 afterwards.
 *   2. SPOOF-RESISTANT CLIENT KEY — the leftmost X-Forwarded-For entries
 *      are attacker-controlled and are never used; the client is chosen
 *      N hops from the RIGHT (FAYANMS_TRUST_PROXY_HOPS, default 1), so
 *      rotating the forged leftmost entries cannot mint fresh budgets.
 *
 * Plus: sliding-window semantics (budgets, per-IP/kind isolation, expiry,
 * bounded store), the 429 envelope contract, and the machine-plane
 * exemption (verified service JWT → proxy passes through even at limit).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";

import {
  MAX_RATE_BUCKETS,
  RATE_LIMIT_AI,
  RATE_LIMIT_CSV_IMPORT,
  RATE_LIMIT_GET,
  RATE_LIMIT_MUTATION,
  RATE_WINDOW_MS,
  getTrustedProxyHops,
  rateKind,
  rateLimitedBody,
  rateLimitedHeaders,
  resetRateStoreForTests,
  resolveClientIp,
  resolveNamedRouteBudget,
  storeSizeForTests,
  takeRateSlot,
} from "@/lib/api/rate-gate";
import { fail, failWithDetail, ok } from "@/app/api/v1/_lib/api";
import { bearerTokenOf, resetServiceReplayCache, verifyServiceToken } from "@/lib/auth/service-jwt";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

const HOPS_ENV = "FAYANMS_TRUST_PROXY_HOPS";
let savedHopsEnv: string | undefined;

beforeEach(async () => {
  savedHopsEnv = process.env[HOPS_ENV];
  delete process.env[HOPS_ENV]; // default hops = 1 unless a block sets it
  await resetRateStoreForTests();
});

afterEach(() => {
  if (savedHopsEnv === undefined) delete process.env[HOPS_ENV];
  else process.env[HOPS_ENV] = savedHopsEnv;
});

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

/* ── hermetic service-plane sandbox (wave-11) ──────────────────────────────
 * The ambient worktree .env carries a MISMATCHED Ed25519 keypair (documented
 * in open-findings-batch-16), which makes the verifier EdDSA-only in this
 * sandbox and false-fails the HS256 fixtures below — in CI (no .env) they
 * run green for the right reason. The service-JWT blocks pin the env to
 * exactly the CI shape (symmetric plane only, no asymmetric material) and
 * restore it after each test; FAYANMS_SERVICE_ENV_FILE is pinned empty (the
 * R64 knob) so a worker-side .env fallback cannot re-supply ambient key
 * material behind the sandbox's back. The wave-11 jti replay bindings are
 * reset on both edges so block-scoped verifications cannot leak state.
 * ──────────────────────────────────────────────────────────────────────── */
const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_ENV_FILE",
] as const;
const TEST_SERVICE_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
let savedServiceEnv: Record<string, string | undefined> = {};

function pinHermeticServiceEnv(): void {
  savedServiceEnv = {};
  for (const key of SERVICE_ENV_KEYS) savedServiceEnv[key] = process.env[key];
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  process.env.FAYANMS_SERVICE_ENV_FILE = "";
  process.env.FAYANMS_SERVICE_SECRET = TEST_SERVICE_SECRET;
  resetServiceReplayCache();
}

function restoreServiceEnv(): void {
  for (const [key, value] of Object.entries(savedServiceEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServiceReplayCache();
}

/** Hand-mint an HS256 service JWT exactly per the Phase-19 contract. */
function mintTestServiceToken(overrides?: {
  issuer?: string;
  expired?: boolean;
}): string {
  const secret = TEST_SERVICE_SECRET;
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: overrides?.issuer ?? "fayanms:worker",
      sub: "worker-mini-service",
      aud: "fayanms:internal",
      iat: nowS,
      exp: overrides?.expired ? nowS - 3600 : nowS + 300,
      // wave-11 replay guard binds jti to a mint cycle — every mint is unique
      jti: randomUUID(),
      scopes: ["jobs"],
    })
  ).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${sig}`;
}

function proxyRequest(
  url: string,
  method: string,
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: headers ?? {},
  });
}

describe("SAFE-002 — rateKind classification", () => {
  test("GET/HEAD are read traffic; everything else (and unknown) mutates", async () => {
    expect(rateKind("GET")).toBe("get");
    expect(rateKind("HEAD")).toBe("get");
    expect(rateKind("POST")).toBe("mutation");
    expect(rateKind("PUT")).toBe("mutation");
    expect(rateKind("PATCH")).toBe("mutation");
    expect(rateKind("DELETE")).toBe("mutation");
    expect(rateKind("")).toBe("mutation");
    expect(rateKind("weird")).toBe("mutation");
  });
});

describe("SAFE-002 — trusted-proxy hop configuration", () => {
  test("default is 1 hop (single Caddy proxy), unset/blank env", async () => {
    expect(getTrustedProxyHops()).toBe(1);
    process.env[HOPS_ENV] = "  ";
    expect(getTrustedProxyHops()).toBe(1);
  });

  test("parses, floors and clamps 0..8; garbage falls back to 1", async () => {
    process.env[HOPS_ENV] = "3";
    expect(getTrustedProxyHops()).toBe(3);
    process.env[HOPS_ENV] = "2.9";
    expect(getTrustedProxyHops()).toBe(2);
    process.env[HOPS_ENV] = "12";
    expect(getTrustedProxyHops()).toBe(8);
    process.env[HOPS_ENV] = "-2";
    expect(getTrustedProxyHops()).toBe(0);
    process.env[HOPS_ENV] = "banana";
    expect(getTrustedProxyHops()).toBe(1);
  });
});

describe("SAFE-002 — spoof-resistant client key", () => {
  test("no proxy headers at all → shared 'local' bucket", async () => {
    expect(resolveClientIp(headersOf({}))).toBe("local");
  });

  test("single XFF entry (hops=1) → that entry", async () => {
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "203.0.113.7" }))
    ).toBe("203.0.113.7");
  });

  test("P0-002 PIN: leftmost XFF entry is attacker-controlled and ignored", async () => {
    // A proxy APPENDS the real client address; the leftmost value is
    // forgeable. The gate must pick the rightmost (hops=1).
    const headers = headersOf({
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    expect(resolveClientIp(headers)).toBe("203.0.113.7");
  });

  test("hops=2 → client as seen by the second trusted proxy", async () => {
    process.env[HOPS_ENV] = "2";
    const headers = headersOf({
      "x-forwarded-for": "10.9.9.9, 198.51.100.9, 203.0.113.7",
    });
    expect(resolveClientIp(headers)).toBe("198.51.100.9");
  });

  test("chain shorter than configured hops → leftmost (fail toward client)", async () => {
    process.env[HOPS_ENV] = "3";
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "203.0.113.7" }))
    ).toBe("203.0.113.7");
  });

  test("hops=0 trusts nothing — XFF and X-Real-IP collapse to 'local'", async () => {
    process.env[HOPS_ENV] = "0";
    expect(
      resolveClientIp(
        headersOf({
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.8",
        })
      )
    ).toBe("local");
  });

  test("X-Real-IP fallback when XFF absent", async () => {
    expect(
      resolveClientIp(headersOf({ "x-real-ip": "203.0.113.8" }))
    ).toBe("203.0.113.8");
  });

  test("unparseable tokens collapse to a stable opaque key (no bucket inflation)", async () => {
    const evil = "multi word!! bogus token"; // spaces + punctuation = not a client address
    const first = resolveClientIp(headersOf({ "x-forwarded-for": evil }));
    const second = resolveClientIp(headersOf({ "x-forwarded-for": evil }));
    expect(first).toStartWith("opaque:");
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual("opaque:".length + 16);
  });

  test("oversized tokens are hashed, not stored verbatim", async () => {
    const long = `${"a".repeat(100)}.9`; // valid charset but > 64 chars
    const key = resolveClientIp(headersOf({ "x-forwarded-for": long }));
    expect(key).toStartWith("opaque:");
  });

  test("IPv6 brackets survive the charset filter verbatim", async () => {
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "[2001:db8::1]" }))
    ).toBe("[2001:db8::1]");
  });
});

describe("SAFE-002 — sliding-window budgets", () => {
  test("mutation budget: 120 pass, 121st is limited with a sane Retry-After", async () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      expect((await takeRateSlot("10.0.0.1", "mutation")).limited).toBe(false);
    }
    const decision = await takeRateSlot("10.0.0.1", "mutation");
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(60);
    // Still limited while the window is fresh (no slot consumed by rejects).
    expect((await takeRateSlot("10.0.0.1", "mutation")).limited).toBe(true);
  });

  test("GET budget: 300 pass, 301st is limited", async () => {
    for (let i = 0; i < RATE_LIMIT_GET; i += 1) {
      expect((await takeRateSlot("10.0.0.2", "get")).limited).toBe(false);
    }
    expect((await takeRateSlot("10.0.0.2", "get")).limited).toBe(true);
  });

  test("per-IP isolation: exhausting one client never limits another", async () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      await takeRateSlot("10.0.0.1", "mutation");
    }
    expect((await takeRateSlot("10.0.0.1", "mutation")).limited).toBe(true);
    expect((await takeRateSlot("10.0.0.3", "mutation")).limited).toBe(false);
  });

  test("per-kind isolation: exhausted mutations do not throttle reads", async () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      await takeRateSlot("10.0.0.1", "mutation");
    }
    expect((await takeRateSlot("10.0.0.1", "mutation")).limited).toBe(true);
    expect((await takeRateSlot("10.0.0.1", "get")).limited).toBe(false);
  });

  test("window expiry: the budget frees after 60 s (deterministic clock)", async () => {
    const start = Date.now();
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      await takeRateSlot("10.0.0.1", "mutation", start);
    }
    expect((await takeRateSlot("10.0.0.1", "mutation", start)).limited).toBe(true);
    // One millisecond past the window, every stale stamp is filtered out.
    expect((await takeRateSlot("10.0.0.1", "mutation", start + RATE_WINDOW_MS + 1)).limited).toBe(false);
  });

  test("bounded store: stale buckets are swept when the cap is exceeded", async () => {
    const start = Date.now();
    // Backdate, then overfill with stale buckets.
    const backdated = start - 2 * RATE_WINDOW_MS;
    for (let i = 0; i < MAX_RATE_BUCKETS + 20; i += 1) {
      await takeRateSlot(`10.99.0.${i % 256}.${i}`, "get", backdated);
    }
    expect(storeSizeForTests()).toBeGreaterThan(MAX_RATE_BUCKETS);
    // One fresh hit triggers the sweep down to half the cap.
    expect((await takeRateSlot("10.0.0.9", "get", start)).limited).toBe(false);
    expect(storeSizeForTests()).toBeLessThanOrEqual(MAX_RATE_BUCKETS / 2 + 1);
  });
});

describe("SAFE-002 — response builders are pure envelope builders", () => {
  test("P0-002 PIN: ok() never rate-limits (400 calls > every budget)", async () => {
    for (let i = 0; i < 400; i += 1) {
      const response = ok({ n: i });
      expect(response.status).toBe(200);
    }
  });

  test("fail()/failWithDetail() never rate-limit and keep the envelope shape", async () => {
    for (let i = 0; i < 300; i += 1) {
      const response = fail("NOPE", "nope", 409);
      expect(response.status).toBe(409);
    }
    const withDetail = failWithDetail("AI_BAD_RESPONSE", "bad", 502, {
      raw: "x",
    });
    expect(withDetail.status).toBe(502);
    const withoutDetail = failWithDetail("AI_BAD_RESPONSE", "bad", 502);
    expect(withoutDetail.status).toBe(502);
  });

  test("requestId is stamped in both the header and the meta", async () => {
    const response = ok({ a: 1 });
    const headerId = response.headers.get("X-Request-Id") ?? "";
    expect(headerId.length).toBe(36);
    const parsed = (await response.json()) as {
      success: boolean;
      meta: { requestId: string };
    };
    expect(parsed.success).toBe(true);
    expect(parsed.meta.requestId).toBe(headerId);
  });
});

describe("SAFE-002 — 429 envelope contract", () => {
  test("body and headers carry code, retry window and request id", async () => {
    const body = rateLimitedBody(42, "req-1");
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toContain("42");
    expect(body.meta.requestId).toBe("req-1");

    const headers = rateLimitedHeaders(42, "req-1");
    expect(headers["Retry-After"]).toBe("42");
    expect(headers["X-Request-Id"]).toBe("req-1");
  });
});

describe("SAFE-002 — service-JWT core (machine-plane exemption fuel)", () => {
  beforeEach(pinHermeticServiceEnv);
  afterEach(restoreServiceEnv);

  test("valid token verifies with its principal; expired does not", async () => {
    const good = verifyServiceToken(mintTestServiceToken());
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.principal.id).toBe("worker-mini-service");
      expect(good.principal.issuer).toBe("fayanms:worker");
      expect(good.principal.scopes).toContain("jobs");
    }
    const expired = verifyServiceToken(mintTestServiceToken({ expired: true }));
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("SERVICE_TOKEN_EXPIRED");
  });

  test("tampered payload fails signature verification", async () => {
    const token = mintTestServiceToken();
    const [head, , sig] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ iss: "fayanms:worker", sub: "evil", aud: "fayanms:internal", exp: 9999999999 })
    ).toString("base64url");
    const result = verifyServiceToken(`${head}.${forgedBody}.${sig}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
  });

  test("bearerTokenOf extracts the token or returns null", async () => {
    expect(bearerTokenOf("Bearer  abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerTokenOf("bearer abc")).toBe("abc");
    expect(bearerTokenOf("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerTokenOf(null)).toBeNull();
  });
});

describe("SAFE-002 — proxy wiring (pre-handler order)", () => {
  // Same hermetic sandbox: the exemption pins present an HS256 fixture to
  // the proxy's verifyServiceToken — the ambient .env keypair would false-
  // fail the verification outside CI (the pin itself is unchanged).
  beforeEach(pinHermeticServiceEnv);
  afterEach(restoreServiceEnv);

  test("unauthenticated POSTs consume slots BEFORE the 401 and 429 by #121", async () => {
    const headers = { "x-forwarded-for": "attacker-rotated, 10.0.0.1" };
    let saw401 = 0;
    let saw429 = 0;
    for (let i = 1; i <= RATE_LIMIT_MUTATION + 1; i += 1) {
      const req = proxyRequest("/api/v1/devices", "POST", {
        ...headers,
        "x-forwarded-for": `rotated-${i}, 10.0.0.1`, // leftmost rotates freely
      });
      const response = await proxy(req);
      if (response.status === 401) saw401 += 1;
      if (response.status === 429) {
        saw429 += 1;
        expect(response.headers.get("Retry-After")).toBeTruthy();
        expect(response.headers.get("X-Request-Id")).toBeTruthy();
      } else {
        // Rotating the attacker-controlled leftmost entry must NOT reset
        // the budget — every request shares the 10.0.0.1 bucket.
        expect(response.status).toBe(401);
      }
    }
    expect(saw429).toBe(1);
    expect(saw401).toBe(RATE_LIMIT_MUTATION);
  });

  test("verified service JWT bypasses the budget even when its bucket is exhausted", async () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      await takeRateSlot("10.0.0.1", "mutation");
    }
    const req = proxyRequest("/api/v1/worker/claim", "POST", {
      "x-forwarded-for": "10.0.0.1",
      authorization: `Bearer ${mintTestServiceToken()}`,
    });
    const response = await proxy(req);
    expect(response.status).toBe(200); // NextResponse.next()
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("expired service tokens do NOT earn the exemption", async () => {
    // A NON-exempt route: an invalid machine token must fall through to the
    // session plane (no cookie → 401), never to a free pass.
    const req = proxyRequest("/api/v1/devices", "POST", {
      "x-forwarded-for": "10.0.0.77",
      authorization: `Bearer ${mintTestServiceToken({ expired: true })}`,
    });
    const response = await proxy(req);
    expect(response.status).toBe(401);
  });

  test("GET traffic rides the read budget, not the mutation budget", async () => {
    const headers = { "x-forwarded-for": "10.0.0.5" };
    let limitedSeen = 0;
    for (let i = 0; i < RATE_LIMIT_GET + 5; i += 1) {
      const response = await proxy(
        proxyRequest("/api/v1/devices", "GET", headers)
      );
      if (response.status === 429) limitedSeen += 1;
    }
    // 301st..305th are limited (401s would need a session; the limiter
    // fires before the session check, so the 429s are the proof).
    expect(limitedSeen).toBe(5);
  });
});

describe("HC-1 — named per-endpoint budgets (high-cost surfaces)", () => {
  test("budget-table literals: ai family → 10/min, csv-import → 5/min", () => {
    expect(RATE_LIMIT_AI).toBe(10);
    expect(RATE_LIMIT_CSV_IMPORT).toBe(5);
  });

  test("registry lookup: every AI route maps to the shared ai family budget", () => {
    for (const route of ["query", "assist", "change-draft", "rca-draft"]) {
      expect(resolveNamedRouteBudget(`/api/v1/ai/${route}`)).toEqual({
        family: "ai",
        limit: RATE_LIMIT_AI,
      });
    }
  });

  test("registry lookup: csv-import matches EXACTLY — sibling device routes stay on defaults", () => {
    expect(resolveNamedRouteBudget("/api/v1/devices/csv-import")).toEqual({
      family: "devices:csv-import",
      limit: RATE_LIMIT_CSV_IMPORT,
    });
    for (const sibling of [
      "/api/v1/devices",
      "/api/v1/devices/csv-export",
      "/api/v1/devices/csv-import/review",
      "/api/v1/devices/dev-1",
    ]) {
      expect(resolveNamedRouteBudget(sibling)).toBeNull();
    }
  });

  test("registry lookup: prefix discipline — sibling names and bare family never match", () => {
    for (const path of [
      "/api/v1/ai",
      "/api/v1/aiques",
      "/api/v1/aidevices",
      "/api/v1/devices",
      "/api/v1/meta",
    ]) {
      expect(resolveNamedRouteBudget(path)).toBeNull();
    }
  });

  test("decision: ai family answers 429 from its OWN bucket — 10 pass, 11th limited", async () => {
    for (let i = 0; i < RATE_LIMIT_AI; i += 1) {
      expect(
        (await takeRateSlot("10.1.0.1", "mutation", undefined, "/api/v1/ai/query")).limited
      ).toBe(false);
    }
    const decision = await takeRateSlot(
      "10.1.0.1",
      "mutation",
      undefined,
      "/api/v1/ai/assist"
    );
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test("decision: the named bucket does not touch the shared client-kind pools", async () => {
    for (let i = 0; i < RATE_LIMIT_AI; i += 1) {
      await takeRateSlot("10.1.0.2", "mutation", undefined, "/api/v1/ai/query");
    }
    // ai family exhausted for this client…
    expect(
      (await takeRateSlot("10.1.0.2", "mutation", undefined, "/api/v1/ai/query")).limited
    ).toBe(true);
    // …but the plain mutation pool for the SAME client is untouched…
    expect((await takeRateSlot("10.1.0.2", "mutation")).limited).toBe(false);
    // …and the csv-import family is a DIFFERENT named bucket.
    expect(
      (await takeRateSlot("10.1.0.2", "mutation", undefined, "/api/v1/devices/csv-import")).limited
    ).toBe(false);
  });

  test("decision: csv-import family — 5 pass, 6th limited with a sane Retry-After", async () => {
    for (let i = 0; i < RATE_LIMIT_CSV_IMPORT; i += 1) {
      expect(
        (await takeRateSlot("10.1.0.3", "mutation", undefined, "/api/v1/devices/csv-import")).limited
      ).toBe(false);
    }
    const decision = await takeRateSlot(
      "10.1.0.3",
      "mutation",
      undefined,
      "/api/v1/devices/csv-import"
    );
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test("documented default: no pathname (and unknown routes) keep the kind budgets", async () => {
    // No pathname → legacy signature semantics unchanged.
    expect((await takeRateSlot("10.1.0.4", "mutation")).limited).toBe(false);
    // An unknown route consumes the DEFAULT mutation bucket, not a named one.
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      expect(
        (await takeRateSlot("10.1.0.5", "mutation", undefined, "/api/v1/sites")).limited
      ).toBe(false);
    }
    expect((await takeRateSlot("10.1.0.5", "mutation", undefined, "/api/v1/sites")).limited).toBe(
      true
    );
  });

  test("proxy wiring: the pathname reaches takeRateSlot (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const proxySrc = readFileSync("src/proxy.ts", "utf8");
    expect(proxySrc).toContain(
      "takeRateSlot(clientKey, kind, Date.now(), pathname)"
    );
  });

  test("proxy end-to-end: 11 rapid calls on ai/query → ten 401s then ONE 429 from the ai budget", async () => {
    const headers = { "x-forwarded-for": "10.1.1.1" };
    let saw401 = 0;
    let saw429 = 0;
    for (let i = 0; i < RATE_LIMIT_AI + 1; i += 1) {
      const response = await proxy(
        proxyRequest("/api/v1/ai/query", "POST", headers)
      );
      if (response.status === 429) {
        saw429 += 1;
        expect(response.headers.get("Retry-After")).toBeTruthy();
        expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
        const body = (await response.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("RATE_LIMITED");
      } else {
        // Unauthenticated calls consume an ai slot and fall through to the
        // session plane — the 401 proves the limiter fired BEFORE auth.
        expect(response.status).toBe(401);
        saw401 += 1;
      }
    }
    expect(saw429).toBe(1);
    expect(saw401).toBe(RATE_LIMIT_AI);
  });

  test("proxy end-to-end: exhausting the ai budget never throttles other routes", async () => {
    // Burn the ai family for this client via the proxy plane…
    const aiHeaders = { "x-forwarded-for": "10.1.1.2" };
    for (let i = 0; i < RATE_LIMIT_AI; i += 1) {
      await proxy(proxyRequest("/api/v1/ai/query", "POST", aiHeaders));
    }
    // …then a NORMAL route for the same client still reaches its handler
    // (401 session envelope — NOT a 429), because the named bucket is the
    // ai family's own.
    const response = await proxy(
      proxyRequest("/api/v1/devices", "POST", aiHeaders)
    );
    expect(response.status).toBe(401);
  });
});
