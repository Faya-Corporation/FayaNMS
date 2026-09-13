import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Identity composition contracts across the shell/auth/social surfaces
 * (task R3-a) — source-contract tests in the repo convention
 * (readFileSync + assertions; no DOM renderer exists by design).
 *
 * Covers re-audit findings:
 *  - B0-001 — the loading screen and mobile drawer carry the CANONICAL brand
 *    (FayaNMSMark / FayaNMSLockup), never a pseudo-brand glyph; Waypoints is
 *    topology semantics only, never identity chrome;
 *  - B0-002 — the active CI gate (.github/workflows/ci.yml) exists and runs
 *    the brand validators + the bun test suite;
 *  - B1-003 — identity is composed ONLY through FayaNMSLockup (no literal
 *    "FayaNMS" / "Network Operations Management" text nodes in shell/auth);
 *  - B1-005/B1-006 — mark-geometry.ts is the single geometry source and ONE
 *    shared SocialCard feeds both OG and Twitter images (B2-024 thin
 *    wrappers);
 *  - B1-007 — no gradient blending on brand surfaces (solid 90/10 rule);
 *  - B1-013 — the repository README shows the static brand-blue master via
 *    an <img> (SVG-in-img cannot follow currentColor), not the currentColor
 *    master;
 *  - B1-014 — the favicon micro-mark (src/app/icon.svg) contains no
 *    connectors (<line>) — the deliberate small-size derivative;
 *  - B2-018 — no raw brand hex in shell/auth components (tokens only);
 *  - B2-027 — dedicated automated brand tests exist in-repo.
 *
 * HONESTY NOTE (B2-027 visual regression): the re-audit's visual matrix
 * (breakpoints × states × themes × directions × zoom) is ORCHESTRATED
 * SEPARATELY (browser runs are not part of this bun test suite). What this
 * file CAN and does pin is that the lockup component exposes the full
 * variant surface and its docstring maps every identity surface to a
 * variant — the source-level precondition for that visual matrix.
 */

const ROOT = join(import.meta.dir, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8");
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!statSync(dir).isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** The mark's top-node signature in every legal syntax (object / SVG attr / JSX). */
const GEOMETRY_SIGNATURE =
  /cx\s*[:=]\s*\{?"?12"?\}?\s*[,:]?\s*cy\s*[:=]\s*\{?"?8"?\}?\s*[,:]?\s*r\s*[:=]\s*\{?"?1\.5"?\}?/;

describe("app-shell — canonical identity on loading + mobile drawer (B0-001/B1-003)", () => {
  const source = read("src", "components", "shell", "app-shell.tsx");

  test("Waypoints is NOT imported from lucide-react (topology-only glyph)", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bWaypoints\b[^}]*\}\s*from\s*["']lucide-react["']/
    );
    expect(source).not.toContain("<Waypoints");
  });

  test("mobile drawer title uses the canonical tiled lockup", () => {
    expect(source).toContain(`FayaNMSLockup variant="tiled"`);
  });

  test("loading state uses the canonical brand mark at lg/brand", () => {
    expect(source).toContain(`FayaNMSMark size="lg" tone="brand"`);
  });

  test("identity is imported from the brand module", () => {
    expect(source).toContain(`from "@/components/brand"`);
  });
});

describe("app-sidebar — lockup only, no hand-composed identity (B1-003)", () => {
  const source = read("src", "components", "shell", "app-sidebar.tsx");

  test("composes identity through FayaNMSLockup", () => {
    expect(source).toContain("FayaNMSLockup");
  });

  test("does not import FayaNMSMark nor render a literal >FayaNMS< text node", () => {
    expect(source).not.toContain("FayaNMSMark");
    expect(source).not.toContain(">FayaNMS<");
  });
});

describe("sign-in-gate — lockup only, no brand literals (B1-003)", () => {
  const source = read("src", "components", "auth", "sign-in-gate.tsx");

  test("composes identity through FayaNMSLockup", () => {
    expect(source).toContain("FayaNMSLockup");
  });

  test("no literal descriptor or name text nodes", () => {
    expect(source).not.toContain("Network Operations Management");
    expect(source).not.toContain(">FayaNMS<");
  });
});

