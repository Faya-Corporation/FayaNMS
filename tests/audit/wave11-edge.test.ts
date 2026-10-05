/**
 * Wave-11 EDGE/DEPLOYMENT plane (audit 15-a + 15-c cross-refs) — the fix
 * suite for four findings on the proxy/rate-store/startup-policy surface:
 *
 *   F-1 (P3)  CSRF ORIGIN CHECK BYPASS at the proxy's early-return planes:
 *             step 3a (MACHINE_EXACT_ROUTES) and step 3b (opaque bearer)
 *             used to return BEFORE the step-5 CSRF origin check. Three
 *             MACHINE_EXACT POST routes are DUAL-GATE (their handlers fall
 *             back to the admin session via requireServiceOrPermission →
 *             requirePermission), so a same-site sibling-subdomain form
 *             POST — Lax cookie, no preflight, no custom headers — could
 *             execute a destructive admin retention prune (Vector A); a
 *             cookie + decoy opaque bearer reached the session fallback the
 *             same way (Vector B). The fix runs the IDENTICAL origin check
 *             (shared helper, same body/status) at both early returns for
 *             cookie-carrying MUTATIONS only. Pinned here behaviorally
 *             through the real proxy:
 *               · dual-gate route + cookie + same-site/cross-site → 403;
 *               · same-origin/none/headerless (documented fail-open) → next;
 *               · no-cookie callers and GETs keep the fast path;
 *               · a VERIFIED service token never reaches the gate (step 1
 *                 returned it) — machine plane untouched;
 *               · cookie + opaque bearer (Vector B) → 403 on 3b.
 *
 *   F-4 (P4)  RATE-STORE SIZE BOUND: the in-memory sweep was stale-only —
 *             bounded in TIME, not in SIZE (a flood of distinct LIVE keys
 *             renews itself faster than staleness removes it). The hard
 *             cap evicts OLDEST-INSERTED buckets (Map insertion order)
 *             down to the documented key cap before a new key is inserted.
 *             Pinned behaviorally with a small clamped store: the oldest
 *             budget loses its history, newest budgets keep theirs, and
 *             deny-doesn't-consume still holds.
 *
 *   F-5 (P3, cross-ref 15-c) PROXY-HOP TRUST POLICY: the rate gate and the
 *             login guard key budgets on the rightmost trusted XFF hop
 *             (default 1), but the base compose profile publishes the app
 *             with NO appending proxy — XFF is attacker-chosen. The startup
 *             policy now REFUSES production boot when hops > 0 without the
 *             explicit FAYANMS_PUBLIC_PROXY declaration (same severity
 *             convention as the F-032 scale guard); dev behavior is
 *             unchanged. Pinned: the full guard matrix, exact parity of the
 *             policy's pure hops parser with the runtime
 *             getTrustedProxyHops(), and the wiring into the production
 *             refusal set.
 *
 *   Source pins: the CSRF gate present at BOTH early returns, the hard-cap
 *   constant + eviction in rate-store, the guard wiring in security-policy,
 *   and the env-example contract lines.
 *
 * Rig notes: the proxy is exercised through the REAL module (no mocks) —
 * session cookies are minted with the production next-auth/jwt encoder and
 * the machine pin runs inside a hermetic service-identity env sandbox (an
 * in-process Ed25519 keypair installed into process.env and restored), so
 * the suite is deterministic in BOTH CI (symmetric-only) and EdDSA-only
 * deployments. No DB, no network, no global store mutations.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as ed25519Sign,
} from "node:crypto";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import {
  type SharedRateStore,
  MAX_MEMORY_RATE_HARD_KEY_CAP,
  MAX_MEMORY_RATE_KEYS,
  createInMemoryRateStore,
} from "../../src/lib/api/rate-store";
import { getTrustedProxyHops } from "../../src/lib/api/rate-gate";
import {
  PUBLIC_PROXY_ENV,
  findProductionPolicyViolations,
  findProxyHopsViolations,
  parseTrustedProxyHops,
} from "../../src/lib/startup/security-policy";

const REPO_ROOT = join(import.meta.dir, "../..");

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const { proxy } = await import("../../src/proxy");

/** Live bucket count (in-memory store only — mirrors rate-gate's test seam). */
function sizeOf(store: SharedRateStore): number {
  return (store as unknown as { sizeForTests?: number }).sizeForTests ?? 0;
}

/* ── session fixture (real next-auth encoder, same harness as RT-008) ────── */

