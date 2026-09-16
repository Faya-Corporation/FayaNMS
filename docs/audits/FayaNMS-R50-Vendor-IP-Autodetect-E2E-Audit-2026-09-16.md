# FayaNMS — R50 Vendor & Management IP Auto-Detection End-to-End Audit

**Review date:** 2026-09-16  
**Feature:** R50 — Auto-detect network vendor first when available, then map hostname → management IP  
**Repository:** FayaNMS  
**Reviewed implementation commits:** `5e99abd` + `572ba31`  
**Review mode:** Independent end-to-end re-audit of implementation, contracts, security boundaries, UI behavior, tests, CI evidence, and LIVE_SSH integration  
**Primary plane:** Certified `LIVE_SSH` execution plane  
**Status:** **NOT YET PRODUCTION-CERTIFIED**

---

# 1. Executive Summary

R50 introduces a useful network-onboarding capability:

1. probe a device over SSH,
2. infer its network vendor,
3. resolve its hostname,
4. populate management IP,
5. optionally populate model and vendor information,
6. expose the workflow through the Add/Edit Device UI.

The implementation establishes most of the required plumbing across:

- web UI,
- React query hooks,
- API routes,
- DNS resolution,
- credential profiles,
- host-key handling,
- worker RPC,
- LIVE_SSH execution,
- vendor fingerprint parsing,
- audit events,
- typed errors,
- tests.

However, the independent re-audit identified several production-impacting issues.

The most serious issue is a **host-key trust downgrade path**: an error reading an existing host-key enrollment may be caught and treated the same as “no host key enrolled.” That changes a fail-closed trust lookup into first-contact capture behavior.

The implementation also does not currently satisfy the stated R50 execution order. The API resolves the hostname before invoking vendor detection, while the feature requirement explicitly specifies:

> auto-detect vendor first when available, then map hostname → management IP.

Other gaps include an IPv6 contract inconsistency, active-probe authorization questions, insufficient abuse controls around the new SSH probe capability, CI that did not actually execute the repository gates, and lack of successful evidence against a real SSH network device.

R50 should therefore be considered **functionally implemented but security- and certification-blocked** until the P0/P1 findings below are resolved and independently reverified.

---

# 2. Intended R50 Behavior

The desired workflow is:

```text
Operator enters hostname
        │
        ▼
Select credential profile
        │
        ▼
Attempt vendor detection over LIVE_SSH
        │
        ├── Vendor available
        │      ├── fingerprint vendor
        │      ├── derive model/version
        │      └── return evidence
        │
        └── Vendor unavailable
               └── continue gracefully
        │
        ▼
Resolve hostname → management IP
        │
        ▼
Populate UI fields for human review
        │
        ▼
User explicitly saves device
```

The detection operation itself must remain non-mutating.

---

# 3. Implemented Architecture

The reviewed implementation broadly follows this flow:

```text
Devices UI
   │
   ▼
useDetectVendor / device API client
   │
   ▼
FayaNMS API
   │
   ├── DNS resolution
   │
   ├── credential-profile lookup
   │
   ├── enrolled host-key lookup
   │
   └── worker request
   │
   ▼
Worker /live/detect-vendor
   │
   ▼
LIVE_SSH
   │
   ├── show version
   ├── show system info
   └── get system status
   │
   ▼
vendor fingerprint parser
   │
   ▼
typed detection result
   │
   ▼
API response
   │
   ▼
UI preview/autofill
```

Vendor families included by the implementation include:

- Cisco
- Fortinet
- HPE
- Juniper
- Palo Alto
- Sophos/generic handling
- Generic fallback

The worker uses read-oriented probe commands rather than device configuration commands.

---

# 4. Positive Findings

## 4.1 Detection is separated from persistence

R50 does not automatically create or modify inventory records when detection executes.

That is the correct UX and control-plane behavior.

The user can inspect detected values before submitting the device form.

## 4.2 LIVE_SSH remains worker-owned

The API does not directly establish SSH sessions.

The existing architecture remains:

```text
Web
  → API/control plane
      → authenticated worker
          → LIVE_SSH
```

This preserves the worker as the controlled execution boundary for:

- SSH credentials,
- host-key verification,
- device commands,
- network access.

## 4.3 Probe commands are bounded

The detection implementation uses a small known probe set rather than accepting arbitrary commands from the API caller.

This significantly reduces command-injection and arbitrary-command exposure.

## 4.4 Typed failure propagation exists

The live verification demonstrated that a missing vault secret produced a typed:

`CREDENTIAL_UNRESOLVED`

failure instead of a generic HTTP 500.

That is desirable behavior.

## 4.5 DNS resolution is typed

Hostname lookup failures are represented as structured failures rather than uncaught resolver exceptions.

IP literals also bypass unnecessary DNS lookup.

## 4.6 Vendor parser has dedicated test coverage

The R50 implementation added parser tests and other focused regression coverage.

The reported local suite reached:

- 640 passing
- 12 skipped
- 0 failing

This is useful local evidence, although CI certification remains unresolved.

---

# 5. Findings

## R50-001 — Host-Key Enrollment Lookup Can Fail Open

**Severity:** P0 / Critical  
**Category:** SSH trust / authentication / security boundary  
**Production blocker:** Yes

### Observation

The existing host-key helper is designed around fail-closed trust semantics.

For a previously enrolled target, the expected behavior is:

```text
host-key enrollment lookup succeeds
        │
        ├── enrolled pin found
        │      └── verify presented key exactly
        │
        └── no enrollment exists
               └── first-contact capture policy
```

The R50 path catches enrollment-store lookup errors and can convert them into:

