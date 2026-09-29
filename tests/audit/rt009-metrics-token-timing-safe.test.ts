import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GET } from "@/app/api/metrics/route";

/**
 * RT-009 / F-027 — timing-safe bearer comparison for /api/metrics (S part
 * ONLY). The token-optional → default-closed policy change and the edge
 * 404 are explicitly OUT of scope here (F-061/RT-031 owns the edge layer);
 * the "unset token still serves" behavior is deliberately guarded so it
 * cannot regress silently from either direction.
 *
 * Pinned here:
 *   1. correct token accepted (200 + process metrics present);
 *   2. wrong / garbage / missing header with token configured → 401
 *      text/plain "Unauthorized" (byte-identical to the pre-change 401);
 *   3. unset token serves (documented optionality unchanged);
 *   4. the comparison is constant-time: timingSafeEqual imported from
 *      node:crypto and used; the plain `!==` against the bearer template
 *      is gone.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const ROUTE_SOURCE = readFileSync(
  path.join(REPO_ROOT, "src/app/api/metrics/route.ts"),
  "utf8",
);

const TOKEN_ENV = "FAYANMS_METRICS_TOKEN";
let savedToken: string | undefined;

function setTokenEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[TOKEN_ENV];
  } else {
    process.env[TOKEN_ENV] = value;
  }
}

afterEach(() => {
  setTokenEnv(savedToken);
});

describe("RT-009: timing-safe metrics token compare", () => {
  test("correct token accepted", async () => {
    savedToken = process.env[TOKEN_ENV];
    setTokenEnv("rt009-metrics-secret");
    const response = await GET(
      new Request("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer rt009-metrics-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("fayanms_process_uptime_seconds");
  });

  test("wrong/garbage/missing token rejected with the unchanged 401 envelope", async () => {
    savedToken = process.env[TOKEN_ENV];
    setTokenEnv("rt009-metrics-secret");
    for (const authorization of [
      "Bearer wrong-token-value",
      "rt009-metrics-secret",
      "Basic dXNlcjpwYXNz",
      "",
    ]) {
      const response = await GET(
        new Request("http://localhost:3000/api/metrics", {
          headers: authorization ? { authorization } : {},
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(await response.text()).toBe("Unauthorized\n");
    }
  });

  test("unset token serves (documented optionality unchanged — out-of-scope policy)", async () => {
    savedToken = process.env[TOKEN_ENV];
    setTokenEnv(undefined);
    const response = await GET(new Request("http://localhost:3000/api/metrics"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fayanms_process_uptime_seconds");
  });

  test("comparison is constant-time (timingSafeEqual from node:crypto)", () => {
    expect(ROUTE_SOURCE).toContain('import { timingSafeEqual } from "node:crypto"');
    expect(ROUTE_SOURCE).toContain("timingSafeEqual(suppliedBuf, expected)");
    // The plain string comparison against the bearer template is gone.
    expect(ROUTE_SOURCE).not.toContain("supplied !== `Bearer ${configuredToken}`");
  });
});
