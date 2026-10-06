# Canonical Implementation State

> **GA-6 truth retotal (2026-10-06):** the canonical, live gate table now
> lives in **[`docs/release/GA-READINESS.md`](../release/GA-READINESS.md)** —
> read it FIRST. Corrections to the snapshot below, verified by API read-back
> at main `24ccacf`: branch protection on `main` IS ACTIVE (required checks
> `gate`+`e2e`+`browser`+`scan`, strict, no force-push/deletion; the older
> "NOT ACTIVE" claim was wrong); CI is GREEN on current main (runs
> `37530420835`, `37538435081`); the container workflow was `disabled_manually`
> and has been re-enabled + dispatched (run `37542612715`). The table below is
> retained as the 2026-09-23 historical snapshot — rows are NOT current claims.

**Snapshot date:** 2026-09-23 01:01 UTC
**Purpose:** concise, evidence-qualified status for implementation and release work. Historical audit pages retain their original dates; use this page for the latest consolidated state.

## Repository and governance

- Repository: `Faya-Corporation/FayaNMS`; checked-out branch: `main`.
- Repository snapshot source: `7e4436183f337b52115fbb1ae0326dd8c3907627`; local `origin/main` and `HEAD` matched when observed (refresh with `git rev-list --left-right --count origin/main...HEAD`). This is a local-ref comparison, not a fresh GitHub readback.
- **Worktree is not clean.** It contains pre-existing line-ending changes, an unrelated local Compose edit, and four unrelated untracked items. They are outside the focused commits and must be preserved.
- Last live GitHub branch readback (2026-09-22 21:36:31 UTC) reported `main.protected=false`; the protection endpoint returned 403. This status has not been rechecked for this snapshot. Enabling protection remains an owner action.

## Implementation and release status

| Area | Status | Evidence / remaining work |
|---|---|---|
| Cloud implementation ledger (CLOUD-11) | IN PROGRESS | Authenticated SNMPv3 polling, durable protocol event queue, and bounded continuous discovery/reconciliation are present. The implementation is real; physical-vendor certification remains open. Collector ownership/failover and DLQ operator alert/replay remain. See the cloud progress ledger. |
| Local Docker deployment | HEALTHY — SOURCE VERIFIED | At 2026-09-23 01:01 UTC, app, worker, and PostgreSQL were healthy; `/api/v1/meta` returned HTTP 200; Prisma reported all 13 migrations applied. Compose config validates and the read-only migration status is current. App/worker OCI revision labels match `7e44361`; only those two containers were rolled. The PostgreSQL container and named volume remain unchanged. The ignored `.env.production` credential was reconciled earlier without exposing it. See [`release-evidence-7e44361.json`](release-evidence-7e44361.json). |
| Post-merge CI | NOT RECHECKED AT CURRENT HEAD | Last recorded pass is run `35677691852` on merge SHA `5671bc5` (2026-09-22). No exact-head CI result for `7e44361` is recorded here. |
| ARM64 container certification / GHCR | HISTORICAL PASS / PUBLISH FAILED | Run `35678367826` on the older merge SHA passed ARM64 build/runtime/scan but failed multi-architecture publication (`BlobNotFound`); no immutable image digest was verified. No exact-head certification or GHCR digest is recorded for `7e44361`. |
| Release evidence manifest (N0-002) | IMPLEMENTED — HISTORICAL + CURRENT LOCAL SNAPSHOTS | [`release-evidence-5671bc5.json`](release-evidence-5671bc5.json) preserves historical CI/SBOM provenance. [`release-evidence-7c5f069.json`](release-evidence-7c5f069.json) is the earlier local deployment snapshot. [`release-evidence-7e44361.json`](release-evidence-7e44361.json) records current image IDs and verified app/worker source labels, health, HTTP probe, migrations, volume, and open blockers. The current snapshot reports a dirty worktree and does not claim exact-head CI/SBOM or registry digests. See `docs/runbooks/release-evidence.md`. |
| Staging / OCI | NOT VERIFIED | Staging workflows were last recorded skipped; no live staging or production deployment is claimed. |
| NetFlow v5 records | IMPLEMENTED — DEPLOYED LOCALLY | Decoder, strict bounded ingest, durable queue persistence, idempotent drain, and audited 14-day retention are present and deployed in the local stack. Operator guidance is in `docs/runbooks/netflow-v5.md`. `/api/v1/flows` remains simulated; exporter interoperability is unverified. |
| Hardware certification | BLOCKED — EXTERNAL | No physical-vendor lab evidence is recorded; do not promote harness/simulator results to hardware certification. |
| Production readiness | NOT CERTIFIED | External governance, deployment, lab, and disaster-recovery evidence remains outstanding. |

## Backlog handling

The dated enterprise roadmap and detailed task backlog are planning inputs, not proof that a task is complete. Track implementation against their N0–N25 items and GA-1–GA-12 gates; mark an item complete only with its stated acceptance evidence. User/owner-controlled changes (including branch protection, credentials, external infrastructure, push, or merge) require explicit authorization and verification.

## Refresh procedure

Before release or a material status update, fetch/read the remote `main` SHA and protection API, inspect the exact CI/container run and immutable image digest, and verify staging evidence. Update this snapshot with the observation time and source. Do not infer live state from the local tracking ref or historical audit pages.
