# OCI deployment runbook

1. Confirm the source SHA has green gate, e2e, browser, scan, ARM64, and container-image evidence.
2. Confirm the protected staging approval is present.
3. Confirm /opt/fayanms/.env, /opt/fayanms/.env.app and /opt/fayanms/.env.worker are all mode 600 (root-owned; the required SEC-ENV-001 split layout — see deploy/oci/env.example) and all three image references end with the same full SHA.
4. Confirm backup status and migration compatibility.
5. Run /opt/fayanms/deploy.sh <full-commit-sha>.
6. Run /opt/fayanms/health-check.sh.
7. Record image digests, migration version, health output, timestamp, CI run, and smoke evidence without secrets.

The script fails closed on mutable/mismatched image tags, missing secrets, missing migration image, or failed health. It does not use db push or rebuild source on the staging host.

## Horizontal scaling — per-instance budget math (F-032)

The API rate gate's budgets AND the login guard's throttle/lockout state are **per-process** by default (bounded in-memory store, SCALE-001-A/B). When the app runs as N instances behind a load balancer on that default, every documented ceiling silently multiplies:

| Plane | Documented budget | Effective fleet budget on the default store |
|---|---|---|
| `/api/v1` GET | 300/min/client | N × 300/min/client (each instance keeps its own buckets) |
| `/api/v1` mutation | 120/min/client | N × 120/min/client |
| AI family (HC-1) | 10/min/client | N × 10/min/client |
| CSV import (HC-1) | 5/min/client | N × 5/min/client |
| Login attempts per source | 10 / 300 s | N × 10 / 300 s |
| Login attempts per account | 30 / 300 s | N × 30 / 300 s (lockout state never propagates — an attacker rotating across instances multiplies attempts and dilutes lockout) |

The shared store (`FAYANMS_RATE_STORE=postgres`) restores ONE budget per plane — every instance draws from the same advisory-lock-serialized rows in the database the app already depends on.

Because orchestrator scale is not visible in-process, the instance count is an explicit declaration: `FAYANMS_EXPECTED_REPLICAS` (positive integer, default/unset = 1). The startup security policy refuses to boot production with 2+ declared instances unless the shared store is selected; a malformed declaration is also refused. Development warns and never aborts.

Scale-out checklist (each step is required before traffic):

1. Set `FAYANMS_RATE_STORE=postgres` in the app env file (`.env.production.app`) on EVERY instance.
2. Set `FAYANMS_EXPECTED_REPLICAS=<N>` on every instance — all instances must declare the same value (the guard only sees its own declaration).
3. Keep `FAYANMS_TRUST_PROXY_HOPS` at the REAL proxy depth on every instance (the load balancer joins the proxy chain).
4. Scale down symmetrically: when returning to a single instance, set `FAYANMS_EXPECTED_REPLICAS=1` (or unset it) — a stale declaration does not block boot but misdocuments the posture.

Migration note: switching an already-running fleet from the in-memory store to the shared store starts every budget from an empty table (in-flight windows reset once; lockout state in the old process memory is not carried over). Do it in a maintenance window if the budgets were actively absorbing abuse.
