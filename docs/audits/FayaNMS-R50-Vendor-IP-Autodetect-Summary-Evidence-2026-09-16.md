# FayaNMS — R50 Summary, Findings Register & Evidence Matrix

**Date:** 2026-09-16  
**Feature:** R50 — Vendor auto-detection + hostname → management IP  
**Implementation commits:** `5e99abd`, `572ba31`

---

# Executive Status

**Implementation:** Present  
**Local automated tests:** Reported green  
**UI wiring:** Verified  
**API → worker wiring:** Verified to credential-resolution stage  
**DNS resolution:** Verified  
**Successful real-device vendor detection:** Not yet certified  
**Hosted CI:** Not certified  
**Security status:** P0 host-key trust issue remains  
**Production status:** **BLOCKED**

---

# Key Conclusion

R50 is substantially implemented, but the reviewed state should not yet be declared production-ready.

Primary blocker:

> a host-key enrollment lookup failure can be converted into the same state as “no enrollment,” potentially enabling first-contact host-key capture when trust state is actually unknown.

Second major contract issue:

> R50 is specified as vendor-first, but the implementation currently resolves hostname/IP before vendor detection.

---

# Findings Register

| ID | Priority | Finding | Status |
|---|---:|---|---|
| R50-001 | P0 | Host-key enrollment lookup can fail open into first-contact capture | Open |
| R50-002 | P1 | DNS executes before vendor detection despite vendor-first requirement | Open |
| R50-003 | P1 | Hostname vs resolved-IP SSH trust identity is undefined | Open |
| R50-004 | P1 | AAAA fallback conflicts with IPv4-only device form validation | Open |
| R50-005 | P1 | Active SSH detection uses broad existing permission boundary | Open |
| R50-006 | P1 | Active probe lacks sufficiently explicit target/rate abuse controls | Open |
| R50-007 | P1 | Successful real LIVE_SSH vendor detection not yet demonstrated | Open |
| R50-008 | P1 | CI run did not execute certification gates successfully | Open |
| R50-009 | P2 | API should expose vendor/DNS partial success independently | Enhancement |
| R50-010 | P2 | Audit event needs richer structured detection evidence | Enhancement |

---

# Requirement-to-Evidence Matrix

| Requirement | Evidence | Result |
|---|---|---|
| Device UI exposes auto-detect control | Detect vendor & IP control present | PASS |
| Empty hostname prevents invocation | Button disabled without hostname | PASS |
| Detection does not automatically save inventory | Workflow remains preview/form based | PASS |
| DNS hostname mapping works | `localhost → 127.0.0.1` verified | PASS |
| API reaches worker | Worker returned typed credential error | PASS |
| Worker errors propagate cleanly | `CREDENTIAL_UNRESOLVED` surfaced | PASS |
| Vendor probe commands are bounded | Fixed probe command list | PASS |
| Vendor-first execution | DNS currently precedes detection | FAIL |
| Existing SSH trust remains fail closed | Enrollment lookup error can become no-pin state | FAIL |
| IPv6 fallback is usable end to end | UI validation remains IPv4-only | FAIL |
| Dedicated probe authorization exists | Existing capability reused | NEEDS DESIGN |
| Target abuse policy is explicit | No sufficient R50-specific proof | NEEDS HARDENING |
| Real SSH device successfully detected | No successful device probe evidence | NOT PROVEN |
| CI gates passed for candidate | Workflow failed/zero-step gate | FAIL |
| Local tests passed | 640 pass / 12 skip / 0 fail reported | LOCAL PASS |

---

# End-to-End Evidence Chain

## Proven path

```text
Devices UI
   ↓
Detect vendor & IP
   ↓
API request
   ↓
hostname resolver
   ↓
localhost → 127.0.0.1
   ↓
credential profile selected
   ↓
worker invocation
   ↓
vault lookup
   ↓
CREDENTIAL_UNRESOLVED
   ↓
typed API error
   ↓
UI toast
```

This proves the integration through credential resolution.

---

# Missing success-path evidence

Still required:

```text
credential profile
   ↓
vault secret resolved
   ↓
host-key enrollment read
   ↓
host-key verified
   ↓
SSH authentication
   ↓
probe command executed
   ↓
vendor parser
   ↓
model/version parser
   ↓
worker result
   ↓
API contract
   ↓
UI autofill
```

---

# Security Gate Matrix

