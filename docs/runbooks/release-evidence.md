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
  "branchProtectionReadback": {
    "protected": false,
    "observedAt": "2026-09-22T21:14:56.000Z",
    "source": "https://api.github.com/repos/fayafatehi/FayaNMS/branches/main/protection"
  },
  "externalBlockers": ["OCI staging evidence unavailable"]
}
```

Replace every example value with evidence read from the exact candidate SHA. Omit unavailable values: the output uses `null` or an empty collection and never infers a successful readback. In particular, `externalBlockers: null` means the blocker list was not supplied; provide `[]` only after verifying there are no external blockers. Image digests must be immutable `sha256:` values; branch-protection evidence requires both an observation time and source. This tool does not call GitHub, validate that an external run belongs to the source SHA, or decide release eligibility—review those links and artifacts independently.

## Handling and interpretation

- Keep the input and output outside the checkout where practical; the source cleanliness field is captured before the artifact is written.
- Do not put credentials, tokens, private URLs, or raw device/configuration data in evidence fields or blockers.
- Preserve the JSON with the release record. The SBOM hash identifies bytes but does not embed or authenticate the SBOM's publisher.
- A manifest is a snapshot, not a substitute for required CI, image publication, staging, backup/restore, governance, security, or vendor-lab acceptance. Re-generate after the candidate SHA or evidence changes.
