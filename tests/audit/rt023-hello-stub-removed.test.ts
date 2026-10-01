import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-023 / F-035 — remove the unauthenticated `/api` hello-world stub.
 *
 * BEFORE: `src/app/api/route.ts` was a 5-line scaffold leftover serving an
 * unauthenticated JSON hello OUTSIDE the `/api/v1` proxy gate (matcher is
 * `/api/v1/:path*`, src/proxy.ts). No sensitive data, but dead attack
 * surface that shows up in external scans and the only handler in the repo
 * with zero auth/rate-limit/envelope discipline.
 *
 * Pinned here:
 *   1. the stub route file is gone;
 *   2. no hello-world stub references remain outside the historical audit
 *      records (docs/review/** quotes the literal string as evidence — those are the
 *      planning/EOD artifacts, deliberately untouched);
 *   3. GET /api answers 404 (e2e-gated: runs only under FAYANMS_E2E=1
 *      against the real production build booted by tests/e2e/e2e-server.ts;
 *      the hermetic unit gate asserts 1 and 2 instead).
 */

const REPO_ROOT = join(import.meta.dir, "../..");

// The stub phrase is assembled so this police test does not itself
// contain the contiguous string it forbids.
const STUB_PHRASE = ["Hello", "world"].join(", ");

const E2E_ENABLED = process.env.FAYANMS_E2E === "1";

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkSources(full, out);
    else out.push(full);
  }
  return out;
}

describe("RT-023: unauthenticated /api hello stub removed", () => {
  test("stub route file is gone", () => {
    expect(existsSync(join(REPO_ROOT, "src/app/api/route.ts"))).toBe(false);
  });

  test("no references remain in src/ or tests/ (docs only keep historical audit records)", () => {
    for (const relDir of ["src", "tests"]) {
      for (const file of walkSources(join(REPO_ROOT, relDir))) {
        const src = readFileSync(file, "utf8");
        expect({ file, containsHelloWorld: src.includes(STUB_PHRASE) }).toEqual({
          file,
          containsHelloWorld: false,
        });
      }
    }
    // docs/: the audit-review artifacts (docs/review/**) quote the stub as
    // historical evidence — allowed. Any OTHER doc referencing it is a
    // straggler this RT must not leave behind.
    const docsDir = join(REPO_ROOT, "docs");
    for (const file of walkSources(docsDir)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (rel.startsWith(join("docs", "review"))) continue;
      const src = readFileSync(file, "utf8");
      expect({ file: rel, containsHelloWorld: src.includes(STUB_PHRASE) }).toEqual({
        file: rel,
        containsHelloWorld: false,
      });
    }
  });

  test(
    "GET /api answers 404 (not a JSON hello) against the production build",
    async () => {
      if (!E2E_ENABLED) return; // skipped in the hermetic unit gate
      const { APP_BASE, bootE2E, teardownE2E } = await import("../e2e/e2e-server");
      await bootE2E();
      try {
        const res = await fetch(`${APP_BASE}/api`);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toContain("Hello");
      } finally {
        await teardownE2E();
      }
    },
    200_000,
  );
});
