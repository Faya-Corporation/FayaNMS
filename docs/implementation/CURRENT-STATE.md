# Canonical Implementation State

**Snapshot date:** 2026-09-23 00:33 UTC
**Purpose:** concise, evidence-qualified status for implementation and release work. Historical audit pages retain their original dates; use this page for the latest consolidated state.

## Repository and governance

- Repository: `fayafatehi/FayaNMS`; checked-out branch: `main`.
- Reviewed code baseline: `2170a53ecf3de88f335ac00ffa69d2f73d575302`; local `origin/main` and `HEAD` matched at this snapshot (`git rev-list --left-right --count origin/main...HEAD` → `0 0`). This is a local-ref comparison, not a fresh GitHub readback.
- **Worktree is not clean.** It contains pre-existing line-ending-only changes and four unrelated untracked items. They are outside the focused commits and must be preserved.
- Last live GitHub branch readback (2026-09-22 21:36:31 UTC) reported `main.protected=false`; the protection endpoint returned 403. This status has not been rechecked for this snapshot. Enabling protection remains an owner action.

## Implementation and release status

| Area | Status | Evidence / remaining work |
|---|---|---|
| Cloud implementation ledger (CLOUD-11) | IN PROGRESS | Authenticated SNMPv3 polling, durable protocol event queue, and bounded continuous discovery/reconciliation are present. The implementation is real; physical-vendor certification remains open. Collector ownership/failover and DLQ operator alert/replay remain. See the cloud progress ledger. |
| Local Docker deployment | HEALTHY — CONFIG RECONCILED | At 2026-09-23 00:31 UTC, app, worker, and PostgreSQL were healthy; `/api/v1/meta` returned HTTP 200; Prisma reported all 13 migrations applied. The ignored `.env.production` DB credential was reconciled to the running app without exposing the secret. No service was restarted and the named PostgreSQL volume remains attached. Compose config and one-off migration status now pass. |
| Post-merge CI | NOT RECHECKED AT REVIEWED BASELINE | Last recorded pass is run `35677691852` on merge SHA `5671bc5` (2026-09-22). No exact-head CI result for `2170a53` is recorded here. |
| ARM64 container certification / GHCR | HISTORICAL PASS / PUBLISH FAILED | Run `35678367826` on the older merge SHA passed ARM64 build/runtime/scan but failed multi-architecture publication (`BlobNotFound`); no immutable image digest was verified. No newer exact-head certification is recorded. |
| Release evidence manifest (N0-002) | IMPLEMENTED — BASELINE SNAPSHOT RECORDED | [`release-evidence-5671bc5.json`](release-evidence-5671bc5.json) records CI/SBOM provenance for merged remote-main SHA `5671bc5`; it also records failed OCI publication, skipped staging, and absent hardware evidence. It is not a release approval or a snapshot of the dirty local checkout. See `docs/runbooks/release-evidence.md`. |
| Staging / OCI | NOT VERIFIED | Staging workflows were last recorded skipped; no live staging or production deployment is claimed. |
| NetFlow v5 records | IMPLEMENTED — DEPLOYED LOCALLY | Decoder, strict bounded ingest, durable queue persistence, idempotent drain, and audited 14-day retention are present and deployed in the local stack. Operator guidance is in `docs/runbooks/netflow-v5.md`. `/api/v1/flows` remains simulated; exporter interoperability is unverified. |
| Hardware certification | BLOCKED — EXTERNAL | No physical-vendor lab evidence is recorded; do not promote harness/simulator results to hardware certification. |
| Production readiness | NOT CERTIFIED | External governance, deployment, lab, and disaster-recovery evidence remains outstanding. |

## Backlog handling

The dated enterprise roadmap and detailed task backlog are planning inputs, not proof that a task is complete. Track implementation against their N0–N25 items and GA-1–GA-12 gates; mark an item complete only with its stated acceptance evidence. User/owner-controlled changes (including branch protection, credentials, external infrastructure, push, or merge) require explicit authorization and verification.

## Refresh procedure

Before release or a material status update, fetch/read the remote `main` SHA and protection API, inspect the exact CI/container run and immutable image digest, and verify staging evidence. Update this snapshot with the observation time and source. Do not infer live state from the local tracking ref or historical audit pages.