```text
pin = null
```

The downstream LIVE_SSH path interprets absence of a pin as first-contact behavior.

### Risk

An infrastructure error such as:

- database unavailable,
- database timeout,
- enrollment table access failure,
- unexpected persistence error,

must not be semantically equivalent to:

> this target has never been enrolled.

Otherwise, a previously trusted endpoint can accidentally enter host-key capture mode.

That weakens SAFE-001 trust semantics.

### Required remediation

Remove broad catch-and-null handling around host-key lookup.

Recommended contract:

```ts
type HostKeyLookupResult =
  | { status: "ENROLLED"; fingerprint: string }
  | { status: "NOT_ENROLLED" }
  | { status: "LOOKUP_FAILED"; code: string };
```

`LOOKUP_FAILED` must abort detection before connecting.

### Acceptance criteria

- DB outage cannot trigger first-contact capture.
- Unexpected enrollment-store errors fail closed.
- `NOT_ENROLLED` is the only state that can enable capture.
- Tests cover pin exists, pin absent, DB timeout, DB connection failure, malformed enrollment record.
- Detection produces no outbound SSH connection after a host-key-store failure.

## R50-002 — Actual Execution Order Conflicts With R50 Requirement

**Severity:** P1 / High  
**Category:** Feature contract / architecture  
**Production blocker:** Yes for R50 acceptance

The API currently performs DNS resolution before vendor detection, despite the vendor-first requirement.

### Required remediation

Implement explicit stages:

```text
Stage A — vendor detection
Stage B — hostname resolution
```

Preserve both requested host and resolved connection address.

## R50-003 — Host-Key Identity and Resolved-IP Identity Need Explicit Semantics

**Severity:** P1 / High  
**Category:** SSH trust / DNS / identity  
**Production blocker:** Yes

Define whether trust is enrolled against hostname, IP, device identity, or a combination. Do not silently change trust identity from hostname to resolved IP.

## R50-004 — IPv6 Resolver Support Conflicts With Device Form Validation

**Severity:** P1 / High  
**Category:** API/UI contract  
**Production blocker:** Yes for advertised AAAA support

The resolver advertises AAAA fallback while the management-IP form remains IPv4-only.

Resolve this by either full IPv6 support or explicit IPv4-only behavior with a typed unsupported result.

## R50-005 — Active SSH Detection Uses a Broad Existing Permission

**Severity:** P1 / High  
**Category:** Authorization / RBAC  
**Production blocker:** Yes pending policy decision

Introduce a dedicated capability such as `device.detect` or `device.probe` and enforce it server-side.

## R50-006 — Active Probe Surface Needs Explicit Abuse Controls

**Severity:** P1 / High  
**Category:** SSRF / scanning / abuse prevention

Add target policies and rate limits covering loopback, link-local, metadata endpoints, multicast, DNS rebinding, and tenant-scoped network ranges.

## R50-007 — Successful LIVE_SSH Vendor Detection Has Not Yet Been Proven

**Severity:** P1 / High  
**Category:** Certification / integration evidence

The chain is proven through credential resolution, but not through successful SSH authentication, command execution, parser result, and UI autofill against a real device.

## R50-008 — CI Did Not Certify the Implementation

**Severity:** P1 / High  
**Category:** SDLC / release evidence

The observed workflow run ended in failure and the gate job executed zero steps. Local gate success is not equivalent to CI certification.

## R50-009 — Detection Result Semantics Should Separate Partial Success

**Severity:** P2 / Medium  
**Category:** API contract / UX

Represent vendor detection and address resolution as independent stage results.

## R50-010 — Audit Event Should Carry More Structured Evidence

**Severity:** P2 / Medium  
**Category:** Auditability

Expand `DEVICE_VENDOR_AUTODETECTED` with non-secret structured evidence such as requested host, resolved address, credential profile ID, host-key state, vendor/model/version, outcome, duration, error code, actor, tenant, and correlation ID.

---

# 6. Security Boundary Review

R50 crosses:

```text
browser
  ↓
authenticated API
  ↓
RBAC
  ↓
target validation
  ↓
credential authorization
  ↓
host-key trust
  ↓
worker service authentication
  ↓
SSH network boundary
  ↓
remote device
```

The production design must fail closed at each transition.

---

# 7. Recommended Final State

```text
POST /devices/detect
        │
        ├── authorize device.detect
        ├── validate tenant target policy
        ├── authorize credential profile
        ├── determine host-key trust identity
        ├── fail closed if trust lookup fails
        ▼
Vendor detection stage
        ▼
Hostname resolution stage
        ▼
Return preview only
        ▼
Human review
        ▼
Separate device create/update
```

---

# 8. Production Gate

R50 should not receive final production certification until:

- [ ] host-key lookup fails closed,
- [ ] vendor-first semantics are implemented or requirement is formally changed,
- [ ] hostname/IP host-key identity semantics are defined,
- [ ] IPv6 contract mismatch is resolved,
- [ ] dedicated active-probe authorization policy is implemented,
- [ ] target/rate abuse controls are implemented,
- [ ] real successful LIVE_SSH vendor detection is demonstrated,
- [ ] exact candidate commit passes CI,
- [ ] new security cases have regression tests,
- [ ] documentation matches implementation,
- [ ] audit event schema supports incident reconstruction.

---

# 9. Final Assessment

R50 has a sound functional foundation and strong reuse of the existing worker/LIVE_SSH plane.

Its current blockers are concentrated in trust semantics, authorization, contract consistency, abuse controls, and release evidence.

**Current state: IMPLEMENTED / SECURITY HARDENING REQUIRED / CI CERTIFICATION PENDING.**
