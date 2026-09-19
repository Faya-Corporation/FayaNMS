import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GET as snapshotDiffGET } from "@/app/api/v1/devices/[id]/snapshots/diff/route";
import { roleHasPermission } from "@/lib/auth/permissions";
import { ROLE_MATRIX } from "@/lib/auth/role-matrix";

/**
 * R69 — FULL ROADMAP RE-REVIEW remediations (senior independent full-stack
 * re-review of every Production-Readiness Roadmap item, 2026-09-19).
 *
 * The re-review re-verified each roadmap item against the ACTUAL code (three
 * parallel deep-read passes + live wire probes) and surfaced four authorable
 * findings, remediated and pinned here:
 *
 * R69-F1 (P1) — `GET /api/v1/devices/[id]/snapshots/diff` had NO handler-level
 *   authorization at all: it decrypted BOTH snapshots and returned full
 *   configuration text (raw or normalized) to ANY authenticated session
 *   (viewer/auditor included). That directly violated the R62 invariant
 *   ("snapshot texts are config.download-gated; decrypt only on the
 *   privileged path — React masking is not an authorization boundary").
 *   AFTER: the route requires the explicit "config.download" permission
 *   BEFORE any DB work (401/403 — never a pre-auth existence oracle), and
 *   denials are audited as CONFIG_DIFF_DENIED, mirroring the download route.
 *   Intentional consequence: viewer/auditor (who hold only `*.read`) now
 *   receive 403 on the diff dialogs — fail-closed, consistent with how the
 *   raw download route already treats them.
 *
 * R69-F2 (P3) — `/api/v1/meta/users` mapped `name: user.name ?? user.email`
 *   — a user with a null name would have had their FULL email exposed,
 *   contradicting the route's own "no emails beyond the local-part"
 *   contract. AFTER: the fallback is the email local-part.
 *
 * R69-F3 (P3) — `scripts/gov-verify.ts` asserted force-push/deletion/
 *   conversation-resolution/linear-history ONLY on the classic protection
 *   plane; `evaluateRulesets` ignored those rule types, so a ruleset-only
 *   governance setup could pass with those guarantees unverified. The header
 *   also claimed "the first source that reports an ACTIVE enforcement wins"
 *   while the code actually REQUIRES both mechanisms, and linear history was
 *   labeled "advisory — record-only" while being enforced as a hard
 *   invariant. AFTER: the ruleset plane asserts all four protective rule
 *   types, the header describes the both-required contract, and the
 *   mislabel is gone.
 *
 * R69-F4 (cosmetic) — ci.yml's governance header still carried pre-R47
 *   wording ("runs gate + scan (+ e2e)") inside an otherwise four-check
 *   document. AFTER: the narrative names ALL FOUR jobs.
 *
 * Role-matrix note (documented intent): config.download is held by admin
 * (via "*"), operator, engineer, manager; auditor and viewer (only "*.read")
 * do NOT hold it — their diff dialogs now fail closed by design.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const DIFF_ROUTE = "src/app/api/v1/devices/[id]/snapshots/diff/route.ts";
const META_USERS_ROUTE = "src/app/api/v1/meta/users/route.ts";
const GOV_SCRIPT = "scripts/gov-verify.ts";
const CI_YML = ".github/workflows/ci.yml";

function readRepo(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("R69-F1: snapshots/diff is a privileged, download-gated config-text surface", () => {
  test("WIRE: no session → 401 UNAUTHENTICATED BEFORE any DB work (never a 404 oracle, never text)", async () => {
    // The handler resolves the actor BEFORE touching db.device /
    // db.configSnapshot: a session-less call must answer 401 even for a
    // device id that does not exist. This is the exact ordering discipline
    // the R52-F-N1 doctrine demands (401-before-404).
    const response = await snapshotDiffGET(
      new Request(
        "http://localhost/api/v1/devices/definitely-not-a-real-device/snapshots/diff?from=1&to=2&mode=normalized",
      ),
      { params: Promise.resolve({ id: "definitely-not-a-real-device" }) },
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("SOURCE: the config.download gate precedes every database touch and both decrypts", () => {
    const source = readRepo(DIFF_ROUTE);
    expect(source).toContain('requirePermission(request, "config.download")');
    expect(source).toContain("authErrorToFail");
    expect(source).toContain("CONFIG_DIFF_DENIED");

    // Slice the GET handler body and assert ORDER: permission gate →
    // (query parse) → db.device → resolveSnapshot → decryptSnapshotTexts.
    const getStart = source.indexOf("export async function GET");
    expect(getStart).toBeGreaterThan(-1);
    const handler = source.slice(getStart);
    const gateAt = handler.indexOf('requirePermission(request, "config.download")');
    const firstDbAt = handler.indexOf("db.device.findUnique");
    const decryptAt = handler.indexOf("decryptSnapshotTexts(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(firstDbAt).toBeGreaterThan(gateAt);
    expect(decryptAt).toBeGreaterThan(gateAt);
  });

  test("SOURCE: the pre-fix state can never silently return — no ungated decrypt path", () => {
    const source = readRepo(DIFF_ROUTE);
    // Every decryptSnapshotTexts call must be inside the gated handler (the
    // gate index precedes ALL of them), and the header documents the R69
    // authorization contract.
    const getStart = source.indexOf("export async function GET");
    const gateAt = source.indexOf('requirePermission(request, "config.download")');
    expect(gateAt).toBeGreaterThan(getStart);
    for (
      let at = source.indexOf("decryptSnapshotTexts(");
      at !== -1;
      at = source.indexOf("decryptSnapshotTexts(", at + 1)
    ) {
      expect(at).toBeGreaterThan(gateAt);
    }
    expect(source).toContain("R69 re-review remediation");
    expect(source).toContain("React masking is not an authorization boundary");
  });

  test("ROLE MATRIX: config.download holders keep the diff; read-only roles fail closed by design", () => {
    const holderOf = (roleName: string): boolean => {
      const role = ROLE_MATRIX.find((r) => r.name === roleName);
      if (!role) throw new Error(`unknown role ${roleName}`);
      return roleHasPermission(role.permissions, "config.download");
    };
    expect(holderOf("admin")).toBe(true);
    expect(holderOf("operator")).toBe(true);
    expect(holderOf("engineer")).toBe(true);
    expect(holderOf("manager")).toBe(true);
    // The intentional behavior change: these two roles could read decrypted
    // config text via diff BEFORE this fix; they are denied NOW.
    expect(holderOf("auditor")).toBe(false);
    expect(holderOf("viewer")).toBe(false);
  });
});

describe("R69-F2: /api/v1/meta/users never falls back to a full email address", () => {
  test("SOURCE: the name fallback is the email local-part (or id), never the bare email", () => {
    const source = readRepo(META_USERS_ROUTE);
    // The pre-fix mapping exposed the full email for null-name users.
    expect(source).not.toContain("name: user.name ?? user.email,");
    expect(source).toContain("name: user.name ?? user.email.split(\"@\")[0] ?? user.id");
    // The documented contract is still in place.
    expect(source).toContain("No emails are exposed beyond the");
  });
});

describe("R69-F3: gov-verify ruleset plane asserts the full protective-rule set", () => {
  test("SOURCE: all four protective ruleset rule types are asserted", () => {
    const script = readRepo(GOV_SCRIPT);
    expect(script).toContain('rule.type === "non_fast_forward"');
    expect(script).toContain('rule.type === "deletion"');
    expect(script).toContain('rule.type === "required_conversation_resolution"');
    expect(script).toContain('rule.type === "required_linear_history"');
    expect(script).toContain('name: "rulesets.non_fast_forward rule present (force-push blocked)"');
    expect(script).toContain('name: "rulesets.deletion rule present (branch deletion blocked)"');
    expect(script).toContain('name: "rulesets.required_conversation_resolution rule present"');
    expect(script).toContain('name: "rulesets.required_linear_history rule present"');
  });

  test("SOURCE: the header describes the BOTH-mechanisms-required contract (no 'first source wins')", () => {
    const script = readRepo(GOV_SCRIPT);
    expect(script).not.toContain("The first source that reports an ACTIVE enforcement wins");
    expect(script).toContain("BOTH mechanisms are verified and BOTH are REQUIRED");
  });

  test("SOURCE: linear history is no longer mislabeled 'advisory — record-only'", () => {
    const script = readRepo(GOV_SCRIPT);
    expect(script).not.toContain("(advisory — record-only)");
    expect(script).toContain('"classic.required_linear_history enabled"');
  });

  test("SOURCE: hygiene invariants from R67 still hold after the extension", () => {
    const script = readRepo(GOV_SCRIPT);
    expect(script).not.toContain("[...checksSeen]");
    expect(script).toContain("void main().catch(");
    expect(script).toContain('const REQUIRED_CHECKS = ["gate", "e2e", "browser", "scan"] as const;');
  });
});

describe("R69-F4: ci.yml governance header names all FOUR jobs", () => {
  test("SOURCE: the pre-R47 '(+ e2e)' narrative is gone; the marker line is intact", () => {
    const ci = readRepo(CI_YML);
    expect(ci).not.toContain("runs gate + scan (+ e2e)");
    expect(ci).toContain("runs ALL FOUR jobs (gate + e2e +");
    // The R66 canonical marker must be untouched.
    expect(ci).toContain("# required-checks: gate, scan, e2e, browser");
    // Still exactly the four jobs, no name overrides (extracted from the
    // `jobs:` block ONLY — trigger keys like `push:` must not pollute).
    const jobsSection = ci.slice(ci.indexOf("\njobs:\n"));
    const jobIds = [...jobsSection.matchAll(/^  ([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(jobIds.sort()).toEqual(["browser", "e2e", "gate", "scan"]);
    expect(jobsSection).not.toMatch(/^  [a-z0-9-]+:\s*\n\s*name:/m);
  });
});

describe("R69 documentation honesty", () => {
  test("ROADMAP: the path-correction appendix records the true implementation paths", () => {
    const roadmap = readRepo(
      "docs/audits/FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md",
    );
    expect(roadmap).toContain("R69 path-correction appendix");
    expect(roadmap).toContain("src/lib/api/rate-gate.ts");
    expect(roadmap).toContain("src/proxy.ts");
    expect(roadmap).toContain("src/app/api/v1/_lib/api.ts");
    expect(roadmap).toContain("src/components/views/");
  });
});
