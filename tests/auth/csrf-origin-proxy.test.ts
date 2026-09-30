import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

/**
 * RT-008 / F-010 — CSRF origin check for cookie-session mutations.
 *
 * The proxy validated cookie-session mutations by the NextAuth JWT only;
 * a legacy/embedded browser (or any future SameSite policy regression)
 * could drive cross-site mutations against every /api/v1 endpoint with no
 * second factor. This suite pins the Origin/Sec-Fetch-Site control:
 *
 *   - same-origin | none               → allowed;
 *   - cross-site / same-site           → 403 CSRF_ORIGIN_REJECTED
 *     (same-site is NOT safe enough — sibling-subdomain risk);
 *   - no Sec-Fetch-Site + Origin/Host mismatch → 403;
 *   - neither header                   → allowed (non-browser client;
 *     SameSite=Lax still guards the cookie);
 *   - reads are unaffected (mutations only);
 *   - API-client bearer plane and machine plane return BEFORE the check
 *     (they send no cookies and are not CSRF-able).
 *
 * getToken is MOCKED (the app's next-auth/jwt import) — the session cookie
 * carries a base64url JSON token payload; only the proxy's gate logic is
 * under test here, handler-level checks are separate suites.
 */

const { proxy } = await import("@/proxy");

// REAL session token: minted with the production next-auth/jwt encoder and
// the same secret the app reads — no module mocking (bun mock.module is
// process-wide and would poison later suites that decode real tokens).
const SESSION = await encode({
  token: { id: "user-rt008", email: "rt008@faya.local", name: "RT-008 Admin", role: "admin" },
  secret: process.env.NEXTAUTH_SECRET ?? "",
});

let ipCounter = 0;
function sessionRequest(
  url: string,
  method: string,
  extraHeaders: Record<string, string>,
): NextRequest {
  ipCounter += 1;
  return new NextRequest(`http://app.local${url}`, {
    method,
    headers: {
      "x-forwarded-for": `10.77.0.${ipCounter % 200 + 1}`,
      cookie: `next-auth.session-token=${SESSION}`,
      ...extraHeaders,
    },
  });
}

function mintTestServiceToken(): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: "worker-mini-service",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: "rt008-test-jti",
      scopes: ["jobs"],
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

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

describe("RT-008: CSRF origin check for cookie-session mutations", () => {
  test("same-origin mutation passes", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "POST", { "sec-fetch-site": "same-origin" }),
    );
    await expectNext(response);
  });

  test("sec-fetch-site: none passes (user-initiated navigation)", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "POST", { "sec-fetch-site": "none" }),
    );
    await expectNext(response);
  });

  test("cross-site mutation rejected with 403 CSRF_ORIGIN_REJECTED", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "POST", { "sec-fetch-site": "cross-site" }),
    );
    await expectCsrfRejected(response);
  });

  test("same-site mutation rejected (documented strictness — sibling-subdomain risk)", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "POST", { "sec-fetch-site": "same-site" }),
    );
    await expectCsrfRejected(response);
  });

  test("origin/host mismatch rejected when no sec-fetch-site", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "POST", {
        host: "app.local",
        origin: "https://evil.example",
      }),
    );
    await expectCsrfRejected(response);
  });

  test("headerless non-browser client allowed (documented fail-open branch)", async () => {
    const response = await proxy(sessionRequest("/api/v1/devices", "POST", {}));
    await expectNext(response);
  });

  test("reads unaffected — cross-site GET still passes (mutations only)", async () => {
    const response = await proxy(
      sessionRequest("/api/v1/devices", "GET", { "sec-fetch-site": "cross-site" }),
    );
    await expectNext(response);
  });

  test("api-client bearer mutations unaffected (step 3b precedes the CSRF check)", async () => {
    ipCounter += 1;
    const response = await proxy(
      new NextRequest("http://app.local/api/v1/devices", {
        method: "POST",
        headers: {
          "x-forwarded-for": `10.77.1.${ipCounter % 200 + 1}`,
          authorization: `Bearer ${"a".repeat(40)}`,
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    await expectNext(response);
  });

  test("machine plane unaffected — verified service JWT allowed regardless of headers", async () => {
    ipCounter += 1;
    const response = await proxy(
      new NextRequest("http://app.local/api/v1/worker/claim", {
        method: "POST",
        headers: {
          "x-forwarded-for": `10.77.2.${ipCounter % 200 + 1}`,
          authorization: `Bearer ${mintTestServiceToken()}`,
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    await expectNext(response);
  });
});