describe("shell/auth — no raw brand hex classes (B2-018)", () => {
  test("no file under src/components/{shell,auth} contains text-[#2563EB]", () => {
    const files = [
      ...walk(join(ROOT, "src", "components", "shell"), [".ts", ".tsx"]),
      ...walk(join(ROOT, "src", "components", "auth"), [".ts", ".tsx"]),
    ];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => /text-\[#2563EB\]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("social artwork — one shared composition, no gradient (B1-006/B1-007/B2-024)", () => {
  test.each([
    ["src/app/opengraph-image.tsx"],
    ["src/app/twitter-image.tsx"],
  ])("%s is a thin SocialCard wrapper with no inline geometry or gradient", (file) => {
    const source = read(...file.split("/"));
    expect(source).toContain("SocialCard");
    expect(source).not.toContain("<circle");
    expect(source).not.toContain("linear-gradient");
  });

  test("social-card.tsx consumes the shared geometry and blends nothing", () => {
    const source = read("src", "components", "brand", "social-card.tsx");
    expect(source).toContain("MARK_GEOMETRY");
    expect(source).not.toContain("linear-gradient");
  });
});

describe("mark-geometry.ts is the ONLY geometry source (B1-005)", () => {
  test("the top-node signature (12, 8, 1.5) appears in no other src/ file", () => {
    const files = walk(join(ROOT, "src"), [".ts", ".tsx", ".svg"]);
    const matches = files.filter((f) => GEOMETRY_SIGNATURE.test(readFileSync(f, "utf8")));
    expect(matches).toEqual([join(ROOT, "src", "lib", "brand", "mark-geometry.ts")]);
  });
});

describe("layout metadata consumes the identity helpers (B1-004)", () => {
  const source = read("src", "app", "layout.tsx");

  test("title/template/themeColor come from the brand module", () => {
    expect(source).toContain("BRAND_TITLE");
    expect(source).toContain("BRAND_TITLE_TEMPLATE");
    expect(source).toContain("BRAND_THEME_COLOR");
  });

  test("no hand-written canonical title string", () => {
    expect(source).not.toContain("FayaNMS — Network Operations Management");
  });
});

describe("favicon micro-mark policy (B1-014)", () => {
  test("src/app/icon.svg has no <line> connectors and paints brand primary", () => {
    const source = read("src", "app", "icon.svg");
    expect(source).not.toContain("<line");
    expect(source).toContain(`stroke="#2563EB"`);
  });
});

describe("CI gate wires the brand governance (B0-002)", () => {
  // The gate definition lives at .github/workflows/ci.yml and IS live on
  // GitHub Actions since 2026-09-10 (task R8 pushed it; task R9 set gate+scan
  // as required status checks on the protected main branch). The skipIf gate
  // below is retained so fresh checkouts without the file still report a
  // loud, explicit skip instead of a confusing pass-over.
  const workflowPath = join(ROOT, ".github", "workflows", "ci.yml");
  const workflowLanded = existsSync(workflowPath);
  test.skipIf(!workflowLanded)(
    ".github/workflows/ci.yml exists and runs tests + all brand validators",
    () => {
      expect(workflowLanded).toBe(true);
      const source = readFileSync(workflowPath, "utf8");
      expect(source).toContain("brand:validate-icons");
      expect(source).toContain("brand:validate");
      expect(source).toContain("validate-brand-consumers");
      expect(source).toContain("bun test tests/");
    },
  );
  test("CI activation status stays honest (B0-002; corrected 2026-09-13 — OPS-001)", () => {
    // History: the activation window closed 2026-09-10 (tasks R8 + R9) —
    // workflow pushed, gate + scan green on main, both set as required checks
    // on the protected branch. CORRECTION (external ULTRA audit P1-017,
    // verified by API read-back on 2026-09-13): the live GitHub state is
    // `main.protected = false` — push-triggered CI is NOT pre-merge
    // enforcement today. Docs must assert the corrected state (OPS-001),
    // never the stale "protected" claim.
    const social = readFileSync(
      join(ROOT, "docs", "brand", "SOCIAL-REPOSITORY.md"),
      "utf8",
    );
    // The historical activation record stays, but a dated correction banner
    // must lead it and name the live state + the backlog item.
    expect(social).toMatch(/ACTIVATION COMPLETE/);
    expect(social).toMatch(/2026-09-10/);
    expect(social).toMatch(/required status checks/i);
    expect(social).toMatch(/STATUS CORRECTION — 2026-09-13/);
    expect(social).toMatch(/main\.protected = false/);
    expect(social).toMatch(/OPS-001/);
    // The README must carry the factual CI badge (badge policy §4) and the
    // honest-status section must carry the same corrected branch-protection
    // truth (CI runs on every push; protection currently OFF).
    const readme = read("README.md");
    expect(readme).toContain(
      "img.shields.io/github/actions/workflow/status/fayafatehi/FayaNMS/ci.yml",
    );
    expect(readme).toMatch(/BRANCH PROTECTION — CORRECTED 2026-09-13/);
    expect(readme).toMatch(/main\.protected = false/);
    expect(readme).not.toMatch(/`main` is protected/);
    // GOV-R9-001 / R10-004 — admin-bypass verdict wording: the user-facing
    // README must never claim "universally non-bypassable" while
    // enforce_admins=false, and the governance doc must carry the accurate
    // verdict ("CI-enforced and PR-protected for normal contributors, with an
    // explicit owner/admin bypass retained").
    expect(readme).not.toMatch(/universally non-bypassable/i);
    expect(social).toMatch(/explicit owner\/admin bypass retained/);
  });
});

describe("repository README shows the static brand-blue master (B1-013)", () => {
  test("README references public/brand/fayanms-mark-brand.svg, not the currentColor master", () => {
    const source = read("README.md");
    expect(source).toContain("public/brand/fayanms-mark-brand.svg");
    expect(source).not.toContain(`src="public/brand/fayanms-mark.svg"`);
  });
});

describe("lockup covers every identity surface (B1-003 / B2-027)", () => {
  const source = read("src", "components", "brand", "fayanms-lockup.tsx");

  test("all four governed variants are part of the component API", () => {
    expect(source).toContain(`"compact" | "horizontal" | "stacked" | "tiled"`);
    // compact/tiled/stacked branch explicitly; horizontal is the default
    // fall-through branch (default parameter + final return).
    for (const variant of ["compact", "tiled", "stacked"]) {
      expect(source).toContain(`variant === "${variant}"`);
    }
    expect(source).toContain(`variant = "horizontal"`);
  });

  test("the documented surface→variant map lists desktop sidebar, mobile drawer and sign-in", () => {
    // Docstring is the contract consumed by the separately-orchestrated
    // browser visual regression matrix (B2-027): desktop sidebar (tiled),
    // mobile drawer (tiled), sign-in (tiled lg), collapsed sidebar (compact).
    expect(source).toContain("collapsed sidebar");
    expect(source).toContain("desktop sidebar, mobile drawer, sign-in");
  });
});
