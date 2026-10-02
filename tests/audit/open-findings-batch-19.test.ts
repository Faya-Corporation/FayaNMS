/**
 * Open-findings batch 19 — F-045 (P3, BACKLOG order):
 * demo SNMP communities / simulated collector fleet honesty.
 *
 *   History: the finding verified that the simulator templates embed demo
 *   SNMP communities (FayaRO / FayaR0c / faya-readonly) and a fake password
 *   hash, and that the "collector fleet" behind the admin collectors
 *   distribution view is a documented in-code simulation. None of it is a
 *   runtime risk — every value is invented persona content — but nothing
 *   PREVENTED a real-looking community string from appearing in ordinary
 *   runtime code where it could be mistaken for a real device credential
 *   (or leak one, the day someone pastes a live value into a fixture).
 *
 *   The closure (the BACKLOG plan's named option): a grep-guard test that
 *   scans the repo's RUNTIME CODE (src/**, mini-services/worker/**) for
 *   community-looking strings and embedded device-credential hashes, and
 *   FAILS when one appears outside the documented allowlist. The allowlist
 *   is itself pinned three ways:
 *     1. every entry must exist and actually be covered by the scan
 *        (no typo'd path silently exempting nothing);
 *     2. every entry must carry its ⚠ DEMO DATA banner in-code (no silent
 *        allowances — a file that lacked one got the banner added);
 *     3. every entry must be LOAD-BEARING (≥1 live hit today) — if the demo
 *        persona content is ever removed from a file, the suite tells you to
 *        drop the allowlist entry instead of leaving stale exemptions.
 *
 *   Deliberately OUT of scan scope (documented here for honesty):
 *     - prisma/seed.ts — the demo seed fixtures carry the same invented
 *       communities (FayaR0c/FayaRO) into the seeded Device configs; it is a
 *       non-runtime script gated behind FAYANMS_DEMO_MODE=true and refused
 *       under production NODE_ENV (startup policy + deploy docs).
 *     - tests/, docs/, *.md, .env — test fixtures and documentation, not
 *       runtime code.
 *
 *   Rig notes: pure filesystem scan anchored at import.meta.dir (cwd-
 *   independent), never follows symlinks, and skips node_modules/.next by
 *   name — the hard-linked shared node_modules (mini-services/worker has
 *   its own) is never read. The failure message names the offending
 *   file:line and the remediation (move the persona to adapters.ts or add
 *   a DEMO banner + an explicit allowlist entry).
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/* ── scan scaffolding ────────────────────────────────────────────────────── */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Runtime-code scan roots, relative to the repo root. */
const SCAN_ROOTS = ["src", join("mini-services", "worker")] as const;

/** Directory names never descended into (any depth). */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  "docs",
  "tests",
]);

/** File-name suffixes never scanned (documentation is not runtime code). */
const SKIP_FILE_SUFFIXES = [".md", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

function isEnvFile(name: string): boolean {
  return name.startsWith(".env");
}

interface ScannedFile {
  /** Repo-root-relative path (posix separators). */
  readonly path: string;
  readonly text: string;
}

function collectRuntimeFilePaths(): string[] {
  const files: string[] = [];

  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      // NEVER follow symlinks — the scan stays inside the repo tree even if
      // a link (or a hard-linked shared node_modules) points elsewhere.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(join(absoluteDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      if (isEnvFile(entry.name)) continue;

      const absoluteFile = resolve(absoluteDir, entry.name);
      if (!absoluteFile.startsWith(REPO_ROOT + sep)) continue; // inside the tree only
      files.push(relative(REPO_ROOT, absoluteFile).split("\\").join("/"));
    }
  };

  for (const root of SCAN_ROOTS) {
    const absoluteRoot = join(REPO_ROOT, root);
    if (lstatSync(absoluteRoot).isSymbolicLink()) continue;
    walk(absoluteRoot);
  }
  return files.sort();
}

function readScannedFile(path: string): ScannedFile {
  return { path, text: readFileSync(join(REPO_ROOT, path), "utf8") };
}

/* ── the guard patterns ──────────────────────────────────────────────────── */

interface GuardPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly example: string;
}

/**
 * Community-looking strings. Tuned to VALUE contexts (a word after
 * `snmp-server community`, a Junos `community X {`, a `community: "…"`
 * field holding public/private, …) so ordinary TypeScript visibility
 * keywords (`public`, `private`) and the SNMPv3 securityLevel enum member
 * named "community" never match.
 */
