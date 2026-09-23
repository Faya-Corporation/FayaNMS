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

type SbomArtifactEvidence = {
  artifactId: number;
  workflowRunId: string;
  sourceSha: string;
  sha256: string;
  source: string;
};

type LocalDockerServiceEvidence = {
  imageId: string;
  status: "healthy" | "unhealthy" | "starting" | "unknown";
  sourceRevision?: string | null;
};

type LocalDockerDeploymentEvidence = {
  observedAt: string;
  sourceSha: string;
  composeConfigValidated: boolean;
  services: {
    app: LocalDockerServiceEvidence;
    worker: LocalDockerServiceEvidence;
    postgres: LocalDockerServiceEvidence;
  };
  applicationProbe: { path: string; statusCode: number };
  database: { migrationCount: number; migrationHead: string | null; volumeName: string };
};

type ExternalEvidence = {
  pullRequestNumber: number | null;
  ciRunIds: string[];
  imageDigests: Record<string, string>;
  sbomArtifact: SbomArtifactEvidence | null;
  localDockerDeployment: LocalDockerDeploymentEvidence | null;
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
  localDockerDeployment: LocalDockerDeploymentEvidence | null;
  migrationHead: string | null;
  sbomArtifactHash: string | null;
  sbomArtifactProvenance: Omit<SbomArtifactEvidence, "sha256"> | null;
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
  "sbomArtifact",
  "localDockerDeployment",
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

  const rawSbomArtifact = value.sbomArtifact ?? null;
  let sbomArtifact: SbomArtifactEvidence | null = null;
  if (rawSbomArtifact !== null) {
    if (!isRecord(rawSbomArtifact)) throw new Error("sbomArtifact must be an object or null");
    assertOnlyKeys(
      rawSbomArtifact,
      new Set(["artifactId", "workflowRunId", "sourceSha", "sha256", "source"]),
      "sbomArtifact",
    );
    if (
      !Number.isSafeInteger(rawSbomArtifact.artifactId) || (rawSbomArtifact.artifactId as number) < 1 ||
      typeof rawSbomArtifact.workflowRunId !== "string" || !/^\d+$/.test(rawSbomArtifact.workflowRunId) ||
      typeof rawSbomArtifact.sourceSha !== "string" || !/^[a-f0-9]{40}$/i.test(rawSbomArtifact.sourceSha) ||
      typeof rawSbomArtifact.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(rawSbomArtifact.sha256) ||
      typeof rawSbomArtifact.source !== "string"
    ) {
      throw new Error(
        "sbomArtifact requires a positive artifactId, numeric workflowRunId, full sourceSha, sha256 digest and HTTPS source",
      );
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(rawSbomArtifact.source);
    } catch {
      throw new Error("sbomArtifact requires a valid HTTPS source");
    }
    if (
      sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password ||
      sourceUrl.search || sourceUrl.hash
    ) {
      throw new Error("sbomArtifact source must be an HTTPS URL without credentials, query parameters or fragments");
    }
    sbomArtifact = {
      artifactId: rawSbomArtifact.artifactId as number,
      workflowRunId: rawSbomArtifact.workflowRunId,
      sourceSha: rawSbomArtifact.sourceSha.toLowerCase(),
      sha256: rawSbomArtifact.sha256.toLowerCase(),
      source: sourceUrl.toString(),
    };
  }

  const rawLocalDocker = value.localDockerDeployment ?? null;
  let localDockerDeployment: LocalDockerDeploymentEvidence | null = null;
  if (rawLocalDocker !== null) {
    if (!isRecord(rawLocalDocker)) throw new Error("localDockerDeployment must be an object or null");
    assertOnlyKeys(
      rawLocalDocker,
      new Set(["observedAt", "sourceSha", "composeConfigValidated", "services", "applicationProbe", "database"]),
      "localDockerDeployment",
    );
    if (
      typeof rawLocalDocker.observedAt !== "string" || Number.isNaN(Date.parse(rawLocalDocker.observedAt)) ||
      typeof rawLocalDocker.sourceSha !== "string" || !/^[a-f0-9]{40}$/i.test(rawLocalDocker.sourceSha) ||
      typeof rawLocalDocker.composeConfigValidated !== "boolean" ||
      !isRecord(rawLocalDocker.services) || !isRecord(rawLocalDocker.applicationProbe) || !isRecord(rawLocalDocker.database)
    ) {
      throw new Error("localDockerDeployment requires a dated source SHA, Compose result, services, probe and database evidence");
    }

    const services = rawLocalDocker.services;
    assertOnlyKeys(services, new Set(["app", "worker", "postgres"]), "localDockerDeployment.services");
    const parsedServices = {} as LocalDockerDeploymentEvidence["services"];
    for (const serviceName of ["app", "worker", "postgres"] as const) {
      const service = services[serviceName];
      if (!isRecord(service)) throw new Error(`localDockerDeployment.services.${serviceName} is required`);
      assertOnlyKeys(service, new Set(["imageId", "status", "sourceRevision"]), `localDockerDeployment.services.${serviceName}`);
      const rawSourceRevision = service.sourceRevision;
      let sourceRevision: string | null | undefined;
      if (rawSourceRevision === undefined) {
        sourceRevision = undefined;
      } else if (rawSourceRevision === null) {
        sourceRevision = null;
      } else if (typeof rawSourceRevision === "string" && /^[a-f0-9]{40}$/i.test(rawSourceRevision)) {
        sourceRevision = rawSourceRevision.toLowerCase();
      } else {
        throw new Error(`localDockerDeployment.services.${serviceName} sourceRevision must be a full Git SHA or null`);
      }
      if (
        typeof service.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(service.imageId) ||
        !["healthy", "unhealthy", "starting", "unknown"].includes(String(service.status))
      ) {
        throw new Error(`localDockerDeployment.services.${serviceName} requires a sha256 imageId and valid health status`);
      }
      if (
        (serviceName === "app" || serviceName === "worker") &&
        sourceRevision !== undefined && sourceRevision !== null &&
        sourceRevision !== (rawLocalDocker.sourceSha as string).toLowerCase()
      ) {
        throw new Error(`${serviceName} sourceRevision must match localDockerDeployment.sourceSha`);
      }
      parsedServices[serviceName] = {
        imageId: service.imageId.toLowerCase(),
        status: service.status as LocalDockerServiceEvidence["status"],
        ...(sourceRevision === undefined
          ? {}
          : { sourceRevision }),
      };
    }

    const probe = rawLocalDocker.applicationProbe;
    assertOnlyKeys(probe, new Set(["path", "statusCode"]), "localDockerDeployment.applicationProbe");
    if (
      typeof probe.path !== "string" || !/^\/[A-Za-z0-9/_-]{0,127}$/.test(probe.path) ||
      !Number.isInteger(probe.statusCode) || (probe.statusCode as number) < 100 || (probe.statusCode as number) > 599
    ) {
      throw new Error("localDockerDeployment.applicationProbe requires a local path and HTTP status code");
    }

    const database = rawLocalDocker.database;
    assertOnlyKeys(database, new Set(["migrationCount", "migrationHead", "volumeName"]), "localDockerDeployment.database");
    if (
      !Number.isSafeInteger(database.migrationCount) || (database.migrationCount as number) < 0 ||
      (database.migrationHead !== null && (typeof database.migrationHead !== "string" || !/^\d{14}_[A-Za-z0-9_-]+$/.test(database.migrationHead))) ||
      typeof database.volumeName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(database.volumeName)
    ) {
      throw new Error("localDockerDeployment.database requires bounded migration and volume evidence");
    }

    localDockerDeployment = {
      observedAt: new Date(rawLocalDocker.observedAt).toISOString(),
      sourceSha: rawLocalDocker.sourceSha.toLowerCase(),
      composeConfigValidated: rawLocalDocker.composeConfigValidated,
      services: parsedServices,
      applicationProbe: { path: probe.path, statusCode: probe.statusCode as number },
      database: {
        migrationCount: database.migrationCount as number,
        migrationHead: database.migrationHead as string | null,
        volumeName: database.volumeName,
      },
    };
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
    sbomArtifact,
    localDockerDeployment,
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
  if (options.sbomPath && external.sbomArtifact) {
    throw new Error("Use either --sbom or externalEvidence.sbomArtifact, not both");
  }
  const source = collectSource(repoRoot);
  if (external.sbomArtifact && external.sbomArtifact.sourceSha !== source.sha.toLowerCase()) {
    throw new Error("sbomArtifact sourceSha must match the manifest source SHA");
  }
  const sbomArtifactHash = options.sbomPath
    ? `sha256:${createHash("sha256").update(readFileSync(options.sbomPath)).digest("hex")}`
    : external.sbomArtifact?.sha256 ?? null;

  return {
    schemaVersion: 1,
    generatedAt,
    source,
    pullRequestNumber: external.pullRequestNumber,
    ciRunIds: external.ciRunIds,
    imageDigests: external.imageDigests,
    localDockerDeployment: external.localDockerDeployment,
    migrationHead: collectMigrationHead(repoRoot),
    sbomArtifactHash,
    sbomArtifactProvenance: external.sbomArtifact
      ? {
          artifactId: external.sbomArtifact.artifactId,
          workflowRunId: external.sbomArtifact.workflowRunId,
          sourceSha: external.sbomArtifact.sourceSha,
          source: external.sbomArtifact.source,
        }
      : null,
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