const SESSION = await encode({
  token: {
    id: "user-wave11-edge",
    email: "wave11-edge@faya.local",
    name: "Wave-11 Edge Admin",
    role: "admin",
  },
  secret: process.env.NEXTAUTH_SECRET ?? "",
});

/* ── hermetic service-identity env sandbox (for the VERIFIED-token pin) ──── */

const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
] as const;

const MACHINE_KEYPAIR = generateKeyPairSync("ed25519");
const MACHINE_PUB_SPKI = MACHINE_KEYPAIR.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const MACHINE_PRIV = createPrivateKey(
  MACHINE_KEYPAIR.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
);

/** Mint an EdDSA service token that VERIFIES under the sandboxed trust plane. */
function mintVerifiedServiceToken(): string {
  const nowS = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: "wave11-edge-machine",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: "wave11-edge-machine-jti",
      scopes: ["jobs"],
    }),
  ).toString("base64url");
  const signature = ed25519Sign(null, Buffer.from(`${header}.${payload}`), MACHINE_PRIV).toString(
    "base64url"
  );
  return `${header}.${payload}.${signature}`;
}

const bootEnv = process.env as Record<string, string | undefined>;
let savedServiceEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedServiceEnv = {};
  for (const key of SERVICE_ENV_KEYS) {
    savedServiceEnv[key] = bootEnv[key];
    delete bootEnv[key];
  }
  // EdDSA-only plane under MY keypair; the issuer allowlist falls back to
  // its documented default (["fayanms:worker"]).
  bootEnv.FAYANMS_SERVICE_PUBLIC_KEYS = MACHINE_PUB_SPKI;
});

afterAll(() => {
  for (const key of SERVICE_ENV_KEYS) {
    const saved = savedServiceEnv[key];
    if (saved === undefined) delete bootEnv[key];
    else bootEnv[key] = saved;
  }
});

/* ── request harness (unique XFF per request — no shared budget collisions) ─ */

let ipCounter = 0;

function buildRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  withSessionCookie: boolean
): NextRequest {
  ipCounter += 1;
  return new NextRequest(`http://app.local${url}`, {
    method,
    headers: {
      "x-forwarded-for": `10.211.7.${ipCounter % 200 + 1}`,
      ...(withSessionCookie ? { cookie: `next-auth.session-token=${SESSION}` } : {}),
      ...headers,
    },
  });
}

const DUAL_GATE_ROUTE = "/api/v1/metrics/retention/prune";

async function expectNext(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

async function expectCsrfRejected(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  const body = (await response.json()) as { error?: { code?: string; message?: string } };
  expect(body.error?.code).toBe("CSRF_ORIGIN_REJECTED");
  expect(body.error?.message).toBe("Cross-site mutation rejected.");
}

/* ── F-1: the CSRF origin gate at the step-3a early return ────────────────── */

describe("wave-11 F-1: CSRF gate at step 3a (dual-gate machine routes)", () => {
  test("cookie + same-site POST → 403 CSRF_ORIGIN_REJECTED (the audit's Vector A)", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "POST", { "sec-fetch-site": "same-site" }, true),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + cross-site POST → 403 CSRF_ORIGIN_REJECTED", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "POST", { "sec-fetch-site": "cross-site" }, true),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + origin/host mismatch (no sec-fetch-site) → 403", async () => {
    const response = await proxy(
      buildRequest(
        DUAL_GATE_ROUTE,
        "POST",
        { host: "app.local", origin: "https://evil.example" },
        true
      ),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + same-origin POST → next (the legitimate admin flow is unchanged)", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "POST", { "sec-fetch-site": "same-origin" }, true),
    );
    await expectNext(response);
  });

  test("cookie + sec-fetch-site: none POST → next (user-initiated navigation)", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "POST", { "sec-fetch-site": "none" }, true),
    );
    await expectNext(response);
  });

  test("cookie + headerless POST → next (the documented step-5 fail-open branch)", async () => {
    const response = await proxy(buildRequest(DUAL_GATE_ROUTE, "POST", {}, true));
    await expectNext(response);
  });

  test("NO cookie + cross-site POST → next (non-browser machine-surface fast path unchanged)", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "POST", { "sec-fetch-site": "cross-site" }, false),
    );
    await expectNext(response);
  });

  test("cookie + cross-site GET → next (reads keep the fast path)", async () => {
    const response = await proxy(
      buildRequest(DUAL_GATE_ROUTE, "GET", { "sec-fetch-site": "cross-site" }, true),
    );
    await expectNext(response);
  });

  test("cookie + dotted garbage bearer + cross-site POST → 403 (unverified bearer is not machine)", async () => {
    const response = await proxy(
      buildRequest(
        DUAL_GATE_ROUTE,
        "POST",
        { authorization: "Bearer garbage.dotted.bearer", "sec-fetch-site": "cross-site" },
        true
      ),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + VERIFIED service token + cross-site POST on a worker route → next (step 1 returned first)", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/worker/claim",
        "POST",
        { authorization: `Bearer ${mintVerifiedServiceToken()}`, "sec-fetch-site": "cross-site" },
        true
      ),
    );
    await expectNext(response);
  });

  test("VERIFIED service token without cookie + cross-site POST on the dual-gate route → next", async () => {
    const response = await proxy(
      buildRequest(
        DUAL_GATE_ROUTE,
        "POST",
        { authorization: `Bearer ${mintVerifiedServiceToken()}`, "sec-fetch-site": "cross-site" },
        false
      ),
    );
    await expectNext(response);
  });

  test("cookie + cross-site POST on a public bootstrap surface → 403 (gate covers all of 3a)", async () => {
    const response = await proxy(
      buildRequest("/api/v1/meta", "POST", { "sec-fetch-site": "cross-site" }, true),
    );
    await expectCsrfRejected(response);
  });
});

