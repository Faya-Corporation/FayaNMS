# FayaNMS — R50.4 Detection API Contract (R50-T040 / R50-T041 / R50-T042) — Evidence

**Date:** 2026-09-16 (Asia/Riyadh) · **Branch:** `z_ai_v2` · **Scope:** Phase R50.4 — typed detection API contract for `POST /api/v1/devices/auto-detect`
**Verdict:** **LANDED** — all three tasks implemented, suite green (723 pass / 12 skip / 0 fail), LIVE end-to-end evidence through the real app + real worker + a real SSH harness endpoint, browser UI journey verified.

---

## 1. What the roadmap required

| Task | Requirement (roadmap §6) | Where it landed |
|---|---|---|
| R50-T040 | Return partial results explicitly — independent vendor-detection and address-resolution status blocks | `src/app/api/v1/devices/auto-detect/route.ts` — `vendorDetection` + `addressResolution` blocks in the success envelope |
| R50-T041 | Add stable typed error codes (the recommended 15) | `src/lib/net/detection-contract.ts` — closed registry `DETECTION_ERROR_CODES` + pure mappers |
| R50-T042 | Version the contract — shared types, API spec, SDK, contract tests | `DETECTION_CONTRACT_VERSION = 1` stamped in data AND meta (success AND error envelopes); client `AutoDetectResult` updated; `tests/audit/r50-detection-contract.test.ts` |

## 2. The contract (R50.4, version 1)

### 2.1 Stage blocks (R50-T040 — partial results)

Every 200 answer carries TWO independent blocks; the pre-R50.4 flat fields are all retained (UI compatibility; the flat `error` keeps its vendor-stage semantics):

```jsonc
{
  "contractVersion": 1,                    // R50-T042 (also in meta)
  "vendorDetection": {                     // vendor stage — independent
    "status": "skipped-no-credential | executed",
    "outcome": "matched | generic | failed | not-attempted",
    "code": "<registry code | null>",      // null = nothing to report
    "message": "<raw transport detail | null>",
    "detection": { "vendorKey", "confidence", "model", "osVersion", "evidence[]" } | null,
    "probeCommand", "latencyMs", "hostKeyState", "hostKeyCaptured"
  },
  "addressResolution": {                   // DNS stage — independent
    "status": "resolved | refused | failed",
    "code": "<registry code | null>",
    "message": "<DNS errno / resolver refusal | null>",   // diagnostic; code is the contract
    "mgmtIp": "…| null", "mode": "<resolver mode>"
  },
  "errorCode": "<vendor stage's code ?? resolution stage's code>"  // R50-T041 top level
  // …every pre-R50.4 flat field unchanged: host, requestedHost, connectionAddress,
  //   mgmtIpResolution, resolvedManagementIp, vendorStage, hostKeyState, detection,
  //   detected, probeCommand, latencyMs, hostKeyCaptured, error
}
```

Partial results are the point: a matched vendor with a failed DNS (and the inverse) is reported as what it is — never collapsed into one boolean.

### 2.2 The registry (R50-T041)

`DETECTION_ERROR_CODES` (closed, in `src/lib/net/detection-contract.ts`) — the roadmap's recommended 15 verbatim:

`PROBE_NOT_AUTHORIZED` · `CREDENTIAL_NOT_AUTHORIZED` · `CREDENTIAL_UNRESOLVED` · `HOST_KEY_ENROLLMENT_LOOKUP_FAILED` · `HOST_KEY_MISMATCH` · `HOST_KEY_UNENROLLED` · `TARGET_NOT_ALLOWED` · `DNS_NOT_FOUND` · `DNS_TIMEOUT` · `IPV6_UNSUPPORTED` · `SSH_CONNECT_TIMEOUT` · `SSH_AUTH_FAILED` · `SSH_COMMAND_REJECTED` · `VENDOR_UNKNOWN` · `DEVICE_PROBE_RATE_LIMITED`

plus the six documented additions the two planes genuinely produce: `SSH_UNREACHABLE` · `SSH_SESSION_FAILED` · `DNS_LOOKUP_FAILED` · `WORKER_UNAVAILABLE` · `WORKER_REJECTED` · `INVALID_BODY`.

