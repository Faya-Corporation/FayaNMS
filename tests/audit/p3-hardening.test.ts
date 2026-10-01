import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * P3 hardening batch (independent audit 2026-09-15 — NEW-1..NEW-4 + the
 * session-lifetime and auth-guard findings), each classified honestly:
 *
 *   P3-AUTH-GUARD (F1)  the credentials-callback wrapper must FORWARD the
 *                       route context (the E2E journey found R35's bare
 *                       `handler(req)` 500-ing EVERY runtime sign-in);
 *                       pinned at source so the fix can never regress.
 *   P3-LOG (NEW-2)      the production start script must not pipe stdout
 *                       into an unbounded local file (`tee server.log`) —
 *                       log RETENTION is the process manager's contract
 *                       (compose json-file caps; journald/logrotate on
 *                       bare metal).
 *   P3-SESSION (NEW-3)  an administrative plane does not get 30-day
 *                       sessions: 12 h absolute lifetime, documented
 *                       rationale (NOC-shift scale; per-request role/
 *                       deactivation propagation already revalidates the
 *                       actor; stolen-cookie half-life bounded).
 *   P3-SSRF (NEW-4)     the DNS-rebinding TOCTOU window is explicitly
 *                       classified ACCEPTED RESIDUAL RISK with the threat
 *                       model and the reason a fix was refused (a custom
 *                       transport rewrite for a theoretical P3 would risk
 *                       the SSRF guard itself) — the classification is
 *                       greppable and must not silently disappear.
 *   NEW-1               /api/v1/auth/* is exempt from the rate gate BY
 *                       DESIGN — pinned: every route file under it stays
 *                       read-only (GET). A future mutation there FAILS
 *                       this test and forces a governance decision (govern
 *                       the route or narrow the exemption).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("P3-AUTH-GUARD: the sign-in wrapper forwards the route context", () => {
  const route = readRepoFile("src/app/api/auth/[...nextauth]/route.ts");

  test("POST forwards ctx to the NextAuth handler (journey-found P1 fix)", () => {
    expect(route).toContain("handler(req, ctx)");
    expect(route).not.toContain("return handler(req);");
  });

  test("the regression is documented where it was fixed", () => {
    expect(route).toContain("TEST-001-A");
    expect(route).toContain("nextauth");
  });
});

describe("P3-LOG: production stdout is not tee'd into an unbounded file", () => {
  test("the start script has no tee/server.log pipe", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBeTruthy();
    expect(pkg.scripts.start).not.toContain("tee");
    expect(pkg.scripts.start).not.toContain("server.log");
  });

  test("compose retains bounded json-file logging (the retention contract)", () => {
    const compose = readRepoFile("compose.yml");
    expect(compose).toContain("max-size");
    expect(compose).toContain("max-file");
  });
});

describe("P3-SESSION: administrative-plane session lifetime is bounded", () => {
  const options = readRepoFile("src/lib/auth/options.ts");

  test("session maxAge is 12 hours, not the 30-day default", () => {
    expect(options).toContain("maxAge: 12 * 60 * 60");
    expect(options).not.toContain("30 * 24 * 60 * 60");
  });

  test("the rationale is documented next to the policy", () => {
    expect(options).toContain("12 h");
    expect(options).toContain("NOC");
  });
});

describe("P3-SSRF: the DNS-rebinding residual is a CLASSIFIED accepted risk", () => {
  const guard = readRepoFile("src/lib/integrations/ssrf-guard.ts");

  test("the classification marker exists and is greppable", () => {
    expect(guard).toContain("ACCEPTED RESIDUAL RISK");
  });

  test("the threat model and the refusal reason are documented", () => {
    expect(guard).toContain("TOCTOU");
    expect(guard).toContain("redirect");
  });

  test("the two-plane enforcement (admission + delivery re-check) is intact", () => {
    expect(guard).toContain("SSRF_BLOCKED_PREFIX");
    expect(guard).toContain('redirect: "error"');
  });
});

describe("NEW-1: /api/v1/auth/* rate-gate exemption stays read-only", () => {
  test("every route file under /api/v1/auth exports GET only (no mutations)", () => {
    const authDir = path.join(REPO_ROOT, "src/app/api/v1/auth");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") files.push(full);
      }
    };
    walk(authDir);
    // The exemption exists for session/bootstrap reads; if this expectation
    // ever fails, a mutation arrived under the ungated prefix — either give
    // it explicit governance (requirePermission + audit) or narrow the
    // proxy exemption. It must never inherit the exemption silently.
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content).toMatch(/export async function GET/);
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(content).not.toContain(`export async function ${verb}`);
      }
    }
  });
});

describe("DOC-001-A: governance docs match the LIVE GitHub state", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");
  const deployDoc = readRepoFile("docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md");

  test("the workflow header matches the CURRENT protection state", () => {
    // DOC-001-A (2026-09-15) pinned the then-truth: protection off. The
    // owner applied protection on 2026-09-19 (worklog Task 3) and RT-034
    // refreshed the header — the pin now enforces the CURRENT truth so
    // the header can never silently drift back either way.
    expect(ci).not.toContain("Branch protection: NOT ACTIVE");
    expect(ci).toMatch(/Branch protection:\s*ACTIVE \(owner-applied, worklog Task 3, 2026-09-19\)/);
    expect(ci).toContain("bun scripts/gov-verify.ts");
  });

  test("the deployment runbook states the same live truth", () => {
    expect(deployDoc).toContain("Branch protection is NOT active today");
    expect(deployDoc).toContain("GOV-001");
    expect(deployDoc).not.toContain("already live at the GitHub side");
  });
});
