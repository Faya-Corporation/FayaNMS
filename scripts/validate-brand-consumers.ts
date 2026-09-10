/**
 * Brand consumer validation (re-audit B0-001/B1-003/B1-004, §11 — NEW).
 * Run: `bun scripts/validate-brand-consumers.ts`
 * (package.json command "brand:validate-consumers" is wired by the orchestrator.)
 *
 * PURPOSE — prevent the exact regressions found by the re-audit:
 * a pseudo-logo (Lucide Waypoints) in brand surfaces, hand-assembled
 * mark+name identity, raw brand hex outside the source of truth, raw icon
 * URL references outside the single mask renderer, external identity URLs,
 * and re-inlined mark geometry. Scans src/**\/*.{ts,tsx} line-based
 * ("AST-light"): every file is read, comments are stripped with a
 * string/template/regex-aware lexer (so documented "FayaNMS" mentions inside
 * comments are NOT violations, while string literals are preserved for the
 * literal rules).
 *
 * RULES (FAIL ⇒ exit 1)
 *  R1 waypoints  — Lucide `Waypoints` must never appear in brand identity
 *                  surfaces: src/components/{shell,auth,brand}/** fail on any
 *                  use; src/components/views/** fail unless the file is an
 *                  explicitly allowlisted topology/data-view consumer. Files
 *                  outside these scopes that mention Waypoints produce a
 *                  WARNING (verify it is a genuine topology semantic — the
 *                  audit acceptance says: valid for a topology feature, never
 *                  for brand/loading/auth/sidebar-header/mobile-header/report
 *                  cover).
 *  R2 identity   — in src/components/{shell,auth,brand,domain}/** plus
 *                  src/app/layout.tsx and src/app/manifest.ts: FAIL on JSX
 *                  text `>FayaNMS<` / `>Network Operations Management<`, on
 *                  any bare `FayaNMS` / `Network Operations Management` token
 *                  or exact quoted literal (comments are stripped first).
 *                  Identity text must come from @/lib/brand/identity or the
 *                  src/components/brand lockup components — even brand/**
 *                  may only render FAYANMS_BRAND-derived values, never
 *                  hand-typed literals.
 *  R3 brand-hex  — FAIL anywhere in src/** on `text-[#2563EB]`,
 *                  `bg-[#2563EB]`, `border-[#2563EB]` (any case) or any
 *                  `#2563EB` / `#0891B2` occurrence (any case, quoted or
 *                  embedded) EXCEPT the SoT src/lib/brand/identity.ts and
 *                  src/lib/brand/mark-geometry.ts. In-app components must use
 *                  design tokens (text-primary); non-CSS consumers import
 *                  FAYANMS_BRAND.
 *  R4 icon-urls  — FAIL on any `/icons/fayanms/` reference in src/**
 *                  EXCEPT src/components/icons/fayanms-icon.tsx — the single
 *                  renderer that builds the CSS mask URLs. Everything else
 *                  must resolve glyphs through the registries + FayanmsIcon.
 *  R5 ext-urls   — FAIL on http(s) URLs pointing at .svg/.png/.ico in
 *                  src/app/layout.tsx and src/components/** (BRAND-001
 *                  regression guard: no external identity/favicons).
 *  R6 geometry   — FAIL on any file containing the mark's geometry
 *                  attribute signature `cx="12" cy="8" r="1.5"` (or the JSX
 *                  `cx={12} cy={8} r={1.5}` form / single-quoted variant)
 *                  outside src/lib/brand/mark-geometry.ts — catches
 *                  re-inlined mark geometry in components and metadata
 *                  routes (the mark must be consumed from mark-geometry).
 *
 * ALLOWLIST — deliberate, documented exceptions. Every entry is
 * "path → reason"; add a new sanctioned consumer ONLY with a justification
 * referencing the governing audit finding, and remove the entry when the
 * consumer migrates to the sanctioned API. Empty allowlists stay in the map
 * so the structure is obvious.
 *
 * Output: per-rule ✓/✗ lines, then "N warnings, M failures".
 * Exit 1 iff failures > 0 (warnings never affect the exit code).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

let failures = 0;
let warnings = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};
const warn = (msg: string) => {
  warnings++;
  console.warn(`⚠ ${msg}`);
};
const ok = (msg: string) => console.log(`✓ ${msg}`);
const note = (msg: string) => console.log(`ℹ ${msg}`);

/* ------------------------------------------------------------------ */
/* Deliberate allowlist — path (posix, relative to repo root) → reason. */
/* ------------------------------------------------------------------ */