Governance: ADDING a code is additive; RENAMING/REMOVING one is breaking and MUST bump `DETECTION_CONTRACT_VERSION`. Transport strings and DNS errnos NEVER become codes — the mappers translate:

- `mapWorkerErrorToDetectionCode` — `SSH_TIMEOUT→SSH_CONNECT_TIMEOUT`, `SSH_EXEC_FAILED→SSH_COMMAND_REJECTED`, `SSH_HOSTKEY_MISMATCH→HOST_KEY_MISMATCH`, `SSH_HOSTKEY_UNENROLLED→HOST_KEY_UNENROLLED`, `CREDENTIAL_REF_INVALID/VAULT_*/CREDENTIAL_UNRESOLVED→CREDENTIAL_UNRESOLVED`, `DETECT_NO_OUTPUT→VENDOR_UNKNOWN`, route fallbacks→`WORKER_UNAVAILABLE`/`WORKER_REJECTED`; unknown worker strings share the honest `WORKER_REJECTED` bucket (raw text preserved in `message`).
- `mapResolutionToContractCode` — `refused-ipv6-literal`/`refused-aaaa-only → IPV6_UNSUPPORTED` (the resolver's `IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED` literal stays resolver-internal and UI-pinned from R50.3); `ENOTFOUND/EMPTY_ANSWER/ENODATA→DNS_NOT_FOUND`; `EAI_AGAIN/ETIMEOUT→DNS_TIMEOUT`; else `DNS_LOOKUP_FAILED`; a produced mapping reports `null`.

Route refusals now answer registry codes end to end: `PROBE_NOT_AUTHORIZED` (401/403 preserved), `CREDENTIAL_UNRESOLVED` (404, was `CREDENTIAL_PROFILE_NOT_FOUND`), `CREDENTIAL_NOT_AUTHORIZED` (403, was `DETECT_CREDENTIAL_TYPE_UNSUPPORTED`), `TARGET_NOT_ALLOWED` (403), `DEVICE_PROBE_RATE_LIMITED` (429), `HOST_KEY_ENROLLMENT_LOOKUP_FAILED` (503), `INVALID_BODY` (400). Every refusal envelope is stamped `meta.contractVersion: 1` (new shared `failWithMeta` helper in `src/app/api/v1/_lib/api.ts`; other routes untouched).

### 2.3 Versioning (R50-T042)

- `data.contractVersion` AND `meta.contractVersion` on every 200; `meta.contractVersion` on every refusal of this route.
- Client shared type `AutoDetectResult` (the app's API layer — the repo has no separate SDK package) carries the typed blocks as OPTIONAL fields, so older servers stay assignable; operator toasts/copy are keyed on the STABLE codes (`DETECTION_CODE_OPERATOR_HINTS` / `RESOLUTION_CODE_OPERATOR_HINTS`), never on transport strings.
- Audit: `DEVICE_VENDOR_AUTODETECTED` records `detectionErrorCode`, `resolutionErrorCode`, `contractVersion` next to the existing fields (R50-070 groundwork).

## 3. Verification

### 3.1 Gates (exact deployed tree)

| Gate | Result |
|---|---|
| `bun run lint` | 0 problems |
| `bunx tsc --noEmit` | 0 errors |
| `bun test tests/` (CI env shape, root `.env` stashed) | **723 pass / 12 skip / 0 fail**, 3,883 expects, 43 files (suite 696 → 723) |

New pins: `tests/audit/r50-detection-contract.test.ts` (27 tests — registry-closed set + roadmap-doc↔code literal match, full worker/DNS mapper matrices, partial-results structure, version stamping incl. error envelopes, legacy-field retention, client typed-code copy). One legacy source pin updated for the new spelling (R50-T003 "return fail(" → `/return fail(WithMeta)?\(/` — same fail-closed abort semantics, now contract-stamped).

### 3.2 LIVE E2E — nine-case matrix (real app :3000, real worker :3030, REAL IOS SSH harness persona)

Harness: `mini-services/worker/harness/ios-sshd.ts` persona (genuine SSH handshake, ed25519 host key, `netadmin`/vault-resolved password), loopback-bound with a bun TCP forwarder onto the sandbox's non-loopback address (`21.0.17.144:2222` → `127.0.0.1:2222`) so the target passes the R50-T022 target policy as a `public` class literal. Credential profile `cred-r504-harness` (SSH_PASSWORD, `vault://ssh/network-admin`, port 2222). Signed in as `admin@faya.local` via the real credentials callback.

| # | Case | Result (wire) |
|---|---|---|
| T1 | harness target, 1st contact (capture) | 200 · `outcome=matched` (`cisco`/high, model `WS-C2960X-24TS-L`, real `show version` evidence) · `hostKeyState=capture-requested` + fingerprint captured · `addressResolution=resolved (ip-literal)` · `errorCode=null` · `contractVersion=1` (data+meta) |
| T2 | harness target, 2nd contact | 200 · matched again (capture ≠ enrollment, per SAFE-001 the key returns for out-of-band verification until enrolled) |
| T3 | `127.0.0.1` | 403 · `error.code=TARGET_NOT_ALLOWED` · `meta.contractVersion=1` |
| T4 | unknown profile id | 404 · `CREDENTIAL_UNRESOLVED` · stamped |
| T5 | `cred-fgt-api` (API_TOKEN) | 403 · `CREDENTIAL_NOT_AUTHORIZED` · stamped |
| T6 | unroutable literal `203.0.113.77` + credential | 200 · vendor `outcome=failed`, `code=SSH_CONNECT_TIMEOUT` (worker `SSH_TIMEOUT` mapped) · resolution `resolved (ip-literal)` — **partial results**: one stage failed, the other succeeded |
| T7 | `no-such-host-r504.invalid` + credential | 200 · vendor `code=SSH_UNREACHABLE` · resolution `code=DNS_NOT_FOUND (ENOTFOUND)` — **two INDEPENDENT codes in one response** |
| T8 | IPv6 literal, no credential | 200 · vendor `not-attempted` · resolution `refused`, `code=IPV6_UNSUPPORTED` (resolver literal preserved as `message`) · `errorCode=IPV6_UNSUPPORTED` |
| T9 | public literal, no credential | 200 · vendor `skipped-no-credential` · resolution resolved · `errorCode=null` |

### 3.3 Browser journey (agent-browser, 0 console errors/warnings)

Sign-in gate → admin sign-in → Devices → Add Device sheet → hostname `21.0.17.144` + credential `R50.4 Harness — SSH password` → **Detect vendor and management IP** → the sheet auto-filled **Vendor = Cisco Systems** and **Model = WS-C2960X-24TS-L** from the typed blocks (screenshot `agent-ctx/verify-r504-autodetect.png`). Negative path: hostname `2001:db8::10` with no credential → the toast names the POLICY, not a generic DNS failure ("Management IP not mapped: the target advertises IPv6 only …"). In-page fetch (authenticated session) independently confirmed `{errorCode:"SSH_UNREACHABLE", addressResolution.code:"IPV6_UNSUPPORTED"}` — vendor-stage precedence + independent resolution block on the wire. Mobile 390×844: no horizontal scroll, footer present (`agent-ctx/verify-r504-mobile.png`).

## 4. Honest scope

- The error-envelope stamp covers THIS route's refusals (`failWithMeta`); the rest of `/api/v1` keeps the unstamped `fail()` envelope — extending the stamp repo-wide is deliberate future work, not silent drift.
- `VENDOR_UNKNOWN` appears in two honest shapes: a completed generic detection (success envelope, non-failure) and the worker's `DETECT_NO_OUTPUT` (failure block).
- The registry's recommended-15 ↔ roadmap literals are pinned in BOTH directions (code list and the roadmap document) so doc drift fails the gate.
- CI runner capacity (CI-001) and real-device certification remain operator/lab-side; evidence here is the sandbox stack + in-repo harness (real SSH protocol, real transport, contained endpoint).