| Security control | Expected | Current R50 assessment |
|---|---|---|
| RBAC | Explicit permission for network probing | Needs hardening |
| Tenant isolation | Target + credential restricted to tenant | Must reverify |
| Credential isolation | Actor authorized to use selected credential | Must reverify |
| Host-key trust | Unknown trust state fails closed | **Fail** |
| SSH command control | Fixed read-only probes | Pass |
| Target control | Only authorized network destinations | Needs hardening |
| SSRF defense | Special/internal targets policy enforced | Needs hardening |
| Rate limiting | Probe abuse bounded | Needs hardening |
| Auditability | Every attempt reconstructable | Partial |
| Secret leakage | No raw vault secret in result | No issue identified |
| Inventory mutation | Explicit save required | Pass |

---

# Tests that should be added before production

## Host-key trust

```text
DB failure ≠ not enrolled
DB timeout → connection not attempted
host key mismatch → authentication never starts
```

## Authorization

```text
viewer denied
operator policy explicitly tested
network admin allowed
foreign-tenant credential denied
foreign-tenant target denied
```

## Target safety

```text
localhost
link-local
metadata service
multicast
unapproved private subnet
approved management subnet
DNS rebinding
```

## IPv6

```text
AAAA-only hostname
dual-stack hostname
IPv4-only configured policy
IPv6 enabled policy
```

## Real worker

```text
Cisco success
Fortinet success
HPE success
Juniper success
Palo Alto success
generic/unknown result
```

---

# Release Blockers

1. Fix fail-open host-key trust lookup.
2. Align implementation with vendor-first R50 semantics.
3. Approve and implement probe authorization and target policy.
4. Resolve IPv6 contract inconsistency.
5. Prove a complete successful LIVE_SSH detection.
6. Obtain a successful CI run for the exact release candidate.

---

# Recommended Immediate Next Tasks

1. **R50-T001:** fail-closed host-key enrollment lookup.
2. **R50-T010:** split detection into explicit vendor and DNS stages.
3. **R50-T012:** define hostname/IP trust identity.
4. **R50-T020:** introduce `device.detect` or equivalent permission.
5. **R50-T022:** introduce target network policy.
6. **R50-T030:** resolve IPv4/IPv6 policy.
7. **R50-T040:** formalize partial-success response contract.
8. **R50-T090:** run real-device certification.
9. **R50-T100:** fix CI runner/gate execution.
10. **R50-T103:** perform independent final re-audit.

---

# Production Acceptance Checklist

### Trust and security

- [ ] Host-key database errors fail closed.
- [ ] First-contact capture requires confirmed absence of enrollment.
- [ ] Fingerprint mismatch blocks authentication.
- [ ] Active probe has explicit RBAC capability.
- [ ] Credential use is independently authorized.
- [ ] Destination network scope is enforced.
- [ ] Probe rate limits are enabled.

### Functional behavior

- [ ] Vendor detection stage occurs first.
- [ ] DNS/address mapping occurs second.
- [ ] Partial success is represented correctly.
- [ ] Existing form values are not silently overwritten.
- [ ] IPv4/IPv6 behavior matches documented support.

### Evidence

- [ ] Real Cisco probe verified.
- [ ] Real Fortinet probe verified.
- [ ] Real HPE/Aruba probe verified.
- [ ] Real Juniper probe verified.
- [ ] Real Palo Alto probe verified.
- [ ] Unknown/generic target verified.
- [ ] UI success path verified.
- [ ] UI error path verified.

### Engineering gates

- [ ] Lint passes in CI.
- [ ] Typecheck passes in CI.
- [ ] Full tests pass in CI.
- [ ] Security/drift gates pass in CI.
- [ ] Build gate passes in CI.
- [ ] Browser/E2E passes.
- [ ] Exact candidate SHA recorded.
- [ ] No unresolved P0/P1 R50 finding.

---

# Final Summary

R50 is a valuable addition to FayaNMS and is close to a strong operator workflow.

The implementation already demonstrates:

```text
UI
+ API
+ resolver
+ credentials
+ worker
+ LIVE_SSH architecture reuse
+ vendor parser
+ typed error propagation
+ audit hooks
```

The remaining work is concentrated in production hardening rather than a complete redesign.

**Final audit status: R50 implemented, but not production-certified. P0 trust remediation and P1 hardening/certification tasks remain.**
