# RT-017 — container.yml: scan the local image BEFORE publishing (scan gate ordering)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-024 | A5-03 | P2 | M | Low-Medium — workflow-only change; repo-level disabled so zero runtime risk, but multi-arch build/push mechanics must be re-verified on re-enable |

## Problem & evidence

`.github/workflows/container.yml`:
- Lines 169-209: three `docker/build-push-action` steps with `push: true` publish `fayanms`, `fayanms-worker`, `fayanms-migrator` to GHCR with immutable SHA tags.
- Lines 216-242: ONLY AFTERWARDS do the three trivy scans run (`exit-code: "1"`, HIGH/CRITICAL fatal, "Scan published image…").

A CRITICAL/HIGH image is already published (immutable-tag = registrable/pullable) before the gate trips; scan failure blocks downstream deploy but leaves the vulnerable image in the registry.

NOTE (binding context): container.yml is DISABLED at repo level by owner request — this change is file-only; it cannot be exercised against the real registry until re-enable. Keep the change internally consistent and validated by the existing workflow-shape tests.

## Impact

Vulnerable images persist in GHCR after a red gate (supply-chain hygiene failure; contradicts the R78 contract the workflow comments cite).

## Root cause

The gate was appended after the publish steps (git history: 38fbdfb "align post-publish image gate with the R78 HIGH/CRITICAL contract") instead of being ordered before the push.

## Required change

1. **Reorder: build (no push) → scan → push.** In `.github/workflows/container.yml`:
   - Convert the three build steps (lines 169-209) to build WITHOUT publishing: `push: false`, add `outputs: type=docker,dest=/tmp/<name>.tar` (buildx docker export) OR `load: true` with single-platform — **multi-arch note**: `load: true` cannot load a multi-platform manifest; for `linux/amd64,linux/arm64` the correct pattern is to keep the multi-arch PUSH for the final promotion but run the SCAN GATE on the locally built amd64 image first (vulnerability surface is effectively identical across arches for these images; document this decision in a step comment, and keep the arm64 attestation via the later multi-arch push).
   - Concretely: (a) build+scan gate job steps: `docker/build-push-action` with `push: false`, `load: true`, `platforms: linux/amd64`, tags `fayanms:gate` / `fayanms-worker:gate` / `fayanms-migrator:gate`; (b) the three existing trivy steps (lines 216-242) retargeted at the LOCAL refs (`image-ref: fayanms:gate` etc., rename step to "Scan built image (HIGH/CRITICAL fatal)"); (c) AFTER all three gates pass, three push steps: `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`, `push: true`, same tags/labels/build-args/SBOM/provenance as today (lines 169-209 content, minus rebuild concerns — buildx cache makes the second build cheap).
   - Keep the SARIF evidence steps (lines 244+) after the push, unchanged (they are evidence, not the gate).
2. Update the step-comment block (lines 211-215) to describe the new order: "scan the LOCALLY BUILT image before any push; published images have always passed the gate."
3. Consistency sweep: `rg -n "Scan published" .github/ docs/ scripts/` — update `scripts/release/evidence-manifest.ts` or runbook text if it names the "Scan published image" step id (the evidence manifest references workflow step names in places; verify via `rg -n "image-scan|trivy" scripts/release/ docs/runbooks/release-evidence.md`).
4. `tests/audit/r78-image-scan-triage.test.ts` and `tests/audit/docker-image-provenance.test.ts` may pin the current step order/shapes — read them first and update expectations in the SAME PR (they are contract tests; the contract is changing deliberately per this RT).

## Tests to add

File: `tests/audit/rt017-scan-before-publish.test.ts` (workflow-YAML police test, style of `tests/audit/r78-image-scan-triage.test.ts`).

1. `scan steps precede push steps` — parse container.yml; assert every trivy gate step index < every `push: true` step index.
2. `gate targets local refs` — assert the three gate steps' `image-ref` values are the local `:gate` tags, not `ghcr.io/…` (negative case: no trivy step references ghcr).
3. `push steps keep multi-arch + provenance + sbom` — assert the push steps retain `platforms: linux/amd64,linux/arm64`, `sbom: true`, `provenance: mode=max` (no silent weakening while reordering).
4. `build-args unchanged` — `NEXT_PUBLIC_SITE_URL`/`FAYANMS_SOURCE_SHA` build-args preserved on the final push steps (guards A5-05-adjacent contract from drifting accidentally).
5. `SARIF evidence remains after the push` — evidence steps ordered last (documented evidence-not-gate role).

## Acceptance criteria

- [ ] No image reaches GHCR before all three HIGH/CRITICAL gates pass on the locally built image.
- [ ] Published artifacts keep today's tags/labels/provenance/SBOM contract exactly.
- [ ] Workflow-shape contract tests updated and green (r78/docker-image-provenance if touched).
- [ ] Workflow remains disabled at repo level — no runtime/CI behavior change until the owner re-enables it.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass (they lint the repo, not the workflow — still required as the merge gate).

## Verification

```bash
bun test tests/audit/rt017-scan-before-publish.test.ts   # new suite green
bun test tests/audit/r78-image-scan-triage.test.ts tests/audit/docker-image-provenance.test.ts   # updated contracts green
bun test tests/                                          # no regressions
node_modules/typescript/bin/tsc --noEmit                 # exit 0
bun run lint                                             # 0 errors
# Optional local YAML sanity:
bun -e "console.log(!!Bun.file('.github/workflows/container.yml').text().then(t => t.length))"
```

## Rollout & rollback notes

File-only (workflow disabled repo-wide) → zero deploy risk; rollback = revert the YAML. On repo-level re-enable, expect slightly longer wall-clock (second buildx pass is cache-served) — acceptable; do not trade the ordering back.
