# FayaNMS — R50 Vendor & Management IP Auto-Detection Remediation Roadmap

**Date:** 2026-09-16  
**Scope:** R50 production hardening, security remediation, certification, and follow-on enhancements  
**Priority model:** P0 → P1 → P2 → P3

---

# 1. Goal

Move R50 from:

> implemented and locally verified

to:

> fail-closed, policy-governed, independently tested, CI-certified, and verified against real network devices.

---

# 2. Phase R50.0 — Immediate Security Gate

## R50-T001 — Make Host-Key Enrollment Lookup Fail Closed

**Priority:** P0  
**Finding:** R50-001

### Tasks

- Remove broad error swallowing around `getHostKeyPin`.
- Distinguish enrolled, genuinely not enrolled, and lookup failed.
- Do not convert persistence errors into `null`.
- Abort before worker SSH connection on lookup errors.
- Return a typed API error.
- Emit an audit event for trust-store failure.

Suggested error:

```text
HOST_KEY_ENROLLMENT_LOOKUP_FAILED
```

### Tests

```text
existing enrollment → fingerprint passed to worker
no enrollment → capture policy allowed
DB timeout → no worker call
DB connection refused → no worker call
unexpected persistence error → no worker call
```

### Exit gate

No code path may treat unknown trust state as first contact.

## R50-T002 — Add a Trust-State Type

**Priority:** P0

Replace nullable trust semantics with an explicit state object.

## R50-T003 — Add SAFE-001 Regression Guard

**Priority:** P0

Create a dedicated test suite asserting that no persistence or trust-store failure can enable first-contact SSH capture.

---

# 3. Phase R50.1 — Correct the Feature Contract

## R50-T010 — Implement Vendor-First Workflow

**Priority:** P1

Refactor orchestration into explicit stages:

```text
1. authorization
2. target policy
3. credential authorization
4. host-key policy
5. vendor detection
6. hostname resolution
7. preview response
```

## R50-T011 — Preserve Requested Host Separately From Connection Address

Introduce:

```ts
requestedHost
connectionAddress
resolvedManagementIp
```

## R50-T012 — Define Canonical Host-Key Identity

Write an ADR defining whether host-key enrollment is keyed by device UUID, hostname, IP address, normalized target URI, or a combination.

## R50-T013 — Detect DNS Changes Safely

Resolve once, validate against target policy, bind the connection to the validated result, and prevent silent re-resolution during the same request.

---

# 4. Phase R50.2 — Authorization and Abuse Controls

## R50-T020 — Add `device.detect` / `device.probe` Permission

Create a dedicated permission for active probing.

## R50-T021 — Enforce Credential-Profile Authorization

Verify actor → credential profile → tenant → target network scope.

## R50-T022 — Add Target Network Policy

Example:

```ts
{
  allowedCidrs: [...],
  deniedCidrs: [...],
  allowPublicIps: false,
  allowLoopback: false,
  allowLinkLocal: false
}
```

## R50-T023 — Protect Special Addresses

Explicitly govern:

```text
0.0.0.0/8
127.0.0.0/8
169.254.0.0/16
224.0.0.0/4
::/128
::1/128
fe80::/10
ff00::/8
```

## R50-T024 — Add Detection Rate Limits

Rate-limit by user, tenant, target, and credential profile.

## R50-T025 — Add Timeout and Resource Budgets

Bound DNS, TCP, SSH handshake, auth, command execution, total request time, and output size.

---

# 5. Phase R50.3 — IPv4 / IPv6 Contract

## R50-T030 — Decide Management Address Support Policy

Choose full IPv4+IPv6 or explicit IPv4-only support.

## R50-T031 — If IPv4-Only, Remove Misleading AAAA Success

Return a typed `IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED`.

## R50-T032 — If Dual-Stack, Upgrade Device Schema

Review frontend validation, shared types, API schema, DB assumptions, SSH targeting, reports, exports, and telemetry.

## R50-T033 — Multi-Address Selection Policy

Define deterministic handling for multiple A/AAAA records.

---

# 6. Phase R50.4 — Detection API Contract

## R50-T040 — Return Partial Results Explicitly

Return independent vendor-detection and address-resolution status blocks.

## R50-T041 — Add Stable Typed Error Codes

Recommended codes:

```text
PROBE_NOT_AUTHORIZED
CREDENTIAL_NOT_AUTHORIZED
CREDENTIAL_UNRESOLVED
HOST_KEY_ENROLLMENT_LOOKUP_FAILED
HOST_KEY_MISMATCH
HOST_KEY_UNENROLLED
TARGET_NOT_ALLOWED
DNS_NOT_FOUND
DNS_TIMEOUT
IPV6_UNSUPPORTED
SSH_CONNECT_TIMEOUT
SSH_AUTH_FAILED
SSH_COMMAND_REJECTED
VENDOR_UNKNOWN
DEVICE_PROBE_RATE_LIMITED
```

## R50-T042 — Version the Contract

Update shared types, API specification, SDK, and contract tests.

---

# 7. Phase R50.5 — Vendor Fingerprinting Hardening

## R50-T050 — Convert Fingerprints to a Registry

Define per-vendor probe handlers.

## R50-T051 — Preserve Evidence Safely

Bound evidence lines, lengths, total bytes, and sanitize control characters.

## R50-T052 — Add Match Reasons

