import { generateKeyPairSync, sign as ed25519Sign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

import { handle } from "../../mini-services/worker/index";

/**
 * RT-025 / F-040 — worker /api/metrics timing-safe token compare + 403
 * semantics for scope-insufficient control calls.
 *
 * BEFORE: the metrics bearer check was a plain `!==` string compare (a
 * theoretical timing oracle, and inconsistent with RT-009's app-side
 * /api/metrics discipline), and `controlRejectResponse` mapped EVERY
 * control rejection — including authenticated-but-unscoped tokens — to
 * HTTP 401, so clients could not tell "who are you" from "not allowed".
 *
 * Pinned here (worker `handle()`-level, style of the service-identity
 * suites):
 *   1. the configured bearer is accepted on /api/metrics (200 + payload);
 *   2. wrong/garbage/missing Authorization → 401 text;
 *   3. the comparison is constant-time (timingSafeEqual from node:crypto);
 *   4. a VALID EdDSA token WITHOUT the "simulate" scope answers 403 with
 *      code WORKER_SCOPE_INSUFFICIENT (the fixed semantic);
 *   5. unauthenticated control calls still answer 401 (no over-broadening);
 *   6. unset FAYANMS_METRICS_TOKEN still serves — the documented open
 *      behavior is unchanged in this RT (fail-closed stays in BACKLOG).
 */

const WORKER_INDEX_SOURCE = readFileSync("mini-services/worker/index.ts", "utf8");

// ── key material (control-plane Ed25519 identity, hermetic) ────────────────
const CONTROL = generateKeyPairSync("ed25519");
const CONTROL_PUB_SPKI = CONTROL.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

const METRICS_TOKEN = `rt025-${randomBytes(16).toString("hex")}`;

// ── env sandbox (save/restore around the whole file) ───────────────────────
const ENV_KEYS = [
  "FAYANMS_METRICS_TOKEN",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_ENV_FILE",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterAll(() => {
  for (const [key, value] of savedEnv.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Hermetic worker trust plane: only OUR control public key is configured. */
function useControlKeyOnly(): void {
  process.env.FAYANMS_SERVICE_ENV_FILE = ""; // no dev .env fallback (R64 knob)
  delete process.env.FAYANMS_SERVICE_SECRET;
  delete process.env.FAYANMS_SERVICE_SECRETS;
  delete process.env.FAYANMS_SERVICE_PRIVATE_KEY;
  process.env.FAYANMS_SERVICE_PUBLIC_KEYS = CONTROL_PUB_SPKI;
}

/** Hand-mint an EdDSA control token (same wire format as service-jwt.ts). */
function mintControlToken(scopes: string[]): string {
  const b64 = (input: string): string => Buffer.from(input).toString("base64url");
  const nowS = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      iss: "fayanms:control",
      sub: "control:rt025",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: randomBytes(8).toString("hex"),
      scopes,
    })
  );
  const signingInput = `${header}.${payload}`;
  const sig = ed25519Sign(null, Buffer.from(signingInput), CONTROL.privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

describe("RT-025 — worker /api/metrics bearer discipline", () => {
  test("metrics correct token accepted (200 + worker scheduler gauge)", async () => {
    process.env.FAYANMS_METRICS_TOKEN = METRICS_TOKEN;
    const res = await handle(
      new Request("http://worker:3030/api/metrics", {
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("fayanms_worker_scheduler_up");
  });

  test("metrics wrong/garbage/missing header rejected (401 text)", async () => {
    process.env.FAYANMS_METRICS_TOKEN = METRICS_TOKEN;
    for (const auth of [
      `Bearer wrong-${randomBytes(16).toString("hex")}`,
      `Basic ${randomBytes(8).toString("hex")}`,
      "", // no header at all
    ]) {
      const res = await handle(
        new Request("http://worker:3030/api/metrics", {
          headers: auth ? { authorization: auth } : {},
        })
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toContain("Unauthorized");
    }
  });

  test("metrics compare is constant-time (timingSafeEqual from node:crypto)", () => {
    // Source pin: the metrics path must use the repo's standard bearer
    // discipline (RT-009 pattern) — no plain `!==` against the configured
    // token remains. The import assertion is shape-based (the module may
    // legitimately import other crypto helpers alongside).
    expect(WORKER_INDEX_SOURCE).toMatch(/import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
    expect(WORKER_INDEX_SOURCE).toContain("timingSafeEqual(suppliedBuf, expected)");
    expect(WORKER_INDEX_SOURCE).not.toMatch(/supplied\s*!==\s*`Bearer \$\{configuredToken\}`/);
  });

  test("unset metrics token still serves (documented behavior unchanged in this RT)", async () => {
    delete process.env.FAYANMS_METRICS_TOKEN;
    const res = await handle(new Request("http://worker:3030/api/metrics"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fayanms_worker_scheduler_up");
  });
});

describe("RT-025 — control-reject status semantics (401 vs 403)", () => {
  test("scope-insufficient answers 403 with code WORKER_SCOPE_INSUFFICIENT", async () => {
    useControlKeyOnly();
    // Valid, correctly signed token — but WITHOUT the "simulate" scope.
    const token = mintControlToken(["jobs"]);
    const res = await handle(
      new Request("http://worker:3030/simulate/connect", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ vendor: "cisco-ios", host: "10.0.0.1" }),
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WORKER_SCOPE_INSUFFICIENT");
  });

  test("unauthenticated control call still answers 401 (no over-broadening)", async () => {
    useControlKeyOnly();
    const res = await handle(
      new Request("http://worker:3030/simulate/connect", {
        method: "POST",
        body: JSON.stringify({ vendor: "cisco-ios", host: "10.0.0.1" }),
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WORKER_UNAUTHENTICATED");
  });

  test("invalid signature on a well-formed token still answers 401", async () => {
    useControlKeyOnly();
    const token = mintControlToken(["simulate"]);
    const tampered = `${token.slice(0, -4)}AAAA`;
    const res = await handle(
      new Request("http://worker:3030/simulate/connect", {
        method: "POST",
        headers: { authorization: `Bearer ${tampered}` },
        body: JSON.stringify({ vendor: "cisco-ios", host: "10.0.0.1" }),
      })
    );
    expect(res.status).toBe(401);
  });
});
