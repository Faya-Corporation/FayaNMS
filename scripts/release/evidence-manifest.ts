#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type BranchProtectionReadback = {
  protected: boolean;
  observedAt: string;
  source: string;
};

type ExternalEvidence = {
  pullRequestNumber: number | null;
  ciRunIds: string[];
  imageDigests: Record<string, string>;
  branchProtectionReadback: BranchProtectionReadback | null;
  externalBlockers: string[] | null;
};

type CertificationTierSummary = {
  matrix: string;
  vendorCount: number;
  highestRecordedTier: string;
  vendorTopTiers: Record<string, string>;
};

export type EvidenceManifest = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    sha: string;
    branch: string | null;
    worktreeClean: boolean;
  };
  pullRequestNumber: number | null;
  ciRunIds: string[];
  imageDigests: Record<string, string>;
  migrationHead: string | null;
  sbomArtifactHash: string | null;
  certificationTierSummary: CertificationTierSummary;
  branchProtectionReadback: BranchProtectionReadback | null;
  externalBlockers: string[] | null;
};

type BuildEvidenceOptions = {
  repoRoot: string;
  generatedAt?: string;
  sbomPath?: string;
  externalEvidence?: unknown;
};

const EVIDENCE_KEYS = new Set([
  "pullRequestNumber",
  "ciRunIds",
  "imageDigests",
  "branchProtectionReadback",
  "externalBlockers",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} has unexpected field: ${unexpected}`);
}

export function parseExternalEvidence(value: unknown = {}): ExternalEvidence {
  if (!isRecord(value)) throw new Error("External evidence must be a JSON object");
  assertOnlyKeys(value, EVIDENCE_KEYS, "External evidence");

  const pullRequestNumber = value.pullRequestNumber ?? null;
  if (pullRequestNumber !== null && (!Number.isSafeInteger(pullRequestNumber) || (pullRequestNumber as number) < 1)) {
    throw new Error("pullRequestNumber must be a positive integer or null");
  }

  const ciRunIds = value.ciRunIds ?? [];
  if (!Array.isArray(ciRunIds) || ciRunIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) {
    throw new Error("ciRunIds must contain only numeric run ID strings");
  }

  const imageDigests = value.imageDigests ?? {};
  if (!isRecord(imageDigests)) throw new Error("imageDigests must be an object of sha256 digests");
  for (const [name, digest] of Object.entries(imageDigests)) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name) || typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
      throw new Error(`imageDigests.${name} must be a sha256 digest`);
    }
  }

  const rawProtection = value.branchProtectionReadback ?? null;
  let branchProtectionReadback: BranchProtectionReadback | null = null;
  if (rawProtection !== null) {
    if (!isRecord(rawProtection)) throw new Error("branchProtectionReadback must be an object or null");
    assertOnlyKeys(rawProtection, new Set(["protected", "observedAt", "source"]), "branchProtectionReadback");
    if (
      typeof rawProtection.protected !== "boolean" ||
      typeof rawProtection.observedAt !== "string" ||
      Number.isNaN(Date.parse(rawProtection.observedAt)) ||
      typeof rawProtection.source !== "string" ||
      rawProtection.source.trim().length === 0
    ) {
      throw new Error("branchProtectionReadback requires protected, valid observedAt and source");
    }
    branchProtectionReadback = {
      protected: rawProtection.protected,
      observedAt: rawProtection.observedAt,
      source: rawProtection.source.trim(),
    };
  }

  const externalBlockers = value.externalBlockers === undefined ? null : value.externalBlockers;
  if (externalBlockers !== null && (!Array.isArray(externalBlockers) || externalBlockers.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error("externalBlockers must contain non-empty strings");
  }

  return {
    pullRequestNumber: pullRequestNumber as number | null,
    ciRunIds: [...new Set(ciRunIds as string[])],
    imageDigests: Object.fromEntries(
      Object.entries(imageDigests).map(([name, digest]) => [name, (digest as string).toLowerCase()]),
    ),
    branchProtectionReadback,
    externalBlockers: externalBlockers === null
      ? null
      : [...new Set((externalBlockers as string[]).map((item) => item.trim()))],
  };
}

function collectSource(repoRoot: string): EvidenceManifest["source"] {
  const runGit = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const sha = runGit(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Could not resolve a full source commit SHA");
  const branch = runGit(["branch", "--show-current"]) || null;
  const worktreeClean = runGit(["status", "--porcelain", "--untracked-files=all"]) === "";
  return { sha, branch, worktreeClean };
}

function collectMigrationHead(repoRoot: string): string | null {
  const migrationsPath = resolve(repoRoot, "prisma", "migrations");
  const migrations = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_.+/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return migrations.at(-1) ?? null;
}

function collectCertificationSummary(repoRoot: string): CertificationTierSummary {
  const matrixPath = "docs/certification/MATRIX.md";
  const contents = readFileSync(resolve(repoRoot, matrixPath), "utf8");
  const lines = contents.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\|\s*Vendor\s*\|/.test(line));
  if (headerIndex < 0) throw new Error(`Could not locate the vendor table in ${matrixPath}`);

  const vendorTopTiers: Record<string, string> = {};
  for (const line of lines.slice(headerIndex + 1)) {
    if (/^Legend:/i.test(line.trim())) break;
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || !cells[0] || /^[-:]+$/.test(cells[0]) || cells[0] === "Vendor") continue;
    const tier = cells.at(-1)?.match(/\bT[0-5]\b/)?.[0] ?? "UNRECORDED";
    vendorTopTiers[cells[0]] = tier;
  }

  const rank = (tier: string) => (tier === "UNRECORDED" ? -1 : Number(tier.slice(1)));
  const highestRecordedTier = Object.values(vendorTopTiers)
    .filter((tier) => tier !== "UNRECORDED")
    .sort((a, b) => rank(b) - rank(a))[0] ?? "NONE";
  return { matrix: matrixPath, vendorCount: Object.keys(vendorTopTiers).length, highestRecordedTier, vendorTopTiers };
}

export function buildEvidenceManifest(options: BuildEvidenceOptions): EvidenceManifest {
  const repoRoot = resolve(options.repoRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("generatedAt must be a valid date-time");
  const external = parseExternalEvidence(options.externalEvidence);
  const sbomArtifactHash = options.sbomPath
    ? `sha256:${createHash("sha256").update(readFileSync(options.sbomPath)).digest("hex")}`
    : null;

  return {
    schemaVersion: 1,
    generatedAt,
    source: collectSource(repoRoot),
    pullRequestNumber: external.pullRequestNumber,
    ciRunIds: external.ciRunIds,
    imageDigests: external.imageDigests,
    migrationHead: collectMigrationHead(repoRoot),
    sbomArtifactHash,
    certificationTierSummary: collectCertificationSummary(repoRoot),
    branchProtectionReadback: external.branchProtectionReadback,
    externalBlockers: external.externalBlockers,
  };
}

export function writeEvidenceManifest(outputPath: string, manifest: EvidenceManifest): void {
  const file = resolve(outputPath);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function parseArgs(argv: string[]): { evidencePath?: string; sbomPath?: string; outputPath?: string } {
  const options: { evidencePath?: string; sbomPath?: string; outputPath?: string } = {};
  const flags: Record<string, keyof typeof options> = {
    "--evidence": "evidencePath",
    "--sbom": "sbomPath",
    "--out": "outputPath",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: bun scripts/release/evidence-manifest.ts [--evidence evidence.json] [--sbom sbom.json] [--out artifact.json]");
      process.exit(0);
    }
    const key = flags[flag];
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (options[key]) throw new Error(`${flag} may only be supplied once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function cli(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidencePath = options.evidencePath ? resolve(options.evidencePath) : undefined;
    const externalEvidence = evidencePath
      ? JSON.parse(readFileSync(evidencePath, "utf8")) as unknown
      : {};
    const manifest = buildEvidenceManifest({
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      externalEvidence,
      sbomPath: options.sbomPath ? resolve(options.sbomPath) : undefined,
    });
    if (options.outputPath && options.outputPath !== "-") {
      writeEvidenceManifest(resolve(options.outputPath), manifest);
      console.error(`Evidence manifest written: ${options.outputPath}`);
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`[evidence-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
