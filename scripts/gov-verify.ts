#!/usr/bin/env bun
/**
 * GOV-001-A acceptance gate — EXECUTABLE read-back of `main` branch protection.
 *
 * TASK-GOV-001-A acceptance says: "Live API: protected:true + required checks;
 * docs match." Until now that read-back was a manual checklist. This script makes
 * it executable: it queries the GitHub API and exits nonzero UNLESS every
 * governance invariant holds, printing a field-by-field PASS/FAIL read-back
 * (truth-first — it reports what the API says, never what the docs hope).
 *
 * Canonical required-checks set (R66 unification): ALL FOUR ci.yml jobs —
 *   gate, e2e, browser, scan  (job ids; ci.yml uses no `name:` overrides).
 *
 * Supports BOTH protection mechanisms:
 *   1. classic branch protection  — GET /repos/{owner}/{repo}/branches/{branch}/protection
 *   2. rulesets                   — GET /repos/{owner}/{repo}/rulesets (branch target)
 * BOTH mechanisms are verified and BOTH are REQUIRED: each present mechanism
 * must satisfy its full invariant set, and a missing mechanism is itself a
 * FAIL (classic.protection-present / rulesets.present). A ruleset-only or
 * classic-only setup does not pass — the go-live definition (roadmap §Go-live
 * #3) names classic protection while TASK-GOV-001-A instructs configuring the
 * ruleset; the operator runbook treats them as one governance posture.
 *
 * Usage:
 *   GOV_VERIFY_TOKEN=<token-with-admin:read> bun scripts/gov-verify.ts [branch]
 *     branch defaults to "main"; pass z_ai_v2 to verify the recommended mirror.
 *
 * Token: read from GOV_VERIFY_TOKEN, then GITHUB_TOKEN, then GH_TOKEN —
 * env-only by design. NEVER passed via argv, never printed, never logged.
 *
 * Exit codes:
 *   0 — every invariant PASS (GOV-VERIFIED)
 *   1 — one or more invariants FAIL (each listed with the API-observed value)
 *   2 — configuration error (no token / unreachable API / 404 on the branch)
 */

type CheckResult = { name: string; ok: boolean; observed: string };

const REPO_FULL =
  process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/")
    ? process.env.GITHUB_REPOSITORY
    : "fayafatehi/FayaNMS";

const BRANCH = process.argv[2] ?? "main";

const REQUIRED_CHECKS = ["gate", "e2e", "browser", "scan"] as const;

function readToken(): string {
  const token =
    process.env.GOV_VERIFY_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    "";
  return token.trim();
}

async function ghGet(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

type ClassicProtection = {
  required_status_checks?: {
    enforcement_level?: string;
    strict?: boolean;
    contexts?: string[];
  } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_code_owner_reviews?: boolean;
    dismiss_stale_reviews?: boolean;
  } | null;
  required_conversation_resolution?: { enabled?: boolean } | null;
  enforce_admins?: { enabled?: boolean } | null;
  allow_force_pushes?: { enabled?: boolean } | null;
  allow_deletions?: { enabled?: boolean } | null;
  required_linear_history?: { enabled?: boolean } | null;
};

type Ruleset = {
  id: number;
  name: string;
  enforcement: "active" | "evaluate" | "disabled";
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
  };
  rules?: Array<{
    type: string;
    parameters?: {
      required_status_checks?: Array<{
        context?: string;
        integration_id?: number | null;
      }>;
      required_approving_review_count?: number;
      require_code_owner_review?: boolean;
      dismissal_restrictions?: unknown;
    };
  }>;
};

function checksFromContexts(contexts: string[] | undefined): {
  present: string[];
  missing: string[];
} {
  const present = REQUIRED_CHECKS.filter((c) => (contexts ?? []).includes(c));
  const missing = REQUIRED_CHECKS.filter((c) => !present.includes(c));
  return { present: [...present], missing };
}

function rulesetAppliesToBranch(rs: Ruleset, branch: string): boolean {
  const include = rs.conditions?.ref_name?.include ?? [];
  return include.some((pattern) => {
    if (pattern === "~DEFAULT_BRANCH") return branch === "main"; // repo default; conservative
    if (pattern === "~ALL") return true;
    // GitHub ref-name patterns: exact "refs/heads/main" or trailing-glob "refs/heads/release/*"
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return `refs/heads/${branch}`.startsWith(prefix);
    }
    return pattern === `refs/heads/${branch}`;
  });
}

