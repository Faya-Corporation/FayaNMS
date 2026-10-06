# PROGRESS — FayaNMS GA program (2026-10-06 re-audit)

Live tracker. One row per wave; details live in the worklog and PR descriptions.

| Wave | Scope (findings) | Status | PR / commits | Verification |
|---|---|---|---|---|
| 0 | Engagement setup: re-verify ALL open findings vs `d281873` (zero stale), write STATE/REMEDIATION_PLAN/PROGRESS, local stack live-verified | **DONE (this PR)** | this PR | tsc 0, lint 0, targeted suites green, app+worker live probes green |
| GA-1 | P1-A02 `/sites` scope + P1-A03 backup-policy cross-site (POST/PATCH) | PENDING | — | — |
| GA-2 | P1-A01 report scoping end-to-end + P2 notification receipts | PENDING | — | — |
| GA-3 | P1-A04 API-client expiry + P1-A05 API-client site scope | PENDING | — | — |
| GA-4 | P1-O03 DLQ recovery + P0-R05/P1-O02 simulation gating + P0-R06 collector control plane (phase 1) | PENDING | — | — |
| GA-5 | Report formats: real PDF/XLSX renderers or honest removal | PENDING | — | — |
| GA-6 | GA-READINESS doc, doc-truth repair, P2-S01 absolute session cap, DR tooling (WAL/PITR + backup sidecar), P0-R01 container dispatch, P3 evidence regen | PENDING | — | — |
| GA-7 | Vendor T3 certification | **BLOCKED — EXTERNAL** | — | needs real/vendor-virtual appliances |
| GA-8 | Staging deploy/burn-in + final independent re-audit | **BLOCKED — EXTERNAL** | — | needs OCI staging secrets/host + owner sign-off |

## Verification log (rolling)

- 2026-10-06 (Wave 0): `bunx tsc --noEmit` clean; `bun run lint` clean; deployment verified live
  (app :3000 200, auth flow green, worker :3030 claim→execute→complete SUCCEEDED with real backup bytes).
- Finding re-verification: see `STATE.md` register (every OPEN P0/P1/P2 re-checked at `d281873`; none stale).
