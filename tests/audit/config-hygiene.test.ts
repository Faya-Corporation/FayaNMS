import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { DB_QUERY_LOG_ENV, prismaLogLevels } from "../../src/lib/db-log";
import { findProductionPolicyViolations } from "../../src/lib/startup/security-policy";

/**
 * Production config hygiene (external ULTRA audit — P2-1, P2-3, P1-019).
 *
 * Three confirmed findings, one governance suite:
 *
 *   P2-1  Prisma query logging ran in production (`log: ['query']`
 *         unconditionally) — query text carrying tenant/device payload
 *         went to stdout logs. Pinned: the policy module gates query
 *         logging OFF in production (errors+warnings only), dev keeps
 *         full visibility, and FAYANMS_DB_QUERY_LOG is the explicit ops
 *         escape hatch; db.ts must delegate (no inline literal).
 *
 *   P2-3  `db:push` carried `--accept-data-loss` under an ordinary name —
 *         a routine dev command could silently destroy tables/columns.
 *         Pinned: `db:push` is fail-tight (no destructive flag) and the
 *         destructive capability lives behind an explicit `db:push:force`.
 *
 *   P1-019 The deterministic sample secrets committed to
 *         .github/workflows/ci.yml satisfied production shape validation —
 *         copying them into production sailed through. Pinned: EVERY
 *         secret value committed to the CI workflow is REFUSED by
 *         findProductionPolicyViolations (the known-bad check now covers
 *         all three secret variables plus rotation-list entries), while a
 *         freshly generated secret still passes (validation not
 *         over-tightened).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Extract every committed secret VALUE from the CI workflow env blocks. */
function ciWorkflowSecretValues(): string[] {
  const workflow = readRepoFile(".github/workflows/ci.yml");
  const values = [...workflow.matchAll(/^\s*(?:NEXTAUTH_SECRET|FAYANMS_SERVICE_SECRET|FAYANMS_CONFIG_ENC_KEY):\s*"([^"]+)"\s*$/gm)].map(
    (match) => match[1]
  );
  return values;
}

/** Production-shaped env around one candidate secret. */
function prodEnv(secrets: {
  NEXTAUTH_SECRET?: string;
  FAYANMS_SERVICE_SECRET?: string;
  FAYANMS_CONFIG_ENC_KEY?: string;
  FAYANMS_SERVICE_SECRETS?: string;
}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://fayanms:fayanms@localhost:5433/fayanms",
    // Wave-11 F-5 (differential pin update): this fixture models a
    // proxy-fronted deployment so the secret-focused assertions below stay
    // the ONLY deltas — the proxy-hop guard matrix lives in
    // tests/audit/wave11-edge.test.ts.
    FAYANMS_PUBLIC_PROXY: "true",
    ...secrets,
  };
}

describe("P1-019 — committed CI sample secrets are refused by production policy", () => {
  test("ci.yml commits exactly the three documented secret env values", () => {
    // Guards the extraction itself: if the workflow shape changes, this
    // pin must be updated deliberately, not silently vacated.
    expect(ciWorkflowSecretValues().length).toBe(3);
  });

  test("EVERY committed CI secret value fails production validation", () => {
    const values = ciWorkflowSecretValues();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      for (const variable of [
        "NEXTAUTH_SECRET",
        "FAYANMS_SERVICE_SECRET",
        "FAYANMS_CONFIG_ENC_KEY",
      ] as const) {
        const violations = findProductionPolicyViolations(prodEnv({ [variable]: value }));
        const hit = violations.find((v) => v.variable === variable);
        expect(hit).toBeDefined();
        expect(hit?.reason).toContain("known demo/repository default");
      }
    }
  });

  test("the CI sample is refused on each variable by NAME (explicit pins)", () => {
    const sample = "6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03";
    expect(sample).toMatch(/^[0-9a-f]{64}$/); // it IS shape-valid — refusal is the blocklist's job
    for (const variable of [
      "NEXTAUTH_SECRET",
      "FAYANMS_SERVICE_SECRET",
      "FAYANMS_CONFIG_ENC_KEY",
    ] as const) {
      const violations = findProductionPolicyViolations(prodEnv({ [variable]: sample }));
      expect(violations.some((v) => v.variable === variable)).toBe(true);
    }
  });

  test("rotation-list entries are held to the same bar", () => {
    const sample = "6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03";
    const knownBad = findProductionPolicyViolations(
      prodEnv({ FAYANMS_SERVICE_SECRETS: `${randomBytes(32).toString("hex")},${sample}` })
    );
    expect(knownBad.some((v) => v.variable === "FAYANMS_SERVICE_SECRETS[1]")).toBe(true);

    const malformed = findProductionPolicyViolations(
      prodEnv({ FAYANMS_SERVICE_SECRETS: "not-hex-at-all" })
    );
    expect(malformed.some((v) => v.variable === "FAYANMS_SERVICE_SECRETS[0]")).toBe(true);
  });

  test("a freshly generated secret still passes validation (not over-tightened)", () => {
    const fresh = randomBytes(32).toString("hex");
    const violations = findProductionPolicyViolations(
      prodEnv({
        NEXTAUTH_SECRET: fresh,
        FAYANMS_SERVICE_SECRET: fresh,
        FAYANMS_CONFIG_ENC_KEY: fresh,
      })
    );
    expect(violations).toEqual([]);
  });
});

describe("P2-1 — Prisma query logging is gated, production-safe by default", () => {
  test("production default: no query logging, errors+warnings retained", () => {
    const levels = prismaLogLevels({ NODE_ENV: "production" });
    expect(levels).not.toContain("query");
    expect(levels).toContain("error");
    expect(levels).toContain("warn");
  });

  test("development keeps full query visibility", () => {
    const levels = prismaLogLevels({ NODE_ENV: "development" });
    expect(levels).toContain("query");
  });

  test("unset NODE_ENV (CI/test) keeps full query visibility", () => {
    const levels = prismaLogLevels({} as NodeJS.ProcessEnv);
    expect(levels).toContain("query");
  });

  test("FAYANMS_DB_QUERY_LOG=true is the explicit production escape hatch", () => {
    const levels = prismaLogLevels({ NODE_ENV: "production", [DB_QUERY_LOG_ENV]: "true" });
    expect(levels).toContain("query");
    expect(prismaLogLevels({ NODE_ENV: "production", [DB_QUERY_LOG_ENV]: "1" })).toContain("query");
    // Non-truthy values do NOT open the hatch.
    expect(prismaLogLevels({ NODE_ENV: "production", [DB_QUERY_LOG_ENV]: "false" })).not.toContain(
      "query"
    );
  });

  test("db.ts delegates to the policy — no inline log literal may return", () => {
    const source = readRepoFile("src/lib/db.ts");
    expect(source).toContain("prismaLogLevels(");
    expect(source).not.toMatch(/log:\s*\[\s*['"]query['"]/);
  });
});

describe("P2-3 — db:push is fail-tight; data-loss acceptance is explicit", () => {
  const scripts = JSON.parse(readRepoFile("package.json")).scripts as Record<string, string>;

  test("db:push carries NO destructive flag", () => {
    expect(scripts["db:push"]).toBe("prisma db push");
    expect(scripts["db:push"]).not.toContain("--accept-data-loss");
  });

  test("the destructive capability survives behind an explicit force script", () => {
    expect(scripts["db:push:force"]).toBeDefined();
    expect(scripts["db:push:force"]).toContain("--accept-data-loss");
  });
});