const COMMUNITY_PATTERNS: readonly GuardPattern[] = [
  {
    name: "snmp-server community <value>",
    pattern: /snmp-server[ \t]+community[ \t]+([A-Za-z0-9_.@#$%*!-]+)/gi,
    example: `snmp-server community FayaRO RO`,
  },
  {
    name: "snmp community <value>",
    pattern: /\bsnmp[ \t]+community[ \t]+([A-Za-z0-9_.@#$%*!-]+)/gi,
    example: `set snmp community FayaRO authorization read-only`,
  },
  {
    name: "junos hierarchical community <value> {",
    pattern: /\bcommunity[ \t]+([A-Za-z0-9_.@#$%*!-]+)[ \t]*\{/g,
    example: "community FayaRO {",
  },
  {
    name: "add community <value>",
    pattern: /\badd[ \t]+community[ \t]+([A-Za-z0-9_.@#$%*!-]+)/gi,
    example: "add community FayaRO",
  },
  {
    name: "snmpserver … community <value>",
    pattern: /\bsnmpserver\b[^;\n]*\bcommunity[ \t]+([A-Za-z0-9_.@#$%*!-]+)/gi,
    example: "set shared snmpserver profile FayaNMS version v2c community FayaRO",
  },
  {
    name: "fortios snmp-community block set name",
    pattern: /config[ \t]+system[ \t]+snmp[ \t]+community[\s\S]{0,200}?\bset[ \t]+name[ \t]+["']([^"']+)["']/gi,
    example: `config system snmp community\n    edit 1\n        set name "faya-readonly"`,
  },
  {
    name: "classic default community (public/private)",
    pattern: /\bsnmp(?:-server)?[ \t]+community[ \t]+["']?(public|private)\b/gi,
    example: `snmp-server community public`,
  },
  {
    name: "community field holding public/private",
    pattern: /\bcommunity["']?[ \t]*[:=][ \t]*["'](public|private)["']/gi,
    example: `{ community: "public" }`,
  },
];

/**
 * Embedded device-credential shapes (the finding's "fake password hash"
 * dimension — same honesty contract as the communities).
 */
const CREDENTIAL_HASH_PATTERNS: readonly GuardPattern[] = [
  {
    name: "cisco enable secret",
    pattern: /\benable[ \t]+secret[ \t]+\S/gi,
    example: "enable secret 5 $1$…",
  },
  {
    name: "embedded bcrypt hash",
    pattern: /\$2[aby]\$[0-9]{2}\$/g,
    example: "$2y$05$…",
  },
  {
    name: "embedded crypt hash",
    pattern: /\$[156]\$[0-9A-Za-z./]{4,}/g,
    example: "$6$… / $1$… / $5$…",
  },
  {
    name: "aos-cx password ciphertext",
    pattern: /\bpassword[ \t]+ciphertext[ \t]+\S+/gi,
    example: "password ciphertext AQBapQ…",
  },
];

const ALL_PATTERNS: readonly GuardPattern[] = [
  ...COMMUNITY_PATTERNS,
  ...CREDENTIAL_HASH_PATTERNS,
];

interface GuardHit {
  readonly pattern: string;
  readonly index: number;
}

function scanText(text: string, patterns: readonly GuardPattern[]): GuardHit[] {
  const hits: GuardHit[] = [];
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ pattern: name, index: match.index });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1; // zero-width safety
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/* ── the allowlist (the guard's documented boundary — pinned below) ──────── */

/**
 * The ONLY runtime files allowed to carry community-looking strings or
 * embedded credential-hash shapes. Every entry names the in-code ⚠ DEMO
 * DATA banner that documents the simulation — the banner and the exemption
 * stand or fall together (both are pinned).
 */
const ALLOWLIST: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: "mini-services/worker/adapters.ts",
    reason:
      "F-045's named boundary: the SIMULATOR plane's vendor config templates embed invented demo SNMP communities (FayaR0c / FayaRO) and a demo bcrypt password hash. Banner (added by F-045, header kept): '⚠ DEMO DATA — SIMULATED VENDOR CONFIG PERSONAS'.",
  },
  {
    file: "src/lib/ztp/templates.ts",
    reason:
      "ZTP bootstrap demo configs (Cisco/Fortinet/Juniper). Banner (in place since Phase 14-b): '⚠ DEMO DATA — SIMULATED VENDOR BOOTSTRAP CONFIGS' declares the addresses, communities (FayaRO) and credentials invented for the simulator.",
  },
  {
    file: "mini-services/worker/harness/ios-sshd.ts",
    reason:
      "LIVE_SSH certification-harness Cisco IOS persona: demo community faya-readonly + demo enable-secret crypt hash. Banner (added by F-045): '⚠ DEMO DATA — SIMULATED DEVICE PERSONA'.",
  },
  {
    file: "mini-services/worker/harness/aoscx-sshd.ts",
    reason:
      "LIVE_SSH certification-harness AOS-CX persona: demo community faya-readonly + demo password ciphertext. Banner (added by F-045): '⚠ DEMO DATA — SIMULATED DEVICE PERSONA'.",
  },
  {
    file: "mini-services/worker/harness/fortios-sshd.ts",
    reason:
      "LIVE_SSH certification-harness FortiOS persona: demo SNMP community name faya-readonly. Banner (added by F-045): '⚠ DEMO DATA — SIMULATED DEVICE PERSONA'.",
  },
  {
    file: "mini-services/worker/harness/panos-sshd.ts",
    reason:
      "LIVE_SSH certification-harness PAN-OS persona: demo community FayaRO. Banner (added by F-045): '⚠ DEMO DATA — SIMULATED DEVICE PERSONA'.",
  },
  {
    file: "mini-services/worker/harness/junos-sshd.ts",
    reason:
      "LIVE_SSH certification-harness Junos persona: demo community FayaRO. Banner (added by F-045): '⚠ DEMO DATA — SIMULATED DEVICE PERSONA'.",
  },
];

const REMEDIATION =
  "F-045 remediation: move the demo persona into mini-services/worker/adapters.ts " +
  "(the documented simulator boundary), or add a ⚠ DEMO DATA banner to the file " +
  "documenting the values as invented simulation content and add an explicit, " +
  "justified allowlist entry to ALLOWLIST in tests/audit/open-findings-batch-19.test.ts.";

function scanAllRuntimeFiles(): { file: string; line: number; pattern: string }[] {
  const violations: { file: string; line: number; pattern: string }[] = [];
  const allowlisted = new Set(ALLOWLIST.map((entry) => entry.file));

  for (const path of collectRuntimeFilePaths()) {
    const { text } = readScannedFile(path);
    for (const hit of scanText(text, ALL_PATTERNS)) {
      if (allowlisted.has(path)) continue;
      violations.push({ file: path, line: lineOf(text, hit.index), pattern: hit.pattern });
    }
  }
  return violations;
}

/* ── scanner hygiene: scope, exclusions, tuning (no false positives) ─────── */

describe("F-045 scanner scope (runtime code only, repo tree only)", () => {
  test("scans only src/** and mini-services/worker/** and never enters excluded dirs", () => {
    const files = collectRuntimeFilePaths();
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      expect(
        file.startsWith("src/") || file.startsWith("mini-services/worker/")
      ).toBe(true);
      expect(file.includes("node_modules")).toBe(false);
      expect(file.includes("/.next")).toBe(false);
      expect(file.endsWith(".md")).toBe(false);
    }
  });

  test("the worker's own (hard-linked, shared) node_modules is skipped, not read", () => {
    const workerNodeModules = join(REPO_ROOT, "mini-services/worker/node_modules");
    expect(existsSync(workerNodeModules)).toBe(true);
    expect(
      collectRuntimeFilePaths().some((file) => file.includes("node_modules"))
    ).toBe(false);
  });

  test("symlinks are never followed (scan stays inside the repo tree)", () => {
    // The walker skips symlinked entries outright; pin the contract by
    // re-walking with a planted symlink INSIDE a scan root and proving the
    // linked directory is not descended into.
    const planted = join(REPO_ROOT, "src/__f045_planted_link__");
    const target = join(REPO_ROOT, "mini-services/worker/harness");
    rmSync(planted, { recursive: true, force: true }); // clear any stale plant
    try {
      expect(existsSync(target)).toBe(true);
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, "keepme.ts"), "export const keep = 1;\n");
      symlinkSync(target, join(planted, "link"), "dir");

      const files = collectRuntimeFilePaths();
      expect(files.some((file) => file.includes("__f045_planted_link__/keepme.ts"))).toBe(true);
      // The symlinked dir's REAL files must not appear under the link path.
      expect(
        files.some((file) => file.includes("__f045_planted_link__/link"))
      ).toBe(false);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
    // Cleanup proven (the planted tree cannot poison later scans).
    expect(existsSync(planted)).toBe(false);
  });
});

describe("F-045 pattern tuning (community shapes flagged, ordinary code clean)", () => {
  test("every allowlist-worthy demo shape IS caught", () => {
    const flagged = [
      `snmp-server community FayaRO RO`,
      `snmp-server community FayaR0c RO 80`,
      `snmp-server community faya-readonly`,
      `set snmp community FayaRO authorization read-only`,
      `set service snmp community FayaRO authorization read-only`,
      `community FayaRO {`,
      `add community FayaRO`,
      `set shared snmpserver profile FayaNMS version v2c community FayaRO`,
      `config system snmp community\n    edit 1\n        set name "faya-readonly"`,
      `snmp-server community public`,
      `{ community: "private" }`,
      `enable secret 5 $1$mERr$hx9mF6oP4mB9uJYZ0jzYV0`,
      `password manager plaintext-hash $2y$05$FayaNMSDemoHashOnlyNotReal$`,
      `set system root-authentication encrypted-password "$6$FayaNMS-Demo$"`,
      `user netadmin group administrators password ciphertext AQBapQFayaNMSGh0c3Ryb25n`,
    ];
    for (const line of flagged) {
      expect(scanText(line, ALL_PATTERNS).length).toBeGreaterThan(0);
    }
  });

  test("ordinary code using the words public/private/community is NOT flagged", () => {
    const clean = [
      `export class Foo { private readonly x = 1; public y = 2; }`,
      `public static async handler(): Promise<void> {}`,
      `securityLevel: z.enum(["authPriv", "community", "unknown"]).optional(),`,
      `export type SnmpSecurityLevel = "authPriv" | "community" | "unknown";`,
      `  "community",`, // secret-keyword lists (config normalization)
      `// static / firewall policy / snmp community).`, // prose comment, no value
      `const isPublic = status === "public-record";`,
      `interface Site { community: string; region: string; }`,
    ];
    for (const line of clean) {
      expect(scanText(line, ALL_PATTERNS)).toEqual([]);
    }
  });

  test("the classic-community patterns fire ONLY inside a community context", () => {
    // A bare "public"/"private" keyword with no snmp/community context must stay clean…
    expect(scanText("private key; public key;", ALL_PATTERNS)).toEqual([]);
    // …while the same words as community VALUES are caught.
    expect(
      scanText("snmp community private", ALL_PATTERNS).length
    ).toBeGreaterThan(0);
  });
});

/* ── the guard itself ────────────────────────────────────────────────────── */

describe("F-045 grep-guard: no community-looking strings outside the allowlist", () => {
  test("runtime code is clean outside mini-services/worker/adapters.ts (+ documented personas)", () => {
    const violations = scanAllRuntimeFiles();
    const rendered = violations.map(
      (violation) =>
        `${violation.file}:${violation.line} — ${violation.pattern} — ${REMEDIATION}`
    );
    expect(rendered).toEqual([]);
  });

  test("the guard demonstrably fires (a planted violation fails with file + remediation)", () => {
    // Self-test of the guard machinery: a community-looking string planted
    // into a synthetic file path produces a violation naming the file.
    const text = `const cfg = "snmp-server community NotARealFleetValue";`;
    const hits = scanText(text, ALL_PATTERNS);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pattern).toContain("snmp-server community");
    const synthetic = "src/lib/planted-f045-demo.ts";
    expect(
      `${synthetic}:${lineOf(text, hits[0]!.index)} — ${hits[0]!.pattern} — ${REMEDIATION}`
    ).toContain("move the demo persona into mini-services/worker/adapters.ts");
  });
});

/* ── the allowlist pins itself ───────────────────────────────────────────── */

describe("F-045 allowlist integrity (no silent, stale, or dead exemptions)", () => {
  test("every allowlist entry exists, is inside the scan roots, and is actually scanned", () => {
    const scanned = new Set(collectRuntimeFilePaths());
    for (const entry of ALLOWLIST) {
      expect(
        entry.file.startsWith("src/") || entry.file.startsWith("mini-services/worker/")
      ).toBe(true);
      expect(existsSync(join(REPO_ROOT, entry.file))).toBe(true);
      // A typo'd allowlist path would silently exempt nothing — pin coverage.
      expect(scanned.has(entry.file)).toBe(true);
    }
    expect(ALLOWLIST.length).toBe(7);
  });

  test("every allowlist entry carries its ⚠ DEMO DATA banner in-code", () => {
    for (const entry of ALLOWLIST) {
      const { text } = readScannedFile(entry.file);
      expect(text).toContain("DEMO DATA");
    }
  });

  test("every allowlist entry is load-bearing (≥1 live hit — drop stale exemptions)", () => {
    for (const entry of ALLOWLIST) {
      const { text } = readScannedFile(entry.file);
      const hits = scanText(text, ALL_PATTERNS);
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});

/* ── demo honesty documentation: in-code banners, API, UI, docs ──────────── */

describe("F-045 demo honesty documentation (simulated surfaces stay labeled)", () => {
  const distribution = readFileSync(
    join(REPO_ROOT, "src/lib/collectors/distribution.ts"),
    "utf8"
  );
  const distributionRoute = readFileSync(
    join(REPO_ROOT, "src/app/api/v1/admin/collectors/distribution/route.ts"),
    "utf8"
  );
  const collectorsView = readFileSync(
    join(REPO_ROOT, "src/components/views/admin-collectors-view.tsx"),
    "utf8"
  );
  const enMessages = readFileSync(join(REPO_ROOT, "messages/en.json"), "utf8");
  const ztp = readFileSync(join(REPO_ROOT, "src/lib/ztp/templates.ts"), "utf8");
  const adapters = readFileSync(
    join(REPO_ROOT, "mini-services/worker/adapters.ts"),
    "utf8"
  );
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const secretsRunbook = readFileSync(
    join(REPO_ROOT, "docs/runbooks/secrets-management.md"),
    "utf8"
  );

  test("the simulated collector fleet (distribution.ts) keeps its ⚠ DEMO DATA banner", () => {
    expect(distribution).toContain("⚠ DEMO DATA — DOCUMENTED SIMULATED AGENT FLEET");
    expect(distribution).toContain("MUST NOT be used for real rollout planning");
    expect(distribution).toContain("guarded SIMULATION (staged audit rows only");
    // …and the banner's provenance claim stays true (the seed site codes).
    expect(distribution).toContain("prisma/seed.ts");
  });

  test("the collectors distribution API surfaces the simulation to callers", () => {
    expect(distributionRoute).toContain("DOCUMENTED SIMULATION");
    expect(distributionRoute).toContain("simulated: true");
    expect(distributionRoute).toContain("Agent fleet is a documented simulation");
  });

  test("the admin collectors view renders the demo note above the fleet section", () => {
    expect(collectorsView).toContain("DOCUMENTED SIMULATION");
    expect(collectorsView).toContain('t("demoNote")');
    // The English string the operator actually reads:
    expect(enMessages).toContain(
      "Simulated agent fleet — assignments are computed deterministically over real devices; applying a plan writes staged audit rows only."
    );
  });

  test("the simulator adapter boundary keeps both its header story and the DEMO banner", () => {
    expect(adapters).toContain("This module is the SIMULATOR plane");
    expect(adapters).toContain("⚠ DEMO DATA — SIMULATED VENDOR CONFIG PERSONAS");
    expect(adapters).toContain("pinned by");
  });

  test("the ZTP demo templates keep their banner (communities/credentials invented)", () => {
    expect(ztp).toContain("⚠ DEMO DATA — SIMULATED VENDOR BOOTSTRAP CONFIGS");
    expect(ztp).toContain("do NOT apply them to real hardware");
  });

  test("every certification-harness persona keeps its DEMO banner + simulation story", () => {
    for (const persona of [
      "mini-services/worker/harness/ios-sshd.ts",
      "mini-services/worker/harness/aoscx-sshd.ts",
      "mini-services/worker/harness/fortios-sshd.ts",
      "mini-services/worker/harness/panos-sshd.ts",
      "mini-services/worker/harness/junos-sshd.ts",
    ]) {
      const text = readFileSync(join(REPO_ROOT, persona), "utf8");
      expect(text).toContain("⚠ DEMO DATA — SIMULATED DEVICE PERSONA");
      // The honest-status sentence the harness headers already carried
      // (line-wrap tolerant: ios wraps between "text" and "is simulated"):
      expect(text).toMatch(/CLI text (is )?simulated/);
    }
  });

  test("README's demo-simulation semantics covers the fleet AND the invented communities", () => {
    expect(readme).toContain("Demo-simulation semantics");
    expect(readme).toContain("collector fleets");
    expect(readme).toContain("tests/audit/open-findings-batch-19.test.ts");
  });

  test("the secrets runbook carves the banner-labeled demo personas out of the no-communities rule", () => {
    expect(secretsRunbook).toContain("No PAT, OCI API key, SSH private key, database password, SNMP community");
    expect(secretsRunbook).toContain("invented");
    expect(secretsRunbook).toContain("not real secrets");
    expect(secretsRunbook).toContain("tests/audit/open-findings-batch-19.test.ts");
  });
});
