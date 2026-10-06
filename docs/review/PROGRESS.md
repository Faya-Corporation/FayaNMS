# PROGRESS — FayaNMS GA program (2026-10-06 re-audit)

Live tracker. One row per wave; details live in the worklog and PR descriptions.

| Wave | Scope (findings) | Status | PR / commits | Verification |
|---|---|---|---|---|
| 0 | Engagement setup: re-verify ALL open findings vs `d281873` (zero stale), write STATE/REMEDIATION_PLAN/PROGRESS, local stack live-verified. BONUS: sharp override 0.35.4→0.35.5 (new upstream HIGH advisory GHSA-wq5f-xc86-pv6w) to restore the scan gate | **MERGED** | PR #74 → `60ea5c6` | 4/4 checks green; osv-scanner clean locally w/ the CI-pinned binary |
| GA-1 | P1-A02 `/sites` scope + P1-A03 backup-policy cross-site (POST/PATCH) | **MERGED** | PR #75 → `fe9c39e` | 19-test suite; 4/4 checks green |
| GA-2 | P1-A01 report scoping end-to-end (frozen schedule scope + worker-path pin) + P2 notification receipts | **MERGED** | PR #76 → `f817e3a` | 12-test suite; 4/4 checks green |
| GA-3 | P1-A04 API-client expiry/rotation + P1-A05 API-client site scope (incl. removing the acknowledge client bypass) | **MERGED** | PR #77 → `3af334c` | 15-test suite; 4/4 checks green |
| GA-4 | P1-O03 DLQ recovery (dead list + guarded idempotent requeue + audit + depth metric/alert) + P0-R05/P1-O02 simulation gating (HA failover-test + rebalance APPLY behind FAYANMS_DEMO_MODE) | **MERGED** | PR #78 → `5140b2c` | 7-test suite + CI gate-order fix (9a69c20, dual-shape verified); 4/4 checks green |
| GA-4b | P0-R06/P1-O01 collector REAL control plane (registration/heartbeat/lease/fencing/failover) | PENDING (largest remaining build — queued after GA-6) | — | — |
| GA-5 | Report formats: REAL PDF 1.4 + XLSX renderers (zero-dependency render-pdf.ts/render-xlsx.ts), render-at-delivery download route, byte-level tests + 4-format matrix, honesty copy | **PR OPEN (CI running)** | this PR | 10-test suite (both fleet shapes); full sweep 2453/0 fail; tsc 0; lint 0 |
| GA-6 | P2-S01 absolute session cap + GA-READINESS canonical gate table + doc-truth repair (MATRIX §4 retotal, CURRENT-STATE banner) + DR tooling (WAL/PITR compose + backup sidecar + PITR runbook) + container workflow re-enabled & certification run on main + CHANGELOG draft | **PR OPEN (CI running)** | this PR | 9-test lifetime suite (auth 123/123); tsc 0; lint 0 |
| GA-7 | Vendor T3 certification | **BLOCKED — EXTERNAL** | — | needs real/vendor-virtual appliances |
| GA-8 | Staging deploy/burn-in + final independent re-audit | **BLOCKED — EXTERNAL** | — | needs OCI staging secrets/host + owner sign-off |

## Verification log (rolling)

- 2026-10-06 (Wave 0): `bunx tsc --noEmit` clean; `bun run lint` clean; deployment verified live
  (app :3000 200, auth flow green, worker :3030 claim→execute→complete SUCCEEDED with real backup bytes).
- Finding re-verification: see `STATE.md` register (every OPEN P0/P1/P2 re-checked at `d281873`; none stale).