Return deterministic matched signatures instead of opaque confidence scoring.

## R50-T053 — Test Realistic Fixtures

Cover Cisco IOS/IOS XE/NX-OS, FortiOS, Aruba/HPE, Junos, PAN-OS, and generic SSH outputs.

## R50-T054 — Prevent False Positive Vendor Matches

Add negative fixtures where vendor names appear only in banners, hostnames, descriptions, or unrelated text.

---

# 8. Phase R50.6 — UI/UX Hardening

## R50-T060 — Show Detection as Two Explicit Stages

```text
Detecting vendor...
✓ Cisco Catalyst 9300

Resolving management address...
✓ 10.20.1.10
```

## R50-T061 — Show Partial Success

Keep useful results even when the other stage fails.

## R50-T062 — Never Overwrite User Changes Silently

Require explicit replace/keep semantics.

## R50-T063 — Host-Key First-Contact UX

Show target, resolved address, and fingerprint clearly before enrollment.

## R50-T064 — Add Retry Semantics

Allow stage-specific retry.

---

# 9. Phase R50.7 — Audit and Telemetry

## R50-T070 — Expand `DEVICE_VENDOR_AUTODETECTED`

Add structured non-secret evidence including actor, tenant, requested host, resolved address, credential profile ID, host-key state, vendor/model/version, outcome, error code, duration, and correlation ID.

## R50-T071 — Audit Failed Attempts

Audit authorization refusal, target-policy refusal, host-key mismatch, credential failure, timeout, and unknown vendor.

## R50-T072 — Add Operational Metrics

Examples:

```text
device_detection_requests_total
device_detection_success_total
device_detection_failure_total
device_detection_duration_seconds
device_detection_vendor_unknown_total
device_detection_host_key_mismatch_total
```

---

# 10. Phase R50.8 — Test Matrix

## Unit tests

- hostname resolver
- IP literal handling
- IPv4/IPv6 policy
- vendor parsers
- model extraction
- OS extraction
- error normalization
- target policy

## API tests

- RBAC
- credential authorization
- host-key trust states
- no inventory mutation
- vendor-first order
- partial-success response
- audit event creation
- rate limiting

## Worker tests

- allowlisted commands only
- connect failure
- auth failure
- host-key mismatch
- command rejected
- probe fallback
- output truncation
- timeout behavior

## Security tests

- loopback target
- metadata address
- disallowed subnet
- DNS rebinding
- host-key-store outage
- tenant crossing
- unauthorized credential ID
- rate-limit bypass

## Browser tests

- empty hostname
- no credential selected
- successful detection
- DNS-only success
- vendor-only success
- typed error toast
- field conflict
- loading state
- duplicate click prevention

---

# 11. Phase R50.9 — Real Device Certification

## R50-T090 — Build Controlled Device Matrix

| Vendor | Target | Expected command | Required |
|---|---|---|---|
| Cisco | IOS XE | `show version` | Yes |
| Fortinet | FortiGate | `get system status` | Yes |
| HPE/Aruba | Supported NOS | vendor probe | Yes |
| Juniper | Junos | `show version` | Yes |
| Palo Alto | PAN-OS | `show system info` | Yes |
| Generic | SSH host | fallback | Yes |

## R50-T091 — Verify Full Success Path

Verify browser → API → authorization → credential → vault → worker → host-key verification → SSH → command → parser → response → UI.

## R50-T092 — Verify Unknown Vendor

Unknown-but-valid SSH devices must return controlled generic/unknown behavior without crashing or guessing.

---

# 12. Phase R50.10 — CI and Release Certification

## R50-T100 — Repair CI Runner Availability

The exact production candidate commit must execute all configured jobs.

## R50-T101 — Run Full Gate

Required:

```text
lint
typecheck
unit tests
integration tests
security tests
drift guard
build:gate
API build
worker build
web build
contract checks
browser/E2E
```

## R50-T102 — Attach Evidence to Audit

Record candidate SHA, workflow run ID, runner, timestamps, job statuses, test totals, and artifact hashes where relevant.

## R50-T103 — Final Independent Re-Audit

Repeat the R50 review without relying on task descriptions or commit messages.

---

# 13. Recommended Delivery Order

```text
R50-T001
R50-T002
R50-T003
    ↓
R50-T010
R50-T011
R50-T012
R50-T013
    ↓
R50-T020..T025
    ↓
R50-T030..T033
    ↓
R50-T040..T042
    ↓
R50-T050..T054
    ↓
R50-T060..T072
    ↓
R50-T090..T092
    ↓
R50-T100..T103
```

---

# 14. Definition of Done

R50 is complete only when:

- [ ] trust lookup fails closed,
- [ ] vendor-first semantics are verified,
- [ ] hostname/IP identity is explicit,
- [ ] target policy is enforced,
- [ ] dedicated detection authorization exists,
- [ ] credential authorization is enforced,
- [ ] IPv4/IPv6 behavior is consistent,
- [ ] rate limits exist,
- [ ] partial results are typed,
- [ ] vendor fixtures are comprehensive,
- [ ] real-device detection succeeds,
- [ ] exact candidate commit passes CI,
- [ ] audit evidence is retained,
- [ ] independent re-audit reports no unresolved P0/P1 R50 defect.

**Recommended release gate:** No unresolved P0 or P1 finding.
