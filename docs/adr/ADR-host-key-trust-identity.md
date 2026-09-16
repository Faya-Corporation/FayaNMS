# ADR — Canonical Host-Key Trust Identity (R50-T012)

**Status:** Accepted (2026-09-16, branch `z_ai_v2`)
**Context findings:** R50-003 (P1, CONFIRMED — DNS health silently changes SSH trust semantics), R50-001 (P0, FIXED — fail-closed trust resolution)
**Supersedes:** the implicit per-surface identity choices documented in the R50 verdict §3 R50-003.

---

## 1. Context

FayaNMS enrolls SSH host keys in the known_hosts model: ONE pinned key per
endpoint (`SshHostKey`, host + port). The worker verifies the presented key
pre-authentication against the FINGERPRINT. Every LIVE connection is
fail-closed: unpinned connections are refused unless the caller explicitly
opts into the audited first-contact capture (`enrollHostKey === true`).

The R50 audit surfaced the identity question behind that model: several
surfaces looked the pin up against DIFFERENT identifiers for the same device:

| Surface | Identity used before this ADR |
|---|---|
| `devices/test-connection` | `device.mgmtIp` + port |
| `worker/claim` (job payloads) | `device.mgmtIp` + port |
| `worker/change-step` | device configured `host` + credential port |
| `devices/auto-detect` (R50) | `resolution.mgmtIp ?? host` — **DNS-health-dependent** |

The auto-detect variant was the defect: when DNS failed (a routine, typed
non-exceptional outcome), `probeTarget` silently became the HOSTNAME, so an
endpoint enrolled under its management IP probed as first contact — capture
mode on an enrolled endpoint, with a perfectly healthy enrollment store. DNS
health was deciding SSH trust semantics.

## 2. Decision

1. **Canonical identity = the exact connection endpoint string + port.**
   Trust is keyed by the identifier of the endpoint a connection is actually
   dialed with — the OpenSSH known_hosts semantic. No normalized, resolved,
   or otherwise derived address participates in a trust decision.

2. **Detection probes (auto-detect) bind the connection to the REQUESTED
   endpoint before any DNS is consulted** (R50-T013). The probe's trust
   identity is `requestedHost + credentialPort` — the exact string the
   worker dials (`connectionAddress`). `resolveHostToIp` runs ONCE, AFTER
   detection, and is purely informational for the form
   (`resolvedManagementIp`); it can never retarget the probe, and DNS health
   cannot flip the trust path (the R50-003 kill).

3. **Device-plane surfaces keep their certified identities** —
   `device.mgmtIp` + port for test-connection and job payloads, the device's
   configured `host` + credential port for change steps. Those surfaces
   reference a PERSISTED device record whose identity fields are explicit
   and operator-managed; this ADR does not change them (zero regression to
   certified behavior).

4. **Enrollment is an explicit, audited operator action per endpoint string.**
   Operators are expected to enroll (and be shown, R50-T063) the SAME
   identifier they will operate the device with.

## 3. Consequences

- **Deterministic semantics per invocation:** the same request always
  produces the same trust lookup — no environmental flip.
- **Cross-identifier probing presents as first contact:** probing an enrolled
  device BY A DIFFERENT IDENTIFIER (e.g. hostname while enrolled under its
  mgmtIp) is an audited first-contact capture, exactly like SSH's own
  known_hosts prompt. The presented fingerprint is returned for out-of-band
  verification; a fingerprint that does NOT match the enrolled key under the
  other identity is the MITM signal. This is accepted residual behavior, not
  a defect (documented, deterministic, audited).
- **Silent re-resolution is structurally impossible** on the detection path:
  the connection target never comes from DNS in the first place
  (R50-T013).
- Future target-policy work (R50-T022/T023) validates the REQUESTED target
  (and, when introduced, the resolved address as data — never as a trust
  identity).

## 4. Rejected alternatives

- **Resolved-address identity for detection** (`resolution.mgmtIp ?? host`,
  the pre-ADR behavior): DNS-health-dependent trust — the R50-003 finding.
  Rejected.
- **Dual lookup** (try requested host AND resolved address, prefer any hit):
  reintroduces the DNS dependency into the trust path and creates an
  ambiguity about WHICH pin verifies the connection when the two identities
  hold different keys. Rejected.
- **Device-UUID-keyed enrollment:** a detection probe has no device record
  yet (form helper); a UUID identity would force enrollment to happen only
  post-creation, breaking the documented first-contact workflow. Rejected.

## 5. Enforcement

- Executable pins: `tests/audit/r50-trust-failclosed.test.ts` (trust
  resolution precedes the worker fetch; pin derives only from the trust
  state) and `tests/audit/vendor-detect.test.ts` (vendor-first stage order;
  single resolution call after detection; `host: connectionAddress` in the
  worker payload; requestedHost/connectionAddress/resolvedManagementIp in
  the response contract).
- The route's stage comments and the audit event (`hostKeyState`,
  `credentialProfileId`, `requestedHost`, `connectionAddress`) keep the
  decision observable in production evidence.