/* ── F-1: the CSRF origin gate at the step-3b early return (Vector B) ─────── */

describe("wave-11 F-1: CSRF gate at step 3b (cookie + opaque bearer)", () => {
  const OPAQUE = "a".repeat(40);

  test("cookie + opaque bearer + cross-site POST → 403 CSRF_ORIGIN_REJECTED (Vector B)", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/devices",
        "POST",
        { authorization: `Bearer ${OPAQUE}`, "sec-fetch-site": "cross-site" },
        true
      ),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + opaque bearer + same-site POST → 403 (same strictness as step 5)", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/devices",
        "POST",
        { authorization: `Bearer ${OPAQUE}`, "sec-fetch-site": "same-site" },
        true
      ),
    );
    await expectCsrfRejected(response);
  });

  test("cookie + opaque bearer + same-origin POST → next", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/devices",
        "POST",
        { authorization: `Bearer ${OPAQUE}`, "sec-fetch-site": "same-origin" },
        true
      ),
    );
    await expectNext(response);
  });

  test("opaque bearer WITHOUT cookie + cross-site POST → next (api-client plane unaffected)", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/devices",
        "POST",
        { authorization: `Bearer ${OPAQUE}`, "sec-fetch-site": "cross-site" },
        false
      ),
    );
    await expectNext(response);
  });

  test("cookie + opaque bearer + cross-site GET → next (reads keep the fast path)", async () => {
    const response = await proxy(
      buildRequest(
        "/api/v1/devices",
        "GET",
        { authorization: `Bearer ${OPAQUE}`, "sec-fetch-site": "cross-site" },
        true
      ),
    );
    await expectNext(response);
  });
});

/* ── F-4: the in-memory rate-store hard cap ───────────────────────────────── */

describe("wave-11 F-4: rate-store hard-cap eviction (oldest-inserted first)", () => {
  test("constants are pinned (the size backstop sits above the stale-sweep cap)", () => {
    expect(MAX_MEMORY_RATE_KEYS).toBe(5_000);
    expect(MAX_MEMORY_RATE_HARD_KEY_CAP).toBe(10_000);
  });

  test("a distinct-key flood is bounded in SIZE; the oldest budget loses its history, newest keep theirs", async () => {
    const store = createInMemoryRateStore(20, 40);
    const W = 60_000;
    const T0 = 9_000_000;

    // Establish history on the OLDEST key and exhaust it.
    for (let i = 0; i < 3; i++) {
      expect((await store.hit("cap:first", 3, W, T0)).allowed).toBe(true);
    }
    expect((await store.hit("cap:first", 3, W, T0)).allowed).toBe(false);

    // Flood with 45 distinct LIVE keys (all stamped "now" — nothing is stale).
    for (let i = 1; i <= 45; i++) {
      expect((await store.hit(`cap:k${i}`, 3, W, T0 + i)).allowed).toBe(true);
    }

    // Size backstop held (default cap 40 for this store) — bounded in SIZE.
    expect(sizeOf(store)).toBeLessThanOrEqual(40);

    // The oldest-inserted buckets were evicted: the exhausted key's history
    // is gone and it re-accumulates from a clean slate.
    expect((await store.hit("cap:first", 3, W, T0 + 100)).allowed).toBe(true);

    // The newest keys kept their history: k45 draws its remaining slots and
    // is then limited, with the deny path consuming no slot.
    expect((await store.hit("cap:k45", 3, W, T0 + 101)).allowed).toBe(true);
    expect((await store.hit("cap:k45", 3, W, T0 + 102)).allowed).toBe(true);
    expect((await store.hit("cap:k45", 3, W, T0 + 103)).allowed).toBe(false);
    const deniedAgain = await store.hit("cap:k45", 3, W, T0 + 104);
    expect(deniedAgain.allowed).toBe(false);
    expect(deniedAgain.total).toBe(3);
  });

  test("the DEFAULT store honors its hard cap (10_000) on a live-key flood", async () => {
    const store = createInMemoryRateStore();
    const W = 60_000;
    const T0 = 9_100_000;
    // Flood past the hard cap with LIVE keys (all stamps inside the window,
    // so the stale sweep removes nothing — exactly the 15-a/15-c shape).
    for (let i = 1; i <= MAX_MEMORY_RATE_HARD_KEY_CAP + 50; i++) {
      await store.hit(`def:cap:k${i}`, 10, W, T0 + i);
    }
    // Eviction actually happened (far below the inserted count) AND the cap
    // held: bounded in SIZE, not just in time.
    expect(sizeOf(store)).toBeLessThanOrEqual(MAX_MEMORY_RATE_KEYS + 50);
    expect(sizeOf(store)).toBeLessThanOrEqual(MAX_MEMORY_RATE_HARD_KEY_CAP);
  });
});

