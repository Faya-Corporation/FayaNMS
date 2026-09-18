import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";
import { GET as credentialsGET } from "@/app/api/v1/credentials/route";
import { GET as snapshotsGET } from "@/app/api/v1/devices/[id]/snapshots/route";

/**
 * R62 — the two P1 findings from the independent re-verification
 * (2026-09-19), with the invariants that close them.
 *
 * P1-1 — service-JWT surface isolation at the proxy.
 *   BEFORE: any cryptographically valid service JWT earned an early
 *   NextResponse.next() on EVERY /api/v1 path — before pathname/scope
 *   enforcement, before rate limiting, before session checks. A worker
 *   token could therefore walk human read surfaces (Dashboard, Devices,
 *   Events, Credentials) whose handlers trusted the proxy gate.
 *   AFTER: a verified service token passes ONLY on the machine surface
 *   (/api/v1/worker/* + the three service-principal job routes); on any
 *   other path the proxy answers 401 UNAUTHENTICATED — a service principal
 *   is a machine credential, not a session. Machine routes still enforce
 *   the token AND its scope at the handler layer (authenticateServiceRequest).
 *
 * P1-2 — sensitive GET/read RBAC.
 *   BEFORE: GET /api/v1/credentials returned username + vault pointer +
 *   notes with NO explicit permission; GET /api/v1/devices/[id]/snapshots
 *   DECRYPTED and returned rawText/normalizedText without the
 *   "config.download" authorization the dedicated download route enforces
 *   — React masking is not an authorization boundary.
 *   AFTER: credentials GET requires "admin.credential" (the same key that
 *   governs POST/PATCH); snapshots GET requires "config.read" and includes
 *   the decrypted texts ONLY for "config.download" holders (fields omitted
 *   otherwise — a server-side boundary, and the decryption itself only
 *   runs on the privileged path).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

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

function mintTestServiceToken(overrides?: { expired?: boolean }): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: "worker-mini-service",
      aud: "fayanms:internal",
      iat: nowS,
      exp: overrides?.expired ? nowS - 3600 : nowS + 300,
      jti: "r62-test-jti",
      scopes: ["jobs"],
    }),
  ).toString("base64url");
  const sig = Buffer.from("").toString("base64url"); // shape only — verifyServiceToken validates via env key/secret
  void sig;
  const signature = createHmac("sha256", secret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

describe("R62 P1-1: service-JWT surface isolation at the proxy", () => {
  test("a valid service token on a HUMAN read route is 401 UNAUTHENTICATED (was: free pass)", async () => {
    const response = await proxy(
      proxyRequest("/api/v1/devices", "GET", {
        authorization: `Bearer ${mintTestServiceToken()}`,
      }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("the same hard 401 on every non-machine plane (events, credentials, meta-users)", async () => {
    for (const path of ["/api/v1/events", "/api/v1/credentials", "/api/v1/meta/users"]) {
      const response = await proxy(
        proxyRequest(path, "GET", { authorization: `Bearer ${mintTestServiceToken()}` }),
      );
      expect(response.status).toBe(401);
    }
  });

  test("the machine surface still passes (worker prefix + the three job routes)", async () => {
    for (const [path, method] of [
      ["/api/v1/worker/claim", "POST"],
      ["/api/v1/worker/status", "GET"],
      ["/api/v1/worker/progress", "POST"],
      ["/api/v1/alerts/evaluate", "POST"],
      ["/api/v1/reports/execute", "POST"],
      ["/api/v1/metrics/retention/prune", "POST"],
    ] as Array<[string, string]>) {
      const response = await proxy(
        proxyRequest(path, method, { authorization: `Bearer ${mintTestServiceToken()}` }),
      );
      expect(response.status).toBe(200); // NextResponse.next()
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  test("rejected machine-surface requests never consume a rate slot (401 precedes the budget)", async () => {
    for (let i = 0; i < 15; i += 1) {
      const response = await proxy(
        proxyRequest("/api/v1/devices", "GET", {
          "x-forwarded-for": `10.9.9.${i % 5 + 1}`,
          authorization: `Bearer ${mintTestServiceToken()}`,
        }),
      );
      expect(response.status).toBe(401);
    }
    // No 429 was seen — the refusal is pre-budget, matching F-N1 semantics
    // (authentication before rate limiting, no budget burn on wrong-plane
    // machine tokens).
  });

  test("expired service tokens on a human route fall through to the session plane → 401", async () => {
    // An INVALID machine token never earns the machine exemption (and on a
    // human path nothing else would pass either). worker/* exact routes sit
    // on the 3a public-with-handler-auth list by design — an invalid token
    // there still dies at the handler's authenticateServiceRequest.
    const response = await proxy(
      proxyRequest("/api/v1/devices", "POST", {
        "x-forwarded-for": "10.9.9.9",
        authorization: `Bearer ${mintTestServiceToken({ expired: true })}`,
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("R62 P1-2: sensitive GET/read RBAC", () => {
  test("credentials GET without a session → 401 BEFORE any database work", async () => {
    const response = await credentialsGET(new Request("http://localhost/api/v1/credentials"));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("snapshots GET without a session → 401 BEFORE any database work", async () => {
    const response = await snapshotsGET(
      new Request("http://localhost/api/v1/devices/whatever/snapshots"),
      { params: Promise.resolve({ id: "whatever" }) },
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("SOURCE: the gates are explicit, ordered before DB work, and the text boundary is server-side", () => {
    const credentials = readFileSync(
      path.join(REPO_ROOT, "src/app/api/v1/credentials/route.ts"),
      "utf8",
    );
    const snapshots = readFileSync(
      path.join(REPO_ROOT, "src/app/api/v1/devices/[id]/snapshots/route.ts"),
      "utf8",
    );
    // credentials: the whole GET gated by admin.credential (the POST/PATCH key)
    expect(credentials).toContain('await requirePermission(request, "admin.credential")');
    // snapshots: config.read gate + config.download text boundary + omission
    expect(snapshots).toContain('await requirePermission(request, "config.read")');
    expect(snapshots).toContain('"config.download"');
    expect(snapshots).toContain("textIncluded: mayReadTexts");
    expect(snapshots).toContain("if (!mayReadTexts) return base;");
    // the decrypt runs only on the privileged path (after the early return)
    const decryptIdx = snapshots.indexOf("decryptSnapshotTexts(row)");
    const earlyReturnIdx = snapshots.indexOf("if (!mayReadTexts) return base;");
    expect(decryptIdx).toBeGreaterThan(earlyReturnIdx);
  });

  test("SOURCE: the proxy pins the machine surface exactly", () => {
    const proxySrc = readFileSync(path.join(REPO_ROOT, "src/proxy.ts"), "utf8");
    expect(proxySrc).toContain('pathname.startsWith("/api/v1/worker/")');
    expect(proxySrc).toContain('"/api/v1/alerts/evaluate"');
    expect(proxySrc).toContain('"/api/v1/reports/execute"');
    expect(proxySrc).toContain('"/api/v1/metrics/retention/prune"');
  });
});