type RuleId =
  | "waypointsTopology"
  | "identityLiterals"
  | "rawBrandHex"
  | "rawIconUrls"
  | "externalIdentityUrls"
  | "geometrySignature";

const APPROVED_FILES: Record<RuleId, Record<string, string>> = {
  // R1 — Waypoints as a TOPOLOGY/DATA-VIEW semantic only (re-audit B0-001
  // acceptance: "a search for Waypoints may remain valid for an actual
  // topology feature"). Each entry was verified as topology semantics:
  "waypointsTopology": {
    "src/components/views/topology-view.tsx":
      "topology view KPI/table/empty-state glyphs — network-topology semantic, not a logo (re-audit B0-001 verified)",
    "src/components/views/cmdb-view.tsx":
      "CMDB service/topology node glyphs — data-view semantic, not a logo (re-audit B0-001 verified)",
    "src/components/shell/command-palette.tsx":
      "icon for the network.topology command entry in the palette list — mirrors the sidebar topology glyph (re-audit B0-001 verified by R1-orch)",
  },
  // R2 — sanctioned identity-composition consumers. Keep EMPTY: identity
  // text must come from @/lib/brand/identity or src/components/brand lockups.
  "identityLiterals": {},
  // R3 — raw brand hex outside the SoT. Keep EMPTY: use-token-colors and the
  // incident PIR print stylesheet now seed from FAYANMS_BRAND (re-audit B1-004
  // fully closed). Any new entry here is a deliberate, documented exception.
  "rawBrandHex": {},
  // R4 — raw /icons/fayanms/ references. The ONLY sanctioned consumer is the
  // mask renderer; keep everything else out.
  "rawIconUrls": {
    "src/components/icons/fayanms-icon.tsx":
      "the single CSS-mask renderer — builds url(/icons/fayanms/<name>.svg) masks (governed architecture, ADR-brand-icon-architecture)",
  },
  // R5 — external http(s) identity URLs. Keep EMPTY (BRAND-001).
  "externalIdentityUrls": {},
  // R6 — re-inlined mark geometry. Keep EMPTY: geometry lives ONLY in
  // src/lib/brand/mark-geometry.ts (+ the raster tooling it feeds).
  "geometrySignature": {},
};

const isApproved = (rule: RuleId, relPath: string): string | undefined =>
  APPROVED_FILES[rule][relPath];

/* ------------------------------------------------------------------ */
/* Comment stripping — string/template/regex-aware mini-lexer.         */
/* Comments are removed; string/template contents are preserved so the */
/* literal rules keep working. Regex literals are recognized with the  */
/* standard "preceded by operator/keyword" heuristic so /["']/ style   */
/* regexes cannot corrupt the string state.                            */
/* ------------------------------------------------------------------ */

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await",
]);

function stripComments(src: string): string {
  const n = src.length;
  let out = "";
  let i = 0;
  const stack: string[] = []; // "'", '"', "`" or "expr" (inside ${ })
  let prevIsValue = false; // last token was identifier/number/)/]/string
  let lastWord = "";

  while (i < n) {
    const c = src[i];
    const top = stack[stack.length - 1];

    // inside a string/template literal — preserve verbatim
    if (top === "'" || top === '"' || top === "`") {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === top) {
        stack.pop();
        prevIsValue = true;
        out += c;
        i++;
        continue;
      }
      if (top === "`" && c === "$" && src[i + 1] === "{") {
        stack.push("expr");
        out += "${";
        i += 2;
        prevIsValue = false;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // code context
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue; // drop line comment (keep the newline itself)
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n"; // keep line structure
        i++;
      }
      i += 2;
      continue;
    }
    if (
      c === "/" &&
      (!prevIsValue || REGEX_KEYWORDS.has(lastWord)) &&
      src[i + 1] !== "/" &&
      src[i + 1] !== "*"
    ) {
      // regex literal — consume body + flags without interpreting strings
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const rc = src[i];
        if (rc === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (rc === "\n") break; // not a regex after all — bail safely
        out += rc;
        i++;
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) break;
      }
      while (i < n && /[a-z]/i.test(src[i])) {
        out += src[i];
        i++;
      }
      prevIsValue = true;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      stack.push(c);
      out += c;
      i++;
      continue;
    }
    if (c === "}" && top === "expr") {
      stack.pop();
      out += c;
      i++;
      prevIsValue = true; // interpolation result is a value inside the template
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord += c;
      prevIsValue = true;
    } else {
      if (c === ")" || c === "]") prevIsValue = true;
      else if (!/\s/.test(c)) prevIsValue = false;
      // keep lastWord across whitespace (e.g. `return /re/`), reset on
      // real punctuation so `foo.bar/…` cannot look like a keyword regex.
      if (c !== "\n" && !/\s/.test(c)) lastWord = "";
    }
    out += c;
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* File walk.                                                          */
/* ------------------------------------------------------------------ */

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const files = collectTsFiles(SRC).map((p) => ({
  abs: p,
  rel: p.slice(ROOT.length + 1).split("\\").join("/"),
}));

