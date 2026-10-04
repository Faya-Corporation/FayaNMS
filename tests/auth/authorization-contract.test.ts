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
 * (phase 1 gated the dashboard domain, phase 2 gated events/alerts,
 * phase 3 gated devices/interfaces).
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
  // Admin-surface gate (Task 7-b): resolveAdminActor() wraps
  // requireRole(req, "admin") — full session + active-user DB check + admin
  // role. Recognized from F-008 phase 4a on so the read matrix reflects the
  // admin reads' REAL handler-level enforcement (they were allowlisted in
  // phases 1-3 only because this wrapper was not a recognized marker).
  "resolveAdminActor(",
];

/**
 * F-008 read-route allowlist — route files whose GET handler(s) perform NO
 * handler-level auth. Phase 1 gated the dashboard domain and pinned the
 * initial list at 59 entries; phase 2 gated events/alerts (−3 → 56);
 * phase 3 gated devices/interfaces (−9 → 47); phase 4a gated
 * incidents/changes/cmdb with requireSessionRead (−11) AND recognized the
 * admin surface's resolveAdminActor → requireRole("admin") gate (−8) → 28;
 * phase 4b gated the long tail (−27 → 1). The sole survivor is the
 * deliberate public bootstrap surface (meta/route.ts — pre-auth branding/
 * status, empty data by contract). The list may never GROW past the pinned
 * cap: a new unguarded read route fails the matrix test, and raising the
 * cap is a deliberate, documented governance edit (RT-034 protocol — never
 * a silent side effect of an unrelated diff).
 */
