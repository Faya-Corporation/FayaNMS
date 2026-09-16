# FayaNMS — R50-T001/T002/T003 Remediation Evidence (Phase R50.0, P0 gate)

**Date:** 2026-09-16
**Branch:** `z_ai_v2`
**Remediates:** R50-001 (P0) — host-key enrollment lookup fails open in the vendor auto-detect route; verdict `FayaNMS-R50-Vendor-Autodetect-Audit-Verdict-2026-09-16.md` §3 R50-001 (CONFIRMED P0, "broader than stated" — the defect was test-pinned as contract).
**Roadmap:** Phase R50.0 — R50-T001 (fail closed) + R50-T002 (trust-state type) + R50-T003 (SAFE-001 regression guard).

---

## 1. Verdict of this remediation

**R50-001: FIXED (fail-closed, verified).** No code path treats unknown trust state as first contact. The exit-gate sentence of the roadmap is now executable contract: an enrollment-store outage, timeout, unexpected persistence error, or invalid endpoint coordinate can never enable first-contact SSH capture on the auto-detect surface.

Production stays gated on the remaining P1s (R50-002 vendor-first contract, R50-003 trust identity, R50-004..R50-006) — Phase R50.0 removes the P0 only.

## 2. Changes

### R50-T002 — explicit trust-state type (`src/lib/ssh/host-keys.ts`)

- NEW `HostKeyTrustState`: `enrolled {fingerprint, keyType, enrolledAt}` | `unenrolled` | `lookup-failed {reason}` — nullable trust semantics replaced; "PROVEN absent" and "store unusable" are distinct states.
- NEW `resolveHostKeyTrustState(host, port, lookup?)`: total function (typed result, never throws, `resolveHostToIp`-style); injectable lookup seam for the regression matrix; the DEFAULT lookup is the real enrollment store. Invalid endpoint coordinates resolve to `lookup-failed` (`TRUST_LOOKUP_INVALID_ENDPOINT`) — an unnormalizable identity is NOT a proven first contact.
- NEW `trustLookupFailureReason(error)`: bounded, non-secret classification (prefers `code`, then `errorCode`, then error class name; values are never echoed).
- `getHostKeyPin` retained for existing callers (zero regression) with an explicit R50-T001 warning: null is a POLICY DECISION, never a persistence outcome.

### R50-T001 — fail-closed route (`src/app/api/v1/devices/auto-detect/route.ts`)

