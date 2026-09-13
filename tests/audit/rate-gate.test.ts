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
import { createHmac } from "node:crypto";

import {
  MAX_RATE_BUCKETS,
  RATE_LIMIT_GET,
  RATE_LIMIT_MUTATION,
  RATE_WINDOW_MS,
  getTrustedProxyHops,
  rateKind,
  rateLimitedBody,
  rateLimitedHeaders,
  resetRateStoreForTests,
  resolveClientIp,
  storeSizeForTests,
  takeRateSlot,
} from "@/lib/api/rate-gate";
import { fail, failWithDetail, ok } from "@/app/api/v1/_lib/api";
import { bearerTokenOf, verifyServiceToken } from "@/lib/auth/service-jwt";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

const HOPS_ENV = "FAYANMS_TRUST_PROXY_HOPS";
let savedHopsEnv: string | undefined;

beforeEach(() => {
  savedHopsEnv = process.env[HOPS_ENV];
  delete process.env[HOPS_ENV]; // default hops = 1 unless a block sets it
  resetRateStoreForTests();
});

afterEach(() => {
  if (savedHopsEnv === undefined) delete process.env[HOPS_ENV];
  else process.env[HOPS_ENV] = savedHopsEnv;
});

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

/** Hand-mint an HS256 service JWT exactly per the Phase-19 contract. */
function mintTestServiceToken(overrides?: {
  issuer?: string;
  expired?: boolean;
}): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
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
      jti: "test-jti",
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
  test("GET/HEAD are read traffic; everything else (and unknown) mutates", () => {
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
  test("default is 1 hop (single Caddy proxy), unset/blank env", () => {
    expect(getTrustedProxyHops()).toBe(1);
    process.env[HOPS_ENV] = "  ";
    expect(getTrustedProxyHops()).toBe(1);
  });

  test("parses, floors and clamps 0..8; garbage falls back to 1", () => {
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
  test("no proxy headers at all → shared 'local' bucket", () => {
    expect(resolveClientIp(headersOf({}))).toBe("local");
  });

  test("single XFF entry (hops=1) → that entry", () => {
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "203.0.113.7" }))
    ).toBe("203.0.113.7");
  });

  test("P0-002 PIN: leftmost XFF entry is attacker-controlled and ignored", () => {
    // A proxy APPENDS the real client address; the leftmost value is
    // forgeable. The gate must pick the rightmost (hops=1).
    const headers = headersOf({
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    expect(resolveClientIp(headers)).toBe("203.0.113.7");
  });

  test("hops=2 → client as seen by the second trusted proxy", () => {
    process.env[HOPS_ENV] = "2";
    const headers = headersOf({
      "x-forwarded-for": "10.9.9.9, 198.51.100.9, 203.0.113.7",
    });
    expect(resolveClientIp(headers)).toBe("198.51.100.9");
  });

  test("chain shorter than configured hops → leftmost (fail toward client)", () => {
    process.env[HOPS_ENV] = "3";
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "203.0.113.7" }))
    ).toBe("203.0.113.7");
  });

  test("hops=0 trusts nothing — XFF and X-Real-IP collapse to 'local'", () => {
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

  test("X-Real-IP fallback when XFF absent", () => {
    expect(
      resolveClientIp(headersOf({ "x-real-ip": "203.0.113.8" }))
    ).toBe("203.0.113.8");
  });

  test("unparseable tokens collapse to a stable opaque key (no bucket inflation)", () => {
    const evil = "multi word!! bogus token"; // spaces + punctuation = not a client address
    const first = resolveClientIp(headersOf({ "x-forwarded-for": evil }));
    const second = resolveClientIp(headersOf({ "x-forwarded-for": evil }));
    expect(first).toStartWith("opaque:");
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual("opaque:".length + 16);
  });

  test("oversized tokens are hashed, not stored verbatim", () => {
    const long = `${"a".repeat(100)}.9`; // valid charset but > 64 chars
    const key = resolveClientIp(headersOf({ "x-forwarded-for": long }));
    expect(key).toStartWith("opaque:");
  });

  test("IPv6 brackets survive the charset filter verbatim", () => {
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "[2001:db8::1]" }))
    ).toBe("[2001:db8::1]");
  });
});