function evaluateClassic(p: ClassicProtection): CheckResult[] {
  const results: CheckResult[] = [];
  const contexts = p.required_status_checks?.contexts ?? [];
  const enforcement = p.required_status_checks?.enforcement_level ?? "off";
  const { missing } = checksFromContexts(contexts);

  results.push({
    name: "classic.required_status_checks.enforcement",
    ok: enforcement === "non_admins" || enforcement === "everyone",
    observed: enforcement,
  });
  results.push({
    name: "classic.required_status_checks.contexts = all FOUR (gate,e2e,browser,scan)",
    ok: missing.length === 0,
    observed:
      contexts.length === 0
        ? "[] (none configured)"
        : `present=[${contexts.join(", ")}] missing=[${missing.join(", ")}]`,
  });
  const approvals =
    p.required_pull_request_reviews?.required_approving_review_count ?? 0;
  results.push({
    name: "classic.required_pull_request_reviews.approvals >= 1",
    ok: approvals >= 1,
    observed: String(approvals),
  });
  results.push({
    name: "classic.required_pull_request_reviews.require_code_owner_reviews",
    ok: p.required_pull_request_reviews?.require_code_owner_reviews === true,
    observed: String(
      p.required_pull_request_reviews?.require_code_owner_reviews ?? false,
    ),
  });
  results.push({
    name: "classic.allow_force_pushes disabled",
    ok: p.allow_force_pushes?.enabled === false,
    observed: String(p.allow_force_pushes?.enabled ?? "unset"),
  });
  results.push({
    name: "classic.allow_deletions disabled",
    ok: p.allow_deletions?.enabled === false,
    observed: String(p.allow_deletions?.enabled ?? "unset"),
  });
  results.push({
    name: "classic.required_conversation_resolution enabled",
    ok: p.required_conversation_resolution?.enabled === true,
    observed: String(p.required_conversation_resolution?.enabled ?? "unset"),
  });
  results.push({
    name: "classic.required_linear_history enabled",
    ok: p.required_linear_history?.enabled === true,
    observed: String(p.required_linear_history?.enabled ?? "unset"),
  });
  return results;
}

function evaluateRulesets(all: Ruleset[], branch: string): CheckResult[] {
  const results: CheckResult[] = [];
  const applicable = all.filter(
    (rs) =>
      rs.enforcement === "active" && rulesetAppliesToBranch(rs, branch),
  );
  results.push({
    name: "rulesets.at-least-one-ACTIVE-ruleset-targeting-branch",
    ok: applicable.length >= 1,
    observed:
      applicable.length === 0
        ? `none active on ${branch} (total rulesets seen: ${all.length})`
        : applicable.map((rs) => rs.name).join(", "),
  });
  if (applicable.length === 0) return results;

  const checksSeen = new Set<string>();
  let maxApprovals = 0;
  let codeOwnerReview = false;
  // R69 re-review remediation — the ruleset plane previously verified ONLY
  // required_status_checks + pull_request approvals. The four protective
  // rule types below close the same guarantees the classic plane asserts
  // (force-push off, deletion off, conversation resolution, linear history);
  // a ruleset without them would silently pass where classic would fail.
  let blocksNonFastForward = false;
  let blocksDeletion = false;
  let requiresConversationResolution = false;
  let requiresLinearHistory = false;
  for (const rs of applicable) {
    for (const rule of rs.rules ?? []) {
      if (rule.type === "required_status_checks") {
        for (const chk of rule.parameters?.required_status_checks ?? []) {
          if (chk.context) checksSeen.add(chk.context);
        }
      }
      if (rule.type === "pull_request") {
        maxApprovals = Math.max(
          maxApprovals,
          rule.parameters?.required_approving_review_count ?? 0,
        );
        codeOwnerReview =
          codeOwnerReview ||
          rule.parameters?.require_code_owner_review === true;
      }
      if (rule.type === "non_fast_forward") blocksNonFastForward = true;
      if (rule.type === "deletion") blocksDeletion = true;
      if (rule.type === "required_conversation_resolution") {
        requiresConversationResolution = true;
      }
      if (rule.type === "required_linear_history") {
        requiresLinearHistory = true;
      }
    }
  }
  const { missing } = checksFromContexts(Array.from(checksSeen));
  results.push({
    name: "rulesets.required_status_checks = all FOUR (gate,e2e,browser,scan)",
    ok: missing.length === 0 && checksSeen.size > 0,
    observed:
      checksSeen.size === 0
        ? "no required_status_checks rule found"
        : `present=[${Array.from(checksSeen).join(", ")}] missing=[${missing.join(", ")}]`,
  });
  results.push({
    name: "rulesets.pull_request approvals >= 1",
    ok: maxApprovals >= 1,
    observed: String(maxApprovals),
  });
  results.push({
    name: "rulesets.pull_request require_code_owner_review",
    ok: codeOwnerReview,
    observed: String(codeOwnerReview),
  });
  results.push({
    name: "rulesets.non_fast_forward rule present (force-push blocked)",
    ok: blocksNonFastForward,
    observed: String(blocksNonFastForward),
  });
  results.push({
    name: "rulesets.deletion rule present (branch deletion blocked)",
    ok: blocksDeletion,
    observed: String(blocksDeletion),
  });
  results.push({
    name: "rulesets.required_conversation_resolution rule present",
    ok: requiresConversationResolution,
    observed: String(requiresConversationResolution),
  });
  results.push({
    name: "rulesets.required_linear_history rule present",
    ok: requiresLinearHistory,
    observed: String(requiresLinearHistory),
  });
  return results;
}