- The fail-open block is REMOVED: no `catch { pin = null }` exists anywhere on the trust path; `pin` is set ONLY by the enrolled-state ternary.
- Trust resolution happens BEFORE the worker SSH connection, with three explicit outcomes:
  - `enrolled` → the pin rides on the probe (worker verifies pre-auth);
  - `unenrolled` (PROVEN) → `enrollHostKey: trust.state === "unenrolled"` — the audited first-contact capture;
  - `lookup-failed` → **abort before any connection**: typed error `HOST_KEY_ENROLLMENT_LOOKUP_FAILED` (HTTP 503) + dedicated audit event `HOST_KEY_TRUST_LOOKUP_FAILED` (FAILURE, correlation id, bounded `reason`). The audit emission is best-effort (the audit plane may share the store's fate) and logs its own failure — it can never convert the abort into a success path.
- The defect-pin asserted by the verdict (`enrollHostKey: !pin` in `tests/audit/vendor-detect.test.ts:316`) is replaced with the fail-closed contract pins.

### R50-T003 — SAFE-001 regression guard (`tests/audit/r50-trust-failclosed.test.ts`, NEW)

Behavioral matrix over the injectable seam (the roadmap's R50-T001 test list, executed — not merely source-pinned):

| Case | Pinned result |
|---|---|
| existing enrollment | `enrolled` with the pinned fingerprint |
| no enrollment | `unenrolled` (the ONLY capture-eligible state) |
| DB timeout (`P2024` fixture) | `lookup-failed` / `P2024` |
| DB connection refused (`P1001` fixture) | `lookup-failed` / `P1001` |
| unexpected persistence error | `lookup-failed` / `TRUST_LOOKUP_UNKNOWN` |
| exotic rejections (strings, numbers, plain objects, TypeError, undefined, null) | always `lookup-failed` with a bounded reason |
| invalid endpoint coordinates (empty host, port 0/70000/22.5) | `lookup-failed` / `TRUST_LOOKUP_INVALID_ENDPOINT` — even against a healthy store |

Plus route-wiring pins: trust resolution precedes the fetch; the typed abort precedes the fetch and is an early `return fail(...)` (not a 200 degradation); the dedicated audit event exists; capture is opted into ONLY on `trust.state === "unenrolled"`; the old fail-open literals (`enrollHostKey: !pin`, `getHostKeyPin(` in the route, the "enrollment store hiccup" comment) are pinned DEAD. Worker-plane invariance re-pinned as defense in depth (`SSH_HOSTKEY_UNENROLLED` refusal requires the explicit `enrollHostKey === true` opt-in).

## 3. Gate execution on the exact changed tree (2026-09-16, this sandbox)

| Gate | Result |
|---|---|
| `bun run lint` | 0 |
| `bunx tsc --noEmit` (full, unfiltered) | 0 |
| `bun test tests/` (documented CI env shape, no root .env) | **657 pass / 12 skip / 0 fail — 669 tests / 39 files / 3,566 expects** (prior 640 + 17 new) |

## 4. Live evidence (sandbox deployment, app :3000 + worker :3030 + embedded PG :5433)

1. **E2E smoke (PG up):** authenticated `POST /api/v1/devices/auto-detect` `{host:"127.0.0.1", credentialProfileId:"cred-ssh-pass"}` → 200; the response shows the full stage chain: `mgmtIpResolution mode=ip-literal`, `vendorStage=executed`, and the worker's typed refusal `CREDENTIAL_UNRESOLVED: Vault reference vault://ssh/network-admin has no worker-side entry…` — i.e. the probe reached the real worker over the authenticated control plane and failed only where the sandbox honestly lacks a vault secret (documented R50-007 posture).
2. **Deployment gap found + fixed during this evidence run:** the app→worker control-plane direction had never been exercised in this sandbox — the worker's `FAYANMS_SERVICE_PUBLIC_KEYS` trusted a stale key instead of the app's control public key (`Token signature verification failed`). The worker's trusted set was corrected atomically (own public key + current control public key, digests `c990fb0c…` + `5a375262…`) and the worker restarted; the smoke above is the post-fix proof. Runtime-only fix (gitignored env); no repo change.
3. **Real trust-store outage:** embedded PostgreSQL STOPPED (`pg_ctl stop -m fast`) → `resolveHostKeyTrustState` executed through the REAL Prisma client → returned `{"state":"lookup-failed","reason":"PrismaClientInitializationError"}` — NOT `unenrolled`; per the route wiring (source-pinned order) this state aborts the probe before any worker SSH connection. PostgreSQL restarted; worker self-healed (`backend recovered after 1 consecutive claim failures`), app healthy (200 on `/api/v1/meta`).
   - Honest scope: the route's HTTP 503 cannot be observed END-TO-END during a DB outage because the auth plane (`requirePermission` → session/user lookup) needs the same database and fails first — the outage evidence is therefore resolver-level (real) + wiring-level (executable pins). Both layers together close the exit gate.

## 5. Disposition

- R50-001 (P0): **FIXED** — fail-closed, behaviorally tested, live-verified at the resolver layer.
- The R50 verdict's "broader than stated" sharpening (the defect was pinned as contract) is specifically remediated: the replacement pin asserts the fail-closed wiring.
- Phase R50.1 (R50-T010..T013 vendor-first orchestration + trust-identity ADR) remains the next code phase; R50-002/003/004/005/006 stay open P1s until their phases land.
- CI certification remains runner-blocked (CI-001, infrastructure signature since run #34); local gates are the source of truth on this branch.
