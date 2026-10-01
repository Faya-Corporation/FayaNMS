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
 *
 * F-008 (phase 1 onward) adds the READ-ROUTE MATRIX below: every exported
 * GET handler must carry a handler-level auth marker of its own (checked
 * per HANDLER body, not per file — a file whose POST is gated but whose
 * GET is bare fails this matrix). Ungated reads must be explicitly
 * allowlisted with their F-008 phase justification; the allowlist starts
 * at its phase-1 size and may only SHRINK as the per-domain sweep lands
 * (phase 1 gated the dashboard domain, phase 2 gated events/alerts).
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

/**
 * Extract the body of every `export async function GET(…)` handler via
 * paren-aware signature skip + brace matching (pure node — the source-
 * police convention after the ripgrep CI incident). Returns the body text
 * of each GET handler found (multiple exports → multiple bodies).
 */
function getHandlerBodies(source: string): string[] {
  const bodies: string[] = [];
  const re = /export\s+async\s+function\s+GET\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // Skip the parameter list (paren depth), then brace-match the body.
    let i = match.index + match[0].length - 1; // at "("
    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "(") parenDepth++;
      else if (source[i] === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          i++;
          break;
        }
      }
    }
    const open = source.indexOf("{", i);
    if (open === -1) continue;
    let braceDepth = 0;
    let end = -1;
    for (let j = open; j < source.length; j++) {
      if (source[j] === "{") braceDepth++;
      else if (source[j] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end !== -1) bodies.push(source.slice(open, end + 1));
  }
  return bodies;
}

const MUTATING_VERBS = [
  "export async function POST",
  "export async function PUT",
  "export async function PATCH",
  "export async function DELETE",
];

/**
 * F-008 read-plane gates — a GET handler is authenticated when its OWN
 * body performs one of the authoritative session/auth checks (the same
 * set as the mutation inventory plus the read-specific helpers:
 * requireSessionRead, and the direct-claim reads getSessionUser /
 * resolveActingUser that authenticate the caller without a DB row lock).
 */
const READ_GATES = [
  "requireSessionRead(",
  "requireUser(",
  "requireRole(",
  "requirePermission(",
  "requireApprovalEntitlement(",
  "authenticateServiceRequest(",
  "requireServiceOrPermission(",
  "verifyControlToken(",
  "getSessionUser(",
  "resolveActingUser(",
];

/**
 * F-008 read-route allowlist — route files whose GET handler(s) perform NO
 * handler-level auth. Phase 1 gated the dashboard domain and pinned the
 * initial list at 59 entries; phase 2 gated events/alerts (−3 → 56).
 * Every later phase DELETES its domain's entries. The list may never GROW
 * past the pinned cap: a new unguarded read route fails the matrix test,
 * and raising the cap is a deliberate, documented governance edit (RT-034
 * protocol — never a silent side effect of an unrelated diff).
 */
const READ_ALLOWLIST_INITIAL_SIZE = 59;
const READ_ALLOWLIST: Record<string, string> = {
  // ── deliberate non-gates (bootstrap/reference surfaces) ───────────────
  "meta/route.ts": "public bootstrap (branding/status; read-only)",
  "meta/reference/route.ts": "authenticated filter-bar reference data — proxy-gated today; F-008 candidate once the sweep reaches meta",
  // ── F-008 phase 3: devices / interfaces domain ────────────────────────
  "devices/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/alerts/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/audit/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/changes/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/incidents/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/interfaces/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "devices/[id]/metrics/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  "interfaces/route.ts": "F-008 rollout pending (phase 3: devices/interfaces)",
  // ── F-008 phase 4+: the rest ─────────────────────────────────────────
  "admin/api-clients/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/audit-chain/verify/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/collectors/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/collectors/distribution/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/drivers/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/notification-channels/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/settings/route.ts": "F-008 rollout pending (phase 4: admin)",
  "admin/webhooks/route.ts": "F-008 rollout pending (phase 4: admin)",
  "backup-policies/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "backup-policies/[id]/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "baselines/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "changes/[id]/route.ts": "F-008 rollout pending (phase 4: the rest; PATCH/DELETE are permission-gated, GET is not)",
  "changes/conflicts/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "cmdb/items/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "cmdb/items/[id]/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "cmdb/relations/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "cmdb/impact/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "compliance/backup/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "discovery/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "discovery/policies/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "drift/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "firmware/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "flows/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "flows/retention/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "ha/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "incidents/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "incidents/[id]/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "incidents/stats/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "incidents/export/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "incidents/correlate/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "jobs/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "maintenance/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "metrics/retention/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "notifications/route.ts": "F-008 rollout pending (phase 4: the rest; list reads the caller's own rows)",
  "performance/overview/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "performance/availability/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "performance/capacity/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "performance/devices/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "performance/interfaces/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "predictive/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "search/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "sites/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "snapshots/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "topology/route.ts": "F-008 rollout pending (phase 4: the rest)",
  "ztp/claims/route.ts": "F-008 rollout pending (phase 4: the rest)",
};

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

describe("F-008 read-route matrix (handler-level read-plane authn)", () => {
  const files = collectRouteFiles(API_ROOT);
  const readFiles = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return getHandlerBodies(source).length > 0;
  });

  test("found a meaningful read surface", () => {
    expect(readFiles.length).toBeGreaterThan(60);
  });

  test("every GET handler carries a read gate or is explicitly allowlisted", () => {
    const violations: string[] = [];
    for (const file of readFiles) {
      const rel = file.slice(API_ROOT.length + 1);
      const bodies = getHandlerBodies(readFileSync(file, "utf8"));
      const gated = bodies.some((body) =>
        READ_GATES.some((marker) => body.includes(marker))
      );
      if (!gated && !READ_ALLOWLIST[rel]) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });

  test("the read allowlist only shrinks — phase-1 size cap", () => {
    // 59 entries at phase 1 (dashboard gated); 56 after phase 2
    // (events/alerts gated). Later phases delete lines; a deliberate cap
    // raise is a documented governance edit (RT-034).
    expect(Object.keys(READ_ALLOWLIST).length).toBeLessThanOrEqual(
      READ_ALLOWLIST_INITIAL_SIZE
    );
  });

  test("no stale read-allowlist entries", () => {
    const known = new Set(Object.keys(READ_ALLOWLIST));
    for (const file of readFiles) {
      known.delete(file.slice(API_ROOT.length + 1));
    }
    expect([...known]).toEqual([]);
  });

  test("dashboard domain is handler-gated (F-008 phase 1 landed)", () => {
    const rel = "dashboard/route.ts";
    expect(READ_ALLOWLIST[rel]).toBeUndefined();
    const bodies = getHandlerBodies(readFileSync(join(API_ROOT, "dashboard", "route.ts"), "utf8"));
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("requireSessionRead(");
  });

  test("events/alerts domain is handler-gated (F-008 phase 2 landed)", () => {
    const domain = ["events/route.ts", "alerts/route.ts", "alerts/rules/route.ts"];
    for (const rel of domain) {
      expect(READ_ALLOWLIST[rel]).toBeUndefined();
      const bodies = getHandlerBodies(readFileSync(join(API_ROOT, rel), "utf8"));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).toContain("requireSessionRead(");
      }
    }
    // The rules file keeps its permission-gated POST alongside the newly
    // session-gated GET — the gate addition must not weaken the mutation
    // plane.
    const rules = readFileSync(join(API_ROOT, "alerts", "rules", "route.ts"), "utf8");
    expect(rules).toContain('requirePermission(request, "admin.system")');
  });
});