/* ── F-5: the proxy-hop trust policy (production refusal matrix) ──────────── */

const E = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("wave-11 F-5: findProxyHopsViolations guard matrix", () => {
  test("hops = 0 is always clean (trust nothing — the direct-publish remediation)", () => {
    expect(findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "0" }))).toEqual([]);
    expect(
      findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "0", [PUBLIC_PROXY_ENV]: "" }))
    ).toEqual([]);
    expect(
      findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: " 0 ", [PUBLIC_PROXY_ENV]: "no" }))
    ).toEqual([]);
  });

  test("negative hops clamp to 0 at runtime → clean (parity with the gate, not a special case)", () => {
    expect(findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "-2" }))).toEqual([]);
  });

  test("default (unset) and explicit hops > 0 WITHOUT the proxy declaration refuse", () => {
    for (const env of [E({}), E({ FAYANMS_TRUST_PROXY_HOPS: " " }), E({ FAYANMS_TRUST_PROXY_HOPS: "3" })]) {
      const violations = findProxyHopsViolations(env);
      expect(violations.length).toBe(1);
      expect(violations[0]?.variable).toBe("FAYANMS_TRUST_PROXY_HOPS");
      const reason = violations[0]?.reason ?? "";
      // The defect, the bypass shape and BOTH remediations are named:
      expect(reason).toContain(PUBLIC_PROXY_ENV);
      expect(reason).toContain("attacker-chosen");
      expect(reason).toContain("budget bypass");
      expect(reason).toContain(`${PUBLIC_PROXY_ENV}=true`);
      expect(reason).toContain("FAYANMS_TRUST_PROXY_HOPS=0");
    }
    // The reason states the EFFECTIVE hop count (clamped, default-resolved).
    expect(findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "3" }))[0]?.reason).toContain(
      "resolves to 3"
    );
    expect(findProxyHopsViolations(E({}))[0]?.reason).toContain("resolves to 1");
    expect(findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "9" }))[0]?.reason).toContain(
      "resolves to 8"
    );
  });

  test("the DECLARED appending-proxy posture is clean (1/true/yes/on, case/space tolerant)", () => {
    for (const declared of ["true", "TRUE", " 1 ", "Yes", "on"]) {
      expect(
        findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "1", [PUBLIC_PROXY_ENV]: declared }))
      ).toEqual([]);
    }
  });

  test("non-truthy declarations do NOT assert a proxy (a typo can never fail open)", () => {
    for (const notDeclared of ["", "   ", "false", "0", "no", "off", "sure", "enabled!!"]) {
      expect(
        findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "1", [PUBLIC_PROXY_ENV]: notDeclared }))
          .length
      ).toBe(1);
    }
  });

  test("malformed hops falls back to the runtime default (1) and refuses", () => {
    const violations = findProxyHopsViolations(E({ FAYANMS_TRUST_PROXY_HOPS: "abc" }));
    expect(violations.length).toBe(1);
    expect(violations[0]?.reason).toContain("resolves to 1");
  });

  test("PARITY PIN: parseTrustedProxyHops mirrors getTrustedProxyHops exactly (drift guard)", () => {
    const samples = [undefined, "", "   ", "0", "1", "3", "8", "9", "-2", "2.7", "abc", "NaN", "+4", "0x2"];
    const saved = bootEnv.FAYANMS_TRUST_PROXY_HOPS;
    try {
      for (const raw of samples) {
        bootEnv.FAYANMS_TRUST_PROXY_HOPS = raw;
        expect(parseTrustedProxyHops(raw)).toBe(getTrustedProxyHops());
      }
    } finally {
      if (saved === undefined) delete bootEnv.FAYANMS_TRUST_PROXY_HOPS;
      else bootEnv.FAYANMS_TRUST_PROXY_HOPS = saved;
    }
  });

  test("the guard is WIRED into the production refusal set (delta isolation on a valid env)", () => {
    const base = E(validProductionEnv());
    expect(
      findProductionPolicyViolations(base).some((v) => v.variable === "FAYANMS_TRUST_PROXY_HOPS")
    ).toBe(false);

    const undeclared = E({ ...base, [PUBLIC_PROXY_ENV]: "" });
    const violations = findProductionPolicyViolations(undeclared);
    expect(violations.some((v) => v.variable === "FAYANMS_TRUST_PROXY_HOPS")).toBe(true);

    // Explicit opt-out: the direct-publish posture boots clean.
    const directPublish = E({ ...base, FAYANMS_TRUST_PROXY_HOPS: "0", [PUBLIC_PROXY_ENV]: "" });
    expect(
      findProductionPolicyViolations(directPublish).some(
        (v) => v.variable === "FAYANMS_TRUST_PROXY_HOPS"
      )
    ).toBe(false);
  });
});