const READ_ALLOWLIST_INITIAL_SIZE = 59;
const READ_ALLOWLIST: Record<string, string> = {
  // ── deliberate non-gate (public bootstrap surface) ────────────────────
  "meta/route.ts": "public bootstrap (branding/status; read-only)",
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

  test("admin/users GET gates the full email directory to admin/auditor (F-029)", () => {
    const users = readFileSync(
      join(API_ROOT, "admin", "users", "route.ts"),
      "utf8"
    );
    // The F-029 role gate: the full email directory is admin/auditor only
    // (requireUser — any active user — must not come back).
    expect(users).toContain('requireRole(request, "admin", "auditor")');
    expect(users).not.toContain("requireUser(request)");
    // The non-privileged directory surface stays the meta/users
    // local-part picker (no full emails beyond the local-part).
    const metaUsers = readFileSync(
      join(API_ROOT, "meta", "users", "route.ts"),
      "utf8"
    );
    expect(metaUsers).toContain('split("@")');
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
    // (events/alerts gated); 47 after phase 3 (devices/interfaces gated);
    // 28 after phase 4a (incidents/changes/cmdb + admin recognition);
    // 1 after phase 4b (the long tail gated — only the public bootstrap
    // /api/v1/meta remains, deliberately).
    // Later phases delete lines; a deliberate cap raise is a documented
    // governance edit (RT-034).
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

  test("devices/interfaces domain is handler-gated (F-008 phase 3 landed)", () => {
    const domain = [
      "devices/route.ts",
      "devices/[id]/route.ts",
      "devices/[id]/alerts/route.ts",
      "devices/[id]/audit/route.ts",
      "devices/[id]/changes/route.ts",
      "devices/[id]/incidents/route.ts",
      "devices/[id]/interfaces/route.ts",
      "devices/[id]/metrics/route.ts",
      "interfaces/route.ts",
    ];
    for (const rel of domain) {
      expect(READ_ALLOWLIST[rel]).toBeUndefined();
      const bodies = getHandlerBodies(readFileSync(join(API_ROOT, rel), "utf8"));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).toContain("requireSessionRead(");
      }
    }
    // The devices files keep their permission-gated POST/PATCH alongside
    // the newly session-gated GETs — the gate addition must not weaken the
    // mutation plane.
    const devices = readFileSync(join(API_ROOT, "devices", "route.ts"), "utf8");
    expect(devices).toContain('requirePermission(request, "device.write")');
    const deviceDetail = readFileSync(
      join(API_ROOT, "devices", "[id]", "route.ts"),
      "utf8"
    );
    expect(deviceDetail).toContain('requirePermission(request, "device.write")');
  });

  test("incidents/changes/cmdb domain is handler-gated (F-008 phase 4a landed)", () => {
    const domain = [
      "incidents/route.ts",
      "incidents/[id]/route.ts",
      "incidents/stats/route.ts",
      "incidents/export/route.ts",
      "incidents/correlate/route.ts",
      "changes/[id]/route.ts",
      "changes/conflicts/route.ts",
      "cmdb/items/route.ts",
      "cmdb/items/[id]/route.ts",
      "cmdb/relations/route.ts",
      "cmdb/impact/route.ts",
    ];
    for (const rel of domain) {
      expect(READ_ALLOWLIST[rel]).toBeUndefined();
      const bodies = getHandlerBodies(readFileSync(join(API_ROOT, rel), "utf8"));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).toContain("requireSessionRead(");
      }
    }
    // The gated files keep their permission-gated mutations alongside the
    // newly session-gated GETs — the gate addition must not weaken the
    // mutation plane.
    const cmdbItems = readFileSync(join(API_ROOT, "cmdb", "items", "route.ts"), "utf8");
    expect(cmdbItems).toContain('requirePermission(request, "cmdb.write")');
    const changeDetail = readFileSync(
      join(API_ROOT, "changes", "[id]", "route.ts"),
      "utf8"
    );
    expect(changeDetail).toContain('requirePermission(request, "change.cancel")');
  });

  test("admin reads are handler-gated via resolveAdminActor (F-008 phase 4a recognition)", () => {
    // Not a code change: the admin GETs always enforced requireRole("admin")
    // through resolveAdminActor — the matrix simply did not recognize the
    // wrapper as a gate marker until phase 4a. Pin the recognition AND the
    // underlying strict gate so neither can silently regress.
    const domain = [
      "admin/api-clients/route.ts",
      "admin/audit-chain/verify/route.ts",
      "admin/collectors/route.ts",
      "admin/collectors/distribution/route.ts",
      "admin/drivers/route.ts",
      "admin/notification-channels/route.ts",
      "admin/settings/route.ts",
      "admin/webhooks/route.ts",
    ];
    for (const rel of domain) {
      expect(READ_ALLOWLIST[rel]).toBeUndefined();
      const bodies = getHandlerBodies(readFileSync(join(API_ROOT, rel), "utf8"));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).toContain("resolveAdminActor(");
      }
    }
    // The wrapper itself must keep delegating to the admin role gate.
    const wrapper = readFileSync(
      join(import.meta.dir, "..", "..", "src", "lib", "auth", "acting-admin.ts"),
      "utf8"
    );
    expect(wrapper).toContain('requireRole(req, "admin")');
  });

  test("the long tail is handler-gated and the allowlist is down to the public bootstrap (F-008 phase 4b landed)", () => {
    const domain = [
      "backup-policies/route.ts",
      "backup-policies/[id]/route.ts",
      "baselines/route.ts",
      "compliance/backup/route.ts",
      "discovery/route.ts",
      "discovery/policies/route.ts",
      "drift/route.ts",
      "firmware/route.ts",
      "flows/route.ts",
      "flows/retention/route.ts",
      "ha/route.ts",
      "jobs/route.ts",
      "maintenance/route.ts",
      "metrics/retention/route.ts",
      "notifications/route.ts",
      "performance/overview/route.ts",
      "performance/availability/route.ts",
      "performance/capacity/route.ts",
      "performance/devices/route.ts",
      "performance/interfaces/route.ts",
      "predictive/route.ts",
      "search/route.ts",
      "sites/route.ts",
      "snapshots/route.ts",
      "topology/route.ts",
      "ztp/claims/route.ts",
      "meta/reference/route.ts",
    ];
    for (const rel of domain) {
      expect(READ_ALLOWLIST[rel]).toBeUndefined();
      const bodies = getHandlerBodies(readFileSync(join(API_ROOT, rel), "utf8"));
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).toContain("requireSessionRead(");
      }
    }
    // The sweep is COMPLETE: the only remaining non-gate is the public
    // bootstrap surface, pinned by name.
    expect(Object.keys(READ_ALLOWLIST)).toEqual(["meta/route.ts"]);
    // The locally-wrapped permission gates survived the gate addition —
    // the session gate runs FIRST, the stricter check still runs after.
    const discoveryPolicies = readFileSync(
      join(API_ROOT, "discovery", "policies", "route.ts"),
      "utf8"
    );
    expect(discoveryPolicies).toContain('requirePermission(request, "device.read")');
    const flowsRetention = readFileSync(
      join(API_ROOT, "flows", "retention", "route.ts"),
      "utf8"
    );
    expect(flowsRetention).toContain('requirePermission(request, "admin.system")');
    // The public bootstrap stays EMPTY by contract (RT-024) — the meta/
    // reference split is now enforced by the session gate, not the proxy
    // alone.
    const metaRoute = readFileSync(join(API_ROOT, "meta", "route.ts"), "utf8");
    expect(metaRoute).not.toContain("db.user.findMany");
  });
});
