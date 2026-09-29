# Release Evidence Manifest

Generate a machine-readable snapshot for a release candidate from the repository root:

```bash
bun scripts/release/evidence-manifest.ts \
  --evidence /secure/path/release-input.json \
  --sbom /secure/path/fayanms.cdx.json \
  --out /secure/path/release-evidence.json
```

Use `--out -` (or omit `--out`) to write JSON to stdout. File output is exclusive: an existing file is never overwritten. The manifest contains the exact local `HEAD`, branch and pre-generation worktree cleanliness, latest migration directory, SHA-256 of the SBOM bytes, and the vendor top-tier summary parsed from `docs/certification/MATRIX.md`.

Run its focused acceptance tests with `bun test tests/audit/release-evidence-manifest.test.ts` (or Node 24+: `node --experimental-strip-types --test tests/audit/release-evidence-manifest.test.ts`).

## External evidence input

The optional `--evidence` file is JSON with only these fields:

```json
{
  "pullRequestNumber": 12,
  "ciRunIds": ["35677691852"],
  "imageDigests": {
    "app": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "localDockerDeployment": {
    "observedAt": "2026-09-23T00:31:00.000Z",
    "sourceSha": "cccccccccccccccccccccccccccccccccccccccc",
    "composeConfigValidated": true,
    "services": {
      "app": { "imageId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "status": "healthy", "sourceRevision": "cccccccccccccccccccccccccccccccccccccccc" },
      "worker": { "imageId": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "status": "healthy", "sourceRevision": "cccccccccccccccccccccccccccccccccccccccc" },
      "postgres": { "imageId": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "status": "healthy", "sourceRevision": null }
    },
    "applicationProbe": { "path": "/api/v1/meta", "statusCode": 200 },
    "database": {
      "migrationCount": 13,
      "migrationHead": "20260923010000_netflow_v5_records",
      "volumeName": "fayanms_fayanms-pgdata"
    }
  },
  "sbomArtifact": {
    "artifactId": 10673822610,
    "workflowRunId": "35677691852",
    "sourceSha": "cccccccccccccccccccccccccccccccccccccccc",
    "sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "source": "https://api.github.com/repos/OWNER/REPOSITORY/actions/artifacts/10673822610"
  },
  "branchProtectionReadback": {
    "protected": false,
    "observedAt": "2026-09-22T21:14:56.000Z",
    "source": "https://api.github.com/repos/Faya-Corporation/FayaNMS/branches/main/protection"
  },
  "externalBlockers": ["OCI staging evidence unavailable"]
}
```

Replace every example value with evidence read from the exact candidate SHA. Omit unavailable values: the output uses `null` or an empty collection and never infers a successful readback. In particular, `externalBlockers: null` means the blocker list was not supplied; provide `[]` only after verifying there are no external blockers. Image and SBOM artifact digests must be immutable `sha256:` values; branch-protection evidence requires both an observation time and source. For `sbomArtifact`, record GitHub's artifact ID, workflow run ID, full source SHA, API-reported artifact digest, and HTTPS API URL. The tool checks that `sourceSha` matches local `HEAD` and records this provenance; it does not contact GitHub or verify the API response, run association, or digest. Do not use signed download URLs. Supply either `sbomArtifact` or `--sbom`, not both: the former records the archive digest reported by GitHub, while the latter hashes local SBOM file bytes. Review all external links and artifacts independently; this tool does not decide release eligibility.

## Handling and interpretation

- Keep the input and output outside the checkout where practical; the source cleanliness field is captured before the artifact is written.
- `localDockerDeployment` is an optional, timestamped operator readback. Record the app/worker/PostgreSQL Docker image IDs, health, source revision labels when present, a non-authenticated application probe, Compose validation, applied migration count/head, and named database volume. When app or worker `sourceRevision` is supplied, the generator requires it to match the deployment `sourceSha`. Docker image IDs are local image identities, not registry distribution digests; keep `imageDigests` empty until immutable registry digests are verified. The generator validates fields but does not query Docker; the operator must inspect the live containers and confirm the source labels.
- Do not put credentials, tokens, private URLs, or raw device/configuration data in evidence fields or blockers.
- Preserve the JSON with the release record. The SBOM hash identifies an artifact/archive or local file bytes, depending on the input path; it does not embed or authenticate the SBOM's publisher.
- A manifest is a snapshot, not a substitute for required CI, image publication, staging, backup/restore, governance, security, or vendor-lab acceptance. Re-generate after the candidate SHA or evidence changes.
