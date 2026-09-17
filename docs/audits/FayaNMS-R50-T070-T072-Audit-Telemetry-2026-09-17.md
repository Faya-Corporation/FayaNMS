# FayaNMS — R50.7 Audit + Telemetry Evidence (R50-T070/T071/T072)

**Date:** 2026-09-17 · **Branch:** `z_ai_v2` · **Phase:** R50.7 of the R50 Vendor/IP-Autodetect Remediation Roadmap (`FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md` §9)

Scope: the detection plane's audit trail becomes structured evidence (T070), every failure class becomes auditable (T071), and the plane gains operational metrics (T072) with a permission-gated read surface. The HTTP response contract is UNCHANGED — `DETECTION_CONTRACT_VERSION` stays 1 (audit + metrics planes only).

---

## 1. R50-T070 — Structured, non-secret `DEVICE_VENDOR_AUTODETECTED` evidence

The main event's `afterJson` now carries the full roadmap evidence set, mirrored where the audit row already had it so exports are self-contained:

| Field | Source | Note |
|---|---|---|
| `actorId` | mirrored from the audit column | self-contained exports |
| `correlationId` | mirrored from the audit column | ties refusal rows to the main row |
| `tenant` | `null` **BY DESIGN** | single-tenant schema — the field is RESERVED for the roadmap's shape and never silently omitted |
| `outcome` | NEW literal | `matched` / `vendor-unknown` / `failed` / `not-attempted` (vendor-stage precedence) |
| `durationMs` | NEW | total route wall-clock (the worker's `latencyMs` is the probe leg only) |
| `requestedHost` / `connectionAddress` / `resolvedManagementIp` | R50-T011 | the three endpoint identities stay apart |
| `credentialProfileId` / `hostKeyState` | R50.4 | unchanged |
| `vendorKey` / `model` / `osVersion` / `confidence` | unchanged | attribution facts |
| `matchReasons` / `softMatches` | R50.5 | WHY the vendor was claimed |
| `detectionErrorCode` / `resolutionErrorCode` / `contractVersion` | R50.4 | typed stage codes |
| `requestedStages` | R50.6 | what the invocation asked to run |

Non-secret guarantee: the evidence carries NO passwords, vault references, key material, or session secrets — only coordinates and classifications already present in the response the operator saw.

## 2. R50-T071 — Every failure class is audited

| Failure class | Audit event | Status |
|---|---|---|
| Authorization refusal | `DEVICE_PROBE_AUTH_REFUSED` (NEW) | actor identified when the session is valid (RBAC/API-client refusals); **null actor BY DESIGN** for unauthenticated hits (actorId is nullable — no identity fabricated); detail: requestedHost, permission, AuthError code |
| Target-policy refusal | `DEVICE_PROBE_TARGET_REFUSED` | existed (R50-T022); now emitted through the shared best-effort helper (was an unprotected await — a probe refusal could 500 if the audit plane hiccuped) |
| Credential failure | `DEVICE_PROBE_CREDENTIAL_REFUSED` (NEW) | both refusals audited with `reason: "not-found" | "type-unsupported"` + profileType |
| Trust-lookup failure | `HOST_KEY_TRUST_LOOKUP_FAILED` | existed (R50-T001, fail-closed) |
| Host-key mismatch | `DEVICE_PROBE_HOST_KEY_MISMATCH` (NEW) | worker rejects PRE-AUTH (SAFE-001); the row records a possible first-contact substitution attempt against a pinned coordinate |
| Timeout / unreachable / command rejected | main event FAILURE + typed codes (`SSH_CONNECT_TIMEOUT`, `SSH_UNREACHABLE`, …) | existed since R50.4 |
| Unknown vendor | main event + `detectionErrorCode: VENDOR_UNKNOWN` | existed since R50.4 (result SUCCESS semantics preserved — the endpoint call succeeded; the outcome literal + metrics carry the failure-class view) |
| Rate-limit exhaustion | **counted, NOT audited per-hit BY DESIGN** | the budget is the abuse control; per-hit rows would let an attacker flood the audit plane (documented in the route docstring) |

All refusal emissions are best-effort via the shared `auditProbeFailureBestEffort` helper: a refusal must never become a 500 because the audit plane hiccuped — and never a success either.

## 3. R50-T072 — Operational metrics

NEW `src/lib/metrics/detection-metrics.ts` — in-process, bounded, zero new infra (mirrors the SCALE-001-A posture). The six roadmap names verbatim, with the documented taxonomy:

- `device_detection_requests_total` — well-formed invocations (INVALID_BODY never counted)
- `device_detection_success_total` — certified attribution only (`matched`)
- `device_detection_vendor_unknown_total` — completed probe, no certified family (NOT success, NOT failure)
- `device_detection_failure_total` — transport failures AND policy refusals; `failureReasons` gives the per-registry-code split (bounded: 32 named keys + `_other`)
- `device_detection_host_key_mismatch_total` — subset of failures (independent counter)
- `device_detection_duration_seconds` — SECONDS on the wire (ms internally); count/sum/min/max/avg full-lifetime, p50/p95 over a bounded 1024-sample recent window; observed ONLY for invocations that pass the pre-probe refusal gates (refusals never enter the latency distribution)
- `not-attempted` (no credential / stage not requested) is counted in requests and in NEITHER success nor failure — except an invocation whose REQUESTED address stage failed, which is a failure with its resolution code (e.g. `DNS_NOT_FOUND`)

Read surface: **GET `/api/v1/metrics/detection`**, gated by `metrics.read` (operator + engineer + manager; admin wildcard). The payload is EXACTLY `{ metrics: snapshot }` — aggregates only, structurally incapable of echoing hostnames/credential ids/fingerprints. Per-instance honesty: the snapshot stamps `since` (process boot) — a multi-instance fleet is never read as one aggregate; fleet-wide time series remains the monitoring plane's job (owner-side, CI-001).

## 4. Live wire matrix (real app :3000 + real worker :3030 + real SSH persona harness)

Counter baseline was zero (fresh process). Six-case matrix through the real stack (IOS persona harness on 127.0.0.1:2222, TCP-forwarded onto 21.0.17.144:2222 so the target passes the target policy as a public literal):

| Case | Wire result | Counter effect |
|---|---|---|
| A unauthenticated POST | 401 at the proxy gate (pre-route) | none — never reached the route (the route-level refusal is proven in case G) |
| B full detect (cisco persona) | 200 — `outcome: matched`, cisco WS-C2960X-24TS-L, `hostKeyState: capture-requested`, address resolved, contract v1 | requests+1, success+1, duration+1 |
| C loopback target | 403 `TARGET_NOT_ALLOWED` | requests+1, failure+1 (`TARGET_NOT_ALLOWED`) |
| D unknown credential id | 404 `CREDENTIAL_UNRESOLVED` | requests+1, failure+1 (`CREDENTIAL_UNRESOLVED`) |
| E wrong host-key pin (DB-seeded wrong fingerprint, deleted after) | 200 envelope, `outcome: failed`, `code: HOST_KEY_MISMATCH`, `hostKeyState: pinned` | requests+1, failure+1 (`HOST_KEY_MISMATCH`), host_key_mismatch+1, duration+1 |
| F address-only, DNS blackhole | 200 envelope — vendor `skipped-not-requested`, `addressCode: DNS_NOT_FOUND` | requests+1, failure+1 (`DNS_NOT_FOUND`), duration+1 |
| G valid manager session (lacks `device.detect`) | 403 `PROBE_NOT_AUTHORIZED` from the ROUTE (proxy passed the valid session) + `DEVICE_PROBE_AUTH_REFUSED` row with the real actor (`usr-manager1`, `RBAC_FORBIDDEN`) | requests+1, failure+1 (`PROBE_NOT_AUTHORIZED`) |

Final absolute counters (read back through the endpoint as admin):

```json
{
  "device_detection_requests_total": 6,
  "device_detection_success_total": 1,
  "device_detection_failure_total": 5,
  "device_detection_vendor_unknown_total": 0,
  "device_detection_host_key_mismatch_total": 1,
  "device_detection_duration_seconds": {"count": 3, "sum": 0.139, "min": 0.012, "max": 0.114, "avg": 0.046, "p50": 0.013, "p95": 0.104, "last": 0.012},
  "failureReasons": {"CREDENTIAL_UNRESOLVED": 1, "DNS_NOT_FOUND": 1, "HOST_KEY_MISMATCH": 1, "PROBE_NOT_AUTHORIZED": 1, "TARGET_NOT_ALLOWED": 1}
}
```

Every number matches the documented semantics exactly — duration count (3) excludes the three refusal cases (C, D, G) and includes the three stage-running invocations (B, E, F); the mismatch counter is a subset of failures; the reason split is exact.

Audit read-back through `/api/v1/events`:
- `DEVICE_PROBE_AUTH_REFUSED` — `{actorId: "usr-manager1", actorName: "Salma Al-Attar", result: FAILURE, afterJson: {requestedHost, permission: "device.detect", reason: "RBAC_FORBIDDEN"}}`
- latest `DEVICE_VENDOR_AUTODETECTED` `afterJson` (case F) — full T070 evidence on the wire: `actorId`, `correlationId`, `tenant: null`, `outcome: "not-attempted"`, `durationMs: 12`, `requestedStages: ["address"]`, `resolutionErrorCode: "DNS_NOT_FOUND"`, `contractVersion: 1`, plus all inventory/attribution fields.

## 5. Browser journey (agent-browser)

Sign-in gate → admin sign-in → dashboard (live widgets, 3 unread notifications) → Devices → Add Device → 21.0.17.144 + `R50.4 Harness` credential → **Detect** → vendor auto-filled to "Cisco Systems" (the R50.7 route changes did not disturb the golden path). In-page `fetch('/api/v1/metrics/detection')` with the session cookie returned the live snapshot: requests 7, success 2 (the UI detection moved both counters by exactly +1), durationCount 4. 0 page errors, 0 console errors; desktop 1280 no horizontal scroll; footer present; mobile 390×844 no horizontal scroll. Screenshots: `agent-ctx/verify-r507-{dashboard,detect-ui,mobile}.png`.

## 6. Tests

NEW `tests/audit/r50-operational-telemetry.test.ts` — 28 pins:
- the six roadmap names verbatim, BIDIRECTIONAL with the roadmap §9 R50-T072 block (every example name is a snapshot key; every snapshot key appears in the roadmap)
- the outcome taxonomy behaviorally (matched / vendor-unknown / not-attempted-in-neither / refusal-with-reason)
- the double-count contract: `recordDetectionFailure` is the ONLY failure_total writer (route pins + module docblock pin)
- mismatch-as-subset counter independence
- duration: ms→seconds units, exact lifetime stats, recent-window p50/p95, ring bound, NaN/negative clamping
- failureReasons bound: 32 named + `_other`, aggregate total never lies, known labels keep incrementing at the cap
- reset is total; `since` stamped and surfaced by the endpoint
- route source pins: T070 evidence keys (actor/correlation/tenant/outcome/duration + all pre-existing fields), all five dedicated refusal events, best-effort helper with 5 call sites, null-actor design, credential reasons, rate-limit counted-not-audited, response contract unchanged (contract version still 1)
- endpoint pins: `metrics.read` gate, payload is exactly the snapshot, `authErrorToFail` envelope, `metrics.read` is a real matrix permission

Gates on the exact tree (CI env shape, `.env` stash/restore discipline): lint 0 · tsc 0 · suite 783 → **811 pass / 12 skip / 0 fail** (4,275 expects, 46 files).

## 7. Honest scope

- Counters are per-instance, process-lifetime — fleet-wide aggregation/retention is the monitoring plane's job (documented in the snapshot's `since` + endpoint meta; owner-side CI-001).
- Remote CI remains platform-blocked since 27e0eea (OWNER-CI-001) — no Actions run for this push; the release gate remains the local loop.
- The unauthenticated-refusal route path is implemented and pinned but NOT reachable live end-to-end (the proxy gate refuses unauthenticated `/api/v1` mutations first — defense in depth); the RBAC-refusal path IS live-proven (case G).
- `vendor-unknown` was exercised by unit tests only (no live unknown-CLI endpoint in the sandbox); the live matrix covered matched/failed/refused/not-attempted.
- Real-device certification (R50-T090..T092) remains lab/owner-side.