describe("SAFE-002 — sliding-window budgets", () => {
  test("mutation budget: 120 pass, 121st is limited with a sane Retry-After", () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      expect(takeRateSlot("10.0.0.1", "mutation").limited).toBe(false);
    }
    const decision = takeRateSlot("10.0.0.1", "mutation");
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(60);
    // Still limited while the window is fresh (no slot consumed by rejects).
    expect(takeRateSlot("10.0.0.1", "mutation").limited).toBe(true);
  });

  test("GET budget: 300 pass, 301st is limited", () => {
    for (let i = 0; i < RATE_LIMIT_GET; i += 1) {
      expect(takeRateSlot("10.0.0.2", "get").limited).toBe(false);
    }
    expect(takeRateSlot("10.0.0.2", "get").limited).toBe(true);
  });

  test("per-IP isolation: exhausting one client never limits another", () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      takeRateSlot("10.0.0.1", "mutation");
    }
    expect(takeRateSlot("10.0.0.1", "mutation").limited).toBe(true);
    expect(takeRateSlot("10.0.0.3", "mutation").limited).toBe(false);
  });

  test("per-kind isolation: exhausted mutations do not throttle reads", () => {
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      takeRateSlot("10.0.0.1", "mutation");
    }
    expect(takeRateSlot("10.0.0.1", "mutation").limited).toBe(true);
    expect(takeRateSlot("10.0.0.1", "get").limited).toBe(false);
  });

  test("window expiry: the budget frees after 60 s (deterministic clock)", () => {
    const start = Date.now();
    for (let i = 0; i < RATE_LIMIT_MUTATION; i += 1) {
      takeRateSlot("10.0.0.1", "mutation", start);
    }
    expect(takeRateSlot("10.0.0.1", "mutation", start).limited).toBe(true);
    // One millisecond past the window, every stale stamp is filtered out.
    expect(takeRateSlot("10.0.0.1", "mutation", start + RATE_WINDOW_MS + 1).limited).toBe(false);
  });

  test("bounded store: stale buckets are swept when the cap is exceeded", () => {
    const start = Date.now();
    // Backdate, then overfill with stale buckets.
    const backdated = start - 2 * RATE_WINDOW_MS;
    for (let i = 0; i < MAX_RATE_BUCKETS + 20; i += 1) {
      takeRateSlot(`10.99.0.${i % 256}.${i}`, "get", backdated);
    }
    expect(storeSizeForTests()).toBeGreaterThan(MAX_RATE_BUCKETS);
    // One fresh hit triggers the sweep down to half the cap.
    expect(takeRateSlot("10.0.0.9", "get", start).limited).toBe(false);
    expect(storeSizeForTests()).toBeLessThanOrEqual(MAX_RATE_BUCKETS / 2 + 1);
  });
});

describe("SAFE-002 — response builders are pure envelope builders", () => {
  test("P0-002 PIN: ok() never rate-limits (400 calls > every budget)", () => {
    for (let i = 0; i < 400; i += 1) {
      const response = ok({ n: i });
      expect(response.status).toBe(200);
    }
  });

  test("fail()/failWithDetail() never rate-limit and keep the envelope shape", () => {
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
  test("body and headers carry code, retry window and request id", () => {
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
  test("valid token verifies with its principal; expired does not", () => {
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

  test("tampered payload fails signature verification", () => {
    const token = mintTestServiceToken();
    const [head, , sig] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ iss: "fayanms:worker", sub: "evil", aud: "fayanms:internal", exp: 9999999999 })
    ).toString("base64url");
    const result = verifyServiceToken(`${head}.${forgedBody}.${sig}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
  });

  test("bearerTokenOf extracts the token or returns null", () => {
    expect(bearerTokenOf("Bearer  abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerTokenOf("bearer abc")).toBe("abc");
    expect(bearerTokenOf("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerTokenOf(null)).toBeNull();
  });
});

describe("SAFE-002 — proxy wiring (pre-handler order)", () => {
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
      takeRateSlot("10.0.0.1", "mutation");
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