const under = (rel: string, dir: string) => rel.startsWith(`src/components/${dir}/`);
const IDENTITY_SCOPE_DIRS = ["shell", "auth", "brand", "domain"];
const WAYPOINTS_FAIL_DIRS = ["shell", "auth", "brand"];
const IDENTITY_SCOPE_FILES = ["src/app/layout.tsx", "src/app/manifest.ts"];
const SOT_FILES = new Set([
  "src/lib/brand/identity.ts",
  "src/lib/brand/mark-geometry.ts",
]);
const GEOMETRY_SOT_FILES = new Set([
  "src/lib/brand/mark-geometry.ts",
]);

interface Violation {
  file: string;
  line: number;
  rule: RuleId;
  detail: string;
}
const violations: Violation[] = [];

const lineOf = (src: string, index: number) =>
  src.slice(0, index).split("\n").length;

/* ------------------------------------------------------------------ */
/* Per-file rule evaluation.                                           */
/* ------------------------------------------------------------------ */

for (const { abs, rel } of files) {
  const raw = readFileSync(abs, "utf8");
  const code = stripComments(raw);

  const record = (
    rule: RuleId,
    index: number,
    detail: string,
    srcForLine: string
  ) => {
    const approved = isApproved(rule, rel);
    if (approved) {
      note(`${rel}:${lineOf(srcForLine, index)} — ${rule} hit allowlisted: ${approved}`);
      return;
    }
    violations.push({ file: rel, line: lineOf(srcForLine, index), rule, detail });
  };

  // ---- R1: Waypoints -------------------------------------------------
  const wp = /\bWaypoints\b/.exec(code);
  if (wp) {
    const inFailScope = WAYPOINTS_FAIL_DIRS.some((d) => under(rel, d));
    const inViews = under(rel, "views");
    if (inFailScope || inViews) {
      record("waypointsTopology", wp.index, "Waypoints used in an identity/brand surface (shell/auth/brand) or a non-allowlisted view", code);
    } else {
      warn(`${rel}:${lineOf(code, wp.index)} — Waypoints used outside the identity scope; verify it is a genuine topology semantic (re-audit B0-001)`);
    }
  }

  // ---- R2: literal identity composition ------------------------------
  const inIdentityScope =
    IDENTITY_SCOPE_DIRS.some((d) => under(rel, d)) ||
    IDENTITY_SCOPE_FILES.includes(rel);
  if (inIdentityScope) {
    const patterns: Array<[RegExp, string]> = [
      [/>\s*FayaNMS\s*</g, "JSX text \">FayaNMS<\" — use FayaNMSWordmark/FayaNMSLockup (FAYANMS_BRAND-derived)"],
      [/>\s*Network Operations Management\s*</g, "JSX text \">Network Operations Management<\" — use FAYANMS_BRAND.descriptor via the lockup API"],
      [/\bFayaNMS\b(?![_$A-Za-z0-9])/g, "bare \"FayaNMS\" identity token — render FAYANMS_BRAND.name via the lockup components"],
      [/\bNetwork Operations Management\b/g, "bare \"Network Operations Management\" descriptor — render FAYANMS_BRAND.descriptor via the lockup API"],
      [/(["'`])FayaNMS\1/g, "string literal \"FayaNMS\" — identity text must come from @/lib/brand/identity"],
      [/(["'`])Network Operations Management\1/g, "string literal \"Network Operations Management\" — identity text must come from @/lib/brand/identity"],
    ];
    for (const [re, detail] of patterns) {
      for (const m of code.matchAll(re)) {
        record("identityLiterals", m.index, detail, code);
      }
    }
  }

  // ---- R3: raw brand hex ---------------------------------------------
  if (!SOT_FILES.has(rel)) {
    const hexPatterns: Array<[RegExp, string]> = [
      [/(?:text|bg|border)-\[#2563eb\]/gi, "Tailwind arbitrary brand color — use text-primary/bg-primary tokens (B2-018)"],
      [/(?:text|bg|border)-\[#0891b2\]/gi, "Tailwind arbitrary accent color — use the semantic accent token"],
      [/text-\[#1d4ed8\]/gi, "Tailwind arbitrary hover color — use the hover token"],
      [/#2563eb/gi, "raw brand primary #2563EB — import FAYANMS_BRAND.colors.primary or use tokens"],
      [/#0891b2/gi, "raw brand accent #0891B2 — import FAYANMS_BRAND.colors.accent or use tokens"],
    ];
    for (const [re, detail] of hexPatterns) {
      for (const m of code.matchAll(re)) {
        record("rawBrandHex", m.index, detail, code);
      }
    }
  }

  // ---- R4: raw icon URL references ------------------------------------
  for (const m of code.matchAll(/\/icons\/fayanms\//g)) {
    record("rawIconUrls", m.index, "raw /icons/fayanms/ URL — resolve glyphs through the registries + FayanmsIcon (single mask renderer)", code);
  }

  // ---- R5: external identity URLs -------------------------------------
  const inExtScope = rel === "src/app/layout.tsx" || rel.startsWith("src/components/");
  if (inExtScope) {
    for (const m of code.matchAll(/https?:\/\/[^\s"'`\\)]+\.(?:svg|png|ico)/gi)) {
      record("externalIdentityUrls", m.index, `external http(s) identity URL "${m[0]}" (BRAND-001) — use file-based/local assets`, code);
    }
  }

  // ---- R6: duplicate mark geometry signatures -------------------------
  if (!GEOMETRY_SOT_FILES.has(rel)) {
    const geoPatterns: Array<[RegExp, string]> = [
      [/cx="12" cy="8" r="1\.5"/g, "re-inlined mark geometry (SVG attribute form) — consume MARK_GEOMETRY from @/lib/brand/mark-geometry"],
      [/cx='12' cy='8' r='1\.5'/g, "re-inlined mark geometry (SVG attribute form) — consume MARK_GEOMETRY from @/lib/brand/mark-geometry"],
      [/cx=\{12\} cy=\{8\} r=\{1\.5\}/g, "re-inlined mark geometry (JSX prop form) — consume MARK_GEOMETRY from @/lib/brand/mark-geometry"],
    ];
    for (const [re, detail] of geoPatterns) {
      for (const m of raw.matchAll(re)) {
        record("geometrySignature", m.index, detail, raw);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Report.                                                             */
/* ------------------------------------------------------------------ */

const byRule = new Map<RuleId, Violation[]>();
for (const v of violations) {
  const list = byRule.get(v.rule) ?? [];
  list.push(v);
  byRule.set(v.rule, list);
}

const RULE_LABELS: Record<RuleId, string> = {
  waypointsTopology: "R1 Waypoints in brand surfaces",
  identityLiterals: "R2 literal identity composition",
  rawBrandHex: "R3 raw brand hex outside SoT",
  rawIconUrls: "R4 raw /icons/fayanms/ URL references",
  externalIdentityUrls: "R5 external identity URLs",
  geometrySignature: "R6 duplicate mark geometry signatures",
};

for (const [rule, label] of Object.entries(RULE_LABELS) as Array<[RuleId, string]>) {
  const list = byRule.get(rule) ?? [];
  if (list.length === 0) ok(`${label}: clean`);
  else for (const v of list) fail(`${v.file}:${v.line} — [${label}] ${v.detail}`);
}

console.log(`\n${warnings} warnings, ${failures} failures`);
if (failures > 0) {
  console.error(`brand:validate-consumers FAILED — ${failures} issue(s)`);
  process.exit(1);
}
console.log("brand:validate-consumers passed.");
