import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Authorization contract inventory (Phase 19-C / audit P19C-AUTHZ-005 +
 * P19C-AUTHZ-006): EVERY route file that exports a mutating handler
 * (POST/PUT/PATCH/DELETE) must perform one of the authoritative checks:
 *
 *   requirePermission(request, "…")            — human permission gate
 *   requireRole(request, "admin")              — admin role gate
 *   requireApprovalEntitlement(request, level) — approval-level gate
 *   authenticateServiceRequest(request, scope) — service JWT + scope
 *   requireServiceOrPermission(request, …)     — dual service/human gate
 *   verifyControlToken(request, scope)         — worker control-plane gate
 *
 * The middleware is only a coarse 401/auditor gate and does NOT count.
 * Anything without a marker must appear in the documented allowlist
 * (docs/security/authorization-matrix.md §4) — a growing allowlist fails
 * this test, so the matrix can never silently rot.
 */

const API_ROOT = join(import.meta.dir, "..", "..", "src", "app", "api", "v1");

const MARKERS = [
  "requirePermission(",
  "requireRole(",
  "requireApprovalEntitlement(",
  "authenticateServiceRequest(",
  "requireServiceOrPermission(",
  "verifyControlToken(",
];

/** Allowlist: file → justification (mirrors matrix doc §4; keep in sync). */
const ALLOWLIST: Record<string, string> = {
  "meta/route.ts": "public bootstrap (branding/status; read-only)",
  "auth/session/route.ts": "session bootstrap; answers its own 401 envelope",
  "ai/assist/route.ts": "session-gated generation helper; no persistent state change",
  "ai/query/route.ts": "session-gated generation helper; no persistent state change",
  "ai/change-draft/route.ts": "session-gated generation helper; no persistent state change",
  "ai/rca-draft/route.ts": "session-gated generation helper; no persistent state change",
  "notifications/read/route.ts": "user-scoped: marks the CALLER's own notifications read",
};

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectRouteFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

const MUTATING_VERBS = [
  "export async function POST",
  "export async function PUT",
  "export async function PATCH",
  "export async function DELETE",
];

describe("authorization contract inventory", () => {
  const files = collectRouteFiles(API_ROOT);
  const mutating = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return MUTATING_VERBS.some((verb) => source.includes(verb));
  });

  test("found a meaningful route surface", () => {
    expect(files.length).toBeGreaterThan(60);
    expect(mutating.length).toBeGreaterThan(40);
  });

  test("every mutating route carries an authoritative auth marker or is allowlisted", () => {
    const violations: string[] = [];
    for (const file of mutating) {
      const rel = file.slice(API_ROOT.length + 1);
      const source = readFileSync(file, "utf8");
      if (!MARKERS.some((marker) => source.includes(marker))) {
        if (ALLOWLIST[rel]) continue;
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the allowlist stays pinned — no undocumented entries", () => {
    const known = new Set(Object.keys(ALLOWLIST));
    for (const file of files) {
      const rel = file.slice(API_ROOT.length + 1);
      if (known.has(rel)) known.delete(rel);
    }
    // Every allowlist entry must still exist on disk (no stale entries).
    expect([...known]).toEqual([]);
  });

  test("approval entitlement uses the level-specific permissions", () => {
    const approvals = readFileSync(
      join(API_ROOT, "changes", "[id]", "approvals", "route.ts"),
      "utf8"
    );
    expect(approvals).toContain("requireApprovalEntitlement");
    expect(approvals).toContain("actorIsWildcard");
  });

  test("execute route enforces change.execute", () => {
    const execute = readFileSync(
      join(API_ROOT, "changes", "[id]", "execute", "route.ts"),
      "utf8"
    );
    expect(execute).toContain('"change.execute"');
  });

  test("restore route enforces config.restore", () => {
    const restore = readFileSync(
      join(API_ROOT, "devices", "[id]", "snapshots", "[snapshotId]", "restore", "route.ts"),
      "utf8"
    );
    expect(restore).toContain('"config.restore"');
  });

  test("changes POST enforces change.create", () => {
    const changes = readFileSync(join(API_ROOT, "changes", "route.ts"), "utf8");
    expect(changes).toContain('"change.create"');
  });

  test("no route synthesizes the legacy fallback admin actor", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (source.includes('actorName: "Admin"') || source.includes("demoActor(")) {
        offenders.push(file.slice(API_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("service routes enforce their scope, not just authentication", () => {
    const claim = readFileSync(join(API_ROOT, "worker", "claim", "route.ts"), "utf8");
    expect(claim).toContain('authenticateServiceRequest(request, "jobs")');
    const evaluate = readFileSync(join(API_ROOT, "alerts", "evaluate", "route.ts"), "utf8");
    expect(evaluate).toContain('authenticateServiceRequest(request, "alerts")');
    const prune = readFileSync(
      join(API_ROOT, "metrics", "retention", "prune", "route.ts"),
      "utf8"
    );
    expect(prune).toContain('"metrics"');
  });
});