async function ghGetOrDie(path: string, token: string, what: string): Promise<Response> {
  const res = await ghGet(path, token);
  if (res.status === 403) {
    const body = await res.text();
    // R67 LIVE DISCOVERY: on a PRIVATE repo under GitHub Free, branch
    // protection / rulesets are plan-gated — the API answers 403 with an
    // upgrade hint. Name that blocker explicitly for the operator.
    if (body.includes("Upgrade to GitHub Pro")) {
      console.error(
        "GOV-PLAN-BLOCKER(2): this repo is PRIVATE on a GitHub Free plan — branch protection / rulesets are plan-gated. OWNER action BEFORE GOV-001: upgrade the account (Pro for a personal owner; Team+ for an org) or make the repo public. No token scope change can lift this.",
      );
    } else {
      console.error(
        `GOV-VERIFY-CONFIG-ERROR(2): ${what} returned HTTP 403 (token scope or permissions) — ${body}`,
      );
    }
    process.exit(2);
  }
  return res;
}

async function main(): Promise<void> {
  const token = readToken();
  if (!token) {
    console.error(
      "GOV-VERIFY-CONFIG-ERROR(2): no token. Set GOV_VERIFY_TOKEN (preferred) or GITHUB_TOKEN / GH_TOKEN. The token is read from the environment ONLY.",
    );
    process.exit(2);
  }

  const results: CheckResult[] = [];
  let classicShape: ClassicProtection | null = null;
  let rulesets: Ruleset[] | null = null;

  // 1. classic branch protection (404 = not configured via this mechanism)
  const classicRes = await ghGetOrDie(
    `/repos/${REPO_FULL}/branches/${BRANCH}/protection`,
    token,
    "branches/{branch}/protection",
  );
  if (classicRes.status === 200) {
    classicShape = (await classicRes.json()) as ClassicProtection;
  } else if (classicRes.status === 404) {
    classicShape = null; // no classic protection — rulesets may still exist
  } else {
    console.error(
      `GOV-VERIFY-CONFIG-ERROR(2): protection endpoint returned HTTP ${classicRes.status} — ${await classicRes.text()}`,
    );
    process.exit(2);
  }

  // 2. rulesets (branch target)
  const rulesetsRes = await ghGetOrDie(`/repos/${REPO_FULL}/rulesets`, token, "rulesets");
  if (rulesetsRes.status === 200) {
    rulesets = (await rulesetsRes.json()) as Ruleset[];
  } else if (rulesetsRes.status !== 404) {
    console.error(
      `GOV-VERIFY-CONFIG-ERROR(2): rulesets endpoint returned HTTP ${rulesetsRes.status} — ${await rulesetsRes.text()}`,
    );
    process.exit(2);
  }

  if (classicShape) results.push(...evaluateClassic(classicShape));
  else
    results.push({
      name: "classic.protection-present",
      ok: false,
      observed: "404 — no classic branch protection on this branch",
    });

  if (rulesets && rulesets.length > 0)
    results.push(...evaluateRulesets(rulesets, BRANCH));
  else
    results.push({
      name: "rulesets.present",
      ok: false,
      observed: "none returned — no ruleset covers this branch either",
    });

  const failed = results.filter((r) => !r.ok);
  console.log(`GOV-VERIFY read-back for ${REPO_FULL}@${BRANCH}`);
  console.log("=".repeat(64));
  for (const r of results) {
    console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
    console.log(`         observed: ${r.observed}`);
  }
  console.log("=".repeat(64));
  if (failed.length === 0) {
    console.log("GOV-VERIFIED(0): every governance invariant holds (API truth).");
    process.exit(0);
  }
  console.log(
    `GOV-NOT-VERIFIED(1): ${failed.length} invariant(s) FAILED — do NOT flip any doc claim to "active" (truth-first).`,
  );
  process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(
    "GOV-VERIFY-CONFIG-ERROR(2):",
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
