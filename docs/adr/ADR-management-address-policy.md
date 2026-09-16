# ADR — Management Address Support Policy: IPv4-Only Inventory Contract (R50-T030)

**Status:** Accepted (2026-09-16, branch `z_ai_v2`)
**Context findings:** R50-004 (P1, CONFIRMED — the resolver's A→AAAA fallback + IPv6-literal passthrough autofill values the inventory contract always rejects)
**Companion tasks:** R50-T031 (typed refusal), R50-T033 (deterministic multi-address selection)
**Related ADR:** `ADR-host-key-trust-identity.md` (probe trust identity — orthogonal: SSH trust keys on the connection endpoint, this ADR governs the inventory field only)

---

## 1. Context

`Device.mgmtIp` is the inventory's canonical management identifier. Every
validated surface of the product already constrains it to IPv4:

| Surface | Enforcement |
|---|---|
| `POST /api/v1/devices` (create) | zod `IPV4_PATTERN` |
| `PATCH /api/v1/devices/[id]` (update) | zod `IPV4_PATTERN` |
| Device form sheet (UI) | zod `IPV4_PATTERN` |
| CSV import (UI + API) | zod `IPV4_PATTERN` |
| Discovery scanner | IPv4 CIDR targets (`a.b.c.d/len`) |

The R50 auto-detect feature broke that alignment from its own success path:
`resolveHostToIp` passed IPv6 literals through as `ip-literal` and fell back
A→AAAA on hostnames, so the Detect button could autofill `mgmtIp` with an
address the form's submit path was guaranteed to reject (finding R50-004 —
a misleading success, not a safety issue).

Dual-stack (the alternative branch of R50-T030) would require re-contracting
ALL of the surfaces above plus shared types, exports, reports, ZTP
templates/provisioning, and an IPv6-capable discovery scanner — a
multi-plane schema change with no operator demand recorded and a much larger
regression surface. The honest, coherent decision is the smaller contract.

## 2. Decision

1. **Management addresses are IPv4-ONLY.** `Device.mgmtIp` accepts exactly
   one IPv4 literal. The existing per-surface `IPV4_PATTERN` validation is
   the contract — it is re-pinned by tests, not weakened.

2. **The resolver enforces the same policy (R50-T031).** `resolveHostToIp`
   refuses IPv6 with a typed result, never a success-shaped value:
   - an IPv6-literal target → `mode: "refused-ipv6-literal"`,
     `resolutionError: IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED` (pre-DNS);
   - an AAAA-only hostname → `mode: "refused-aaaa-only"` with the same
     typed code (the AAAA query is a diagnostic only — it can never
     produce `mgmtIp`);
   - neither family answering → `mode: "failed"` with the A-query DNS code.

3. **Detection is unaffected.** Probes dial the requested endpoint directly
   (R50-T013) and never consult the mapping: an IPv6-reachable device can
   still be fingerprinted; only the INVENTORY mapping is refused.

4. **Deterministic selection (R50-T033).** A multi-address A RRset resolves
   to the numeric-ASCENDING first address (per-octet compare, so
   10.0.0.2 < 10.0.0.20). Resolver RR rotation therefore cannot move a
   device's management address between lookups — the inventory wants a
   stable identifier, not a load-balancing handle.

## 3. Consequences

- The auto-detect form can no longer autofill a submit-doomed value; the
  operator-facing toast names the policy (IPv6 advertised → typed refusal).
- Audits (`DEVICE_VENDOR_AUTODETECTED`) carry `resolutionMode` +
  `resolutionError`, so IPv6 refusals are observable in the audit trail.
- Going dual-stack later is an explicit, re-audited contract change: lift
  this ADR, upgrade every listed surface, and add IPv6 discovery — not a
  resolver-side silent expansion.
- The typed code `IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED` is part of the
  detection API's observable contract (R50-T040/T041 keep it stable).
