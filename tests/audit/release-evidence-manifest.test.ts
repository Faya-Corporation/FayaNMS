import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  buildEvidenceManifest,
  parseExternalEvidence,
  writeEvidenceManifest,
} = await import(new URL("../../scripts/release/evidence-manifest.ts", import.meta.url).href);

function fixtureRepo(): { root: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "fayanms-evidence-test-"));
  const root = join(parent, "repo");
  mkdirSync(join(root, "prisma", "migrations", "20260101000000_init"), { recursive: true });
  mkdirSync(join(root, "prisma", "migrations", "20260102000000_add_events"), { recursive: true });
  mkdirSync(join(root, "docs", "certification"), { recursive: true });
  writeFileSync(join(root, "tracked.txt"), "fixture\n");
  writeFileSync(
    join(root, "docs", "certification", "MATRIX.md"),
    [
      "| Vendor | Auth | Backup | Top tier |",
      "|---|---|---|---|",
      "| cisco-ios | T1 | T1/T2 | T2 |",
      "| sophos | T1 | T1 | T1 |",
      "Legend: protocol harness and simulator tiers.",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
    { cwd: root },
  );
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test("builds a verifiable snapshot without inventing absent external release evidence", () => {
  const fixture = fixtureRepo();
  try {
    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const manifest = buildEvidenceManifest({
      repoRoot: fixture.root,
      generatedAt: "2026-09-23T00:00:00.000Z",
    });

    assert.equal(manifest.source.sha, expectedSha);
    assert.equal(manifest.source.branch, "main");
    assert.equal(manifest.source.worktreeClean, true);
    assert.equal(manifest.migrationHead, "20260102000000_add_events");
    assert.equal(manifest.pullRequestNumber, null);
    assert.deepEqual(manifest.ciRunIds, []);
    assert.deepEqual(manifest.imageDigests, {});
    assert.equal(manifest.branchProtectionReadback, null);
    assert.equal(manifest.sbomArtifactHash, null);
    assert.equal(manifest.sbomArtifactProvenance, null);
    assert.equal(manifest.externalBlockers, null);
    assert.equal(manifest.certificationTierSummary.highestRecordedTier, "T2");
    assert.equal(manifest.certificationTierSummary.vendorCount, 2);
  } finally {
    fixture.cleanup();
  }
});

test("hashes SBOM bytes and preserves supplied, dated release readbacks", () => {
  const fixture = fixtureRepo();
  const sbomPath = join(fixture.root, "..", "sbom.json");
  try {
    writeFileSync(sbomPath, "{\"bomFormat\":\"CycloneDX\"}\n");
    const manifest = buildEvidenceManifest({
      repoRoot: fixture.root,
      generatedAt: "2026-09-23T00:00:00.000Z",
      sbomPath,
      externalEvidence: {
        pullRequestNumber: 12,
        ciRunIds: ["35677691852"],
        imageDigests: { app: `sha256:${"a".repeat(64)}` },
        branchProtectionReadback: {
          protected: false,
          observedAt: "2026-09-22T21:14:56.000Z",
          source: "https://api.github.com/repos/fayafatehi/FayaNMS/branches/main/protection",
        },
        externalBlockers: ["OCI staging evidence unavailable"],
      },
    });

    assert.equal(manifest.sbomArtifactHash, "sha256:e3a851f1fa2cdc51abe1e2b9403fe108efeb7547bd9c1878fcbf4750ace837ed");
    assert.equal(manifest.sbomArtifactProvenance, null);
    assert.equal(manifest.pullRequestNumber, 12);
    assert.deepEqual(manifest.ciRunIds, ["35677691852"]);
    assert.equal(manifest.imageDigests.app, `sha256:${"a".repeat(64)}`);
    assert.equal(manifest.branchProtectionReadback?.protected, false);
    assert.equal(manifest.branchProtectionReadback?.observedAt, "2026-09-22T21:14:56.000Z");
    assert.deepEqual(manifest.externalBlockers, ["OCI staging evidence unavailable"]);
  } finally {
    rmSync(sbomPath, { force: true });
    fixture.cleanup();
  }
});

test("binds an externally recorded SBOM artifact digest to its exact source SHA and run", () => {
  const fixture = fixtureRepo();
  try {
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const manifest = buildEvidenceManifest({
      repoRoot: fixture.root,
      externalEvidence: {
        sbomArtifact: {
          artifactId: 10673822610,
          workflowRunId: "35677691852",
          sourceSha,
          sha256: `sha256:${"b".repeat(64)}`,
          source: "https://api.github.com/repos/fayafatehi/FayaNMS/actions/artifacts/10673822610",
        },
      },
    });

    assert.equal(manifest.sbomArtifactHash, `sha256:${"b".repeat(64)}`);
    assert.deepEqual(manifest.sbomArtifactProvenance, {
      artifactId: 10673822610,
      workflowRunId: "35677691852",
      sourceSha,
      source: "https://api.github.com/repos/fayafatehi/FayaNMS/actions/artifacts/10673822610",
    });
    assert.throws(
      () => buildEvidenceManifest({
        repoRoot: fixture.root,
        externalEvidence: {
          sbomArtifact: {
            artifactId: 10673822610,
            workflowRunId: "35677691852",
            sourceSha: "f".repeat(40),
            sha256: `sha256:${"b".repeat(64)}`,
            source: "https://api.github.com/repos/fayafatehi/FayaNMS/actions/artifacts/10673822610",
          },
        },
      }),
      /must match the manifest source SHA/i,
    );
    assert.throws(
      () => buildEvidenceManifest({
        repoRoot: fixture.root,
        sbomPath: join(fixture.root, "tracked.txt"),
        externalEvidence: {
          sbomArtifact: {
            artifactId: 10673822610,
            workflowRunId: "35677691852",
            sourceSha,
            sha256: `sha256:${"b".repeat(64)}`,
            source: "https://api.github.com/repos/fayafatehi/FayaNMS/actions/artifacts/10673822610",
          },
        },
      }),
      /either --sbom or externalEvidence\.sbomArtifact/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("marks the source unclean when tracked files differ from the candidate commit", () => {
  const fixture = fixtureRepo();
  try {
    writeFileSync(join(fixture.root, "tracked.txt"), "changed after commit\n");
    const manifest = buildEvidenceManifest({ repoRoot: fixture.root });
    assert.equal(manifest.source.worktreeClean, false);
  } finally {
    fixture.cleanup();
  }
});

test("rejects malformed digests and branch-protection claims without dated provenance", () => {
  assert.throws(
    () => parseExternalEvidence({ imageDigests: { app: "latest" } }),
    /sha256 digest/i,
  );
  assert.throws(
    () => parseExternalEvidence({ branchProtectionReadback: { protected: true } }),
    /observedAt and source/i,
  );
  assert.throws(
    () => parseExternalEvidence({ sbomArtifact: { artifactId: 1, workflowRunId: "1", sourceSha: "bad", sha256: "bad", source: "bad" } }),
    /sbomArtifact requires/i,
  );
  assert.throws(
    () => parseExternalEvidence({
      sbomArtifact: {
        artifactId: 1,
        workflowRunId: "1",
        sourceSha: "a".repeat(40),
        sha256: `sha256:${"b".repeat(64)}`,
        source: "https://example.invalid/artifact?token=secret",
      },
    }),
    /without credentials, query parameters or fragments/i,
  );
  assert.throws(() => parseExternalEvidence({ token: "must-not-be-accepted" }), /unexpected field/i);
});

test("writes artifacts exclusively and does not overwrite an earlier evidence snapshot", () => {
  const fixture = fixtureRepo();
  const outPath = join(fixture.root, "evidence.json");
  try {
    const manifest = buildEvidenceManifest({ repoRoot: fixture.root });
    writeEvidenceManifest(outPath, manifest);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).source.sha, manifest.source.sha);
    assert.throws(() => writeEvidenceManifest(outPath, manifest), /already exists/i);
  } finally {
    fixture.cleanup();
  }
});