/**
 * A fully-valid EdDSA-only production env (batch-14's builder shape) — used
 * ONLY for delta isolation on the wiring pin, never asserted to be
 * violation-free as a whole.
 */
function validProductionEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "7f9c2e5a1d3b4c6e8f0a2b4d6e8f0a1b3c5d7e9f1a3b5d7f9c1e3f5a7b9d1f3e",
    FAYANMS_SERVICE_PUBLIC_KEYS: MACHINE_PUB_SPKI,
    FAYANMS_SERVICE_PRIVATE_KEY: MACHINE_KEYPAIR.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    FAYANMS_CONFIG_ENC_KEY: "3e1f9d7b5a3f1e9c7f5d3b1a9f7e5c3b1d9f7a5e3c1b9d7f5a3e1c9b7d5f3e1a",
    DATABASE_URL: "postgresql://faya:secret@localhost:5432/fayanms",
    [PUBLIC_PROXY_ENV]: "true",
  };
}

/* ── source pins: the fixes exist where the audit found the gaps ──────────── */

describe("wave-11 source pins", () => {
  const proxySrc = read("src/proxy.ts");
  const rateStoreSrc = read("src/lib/api/rate-store.ts");
  const policySrc = read("src/lib/startup/security-policy.ts");

  test("proxy: the cookie-session CSRF gate is defined and called at BOTH early returns", () => {
    expect(proxySrc).toContain("function cookieSessionCsrfRejection(req: NextRequest)");
    const callSites = proxySrc.split("const csrfRejection = cookieSessionCsrfRejection(req);")
      .length - 1;
    expect(callSites).toBe(2);
    // The gate shares step 5's origin decision + envelope (single source):
    expect(proxySrc).toContain("function csrfOriginRejected(req: NextRequest)");
    expect(proxySrc).toContain("if (token && MUTATING_METHODS.has(req.method) && csrfOriginRejected(req))");
  });

  test("rate-store: the hard-cap constant + oldest-first eviction exist", () => {
    expect(rateStoreSrc).toContain("MAX_MEMORY_RATE_HARD_KEY_CAP = 10_000");
    expect(rateStoreSrc).toContain("function evictOldestToHardCap(): void");
    expect(rateStoreSrc).toContain("evictOldestToHardCap();");
  });

  test("security-policy: the hops guard is wired into the production violation set", () => {
    expect(policySrc).toContain('PUBLIC_PROXY_ENV = "FAYANMS_PUBLIC_PROXY"');
    expect(policySrc).toContain("violations.push(...findProxyHopsViolations(env));");
  });

  test("the env examples document the proxy-hop contract", () => {
    expect(read(".env.example")).toContain("FAYANMS_PUBLIC_PROXY");
    expect(read("deploy/oci/env.example")).toContain("FAYANMS_PUBLIC_PROXY=true");
    expect(read("docs/deploy/env.app.production.example")).toContain("FAYANMS_PUBLIC_PROXY=true");
  });
});
