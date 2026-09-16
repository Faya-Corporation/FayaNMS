# FayaNMS — R50-T010/T011/T012/T013 Remediation Evidence (Phase R50.1, vendor-first contract)

**Date:** 2026-09-16
**Branch:** `z_ai_v2`
**Remediates:** R50-002 (P1 — DNS resolves before vendor detection, contradicting every documented surface) and R50-003 (P1 — DNS health silently changes SSH trust semantics); implements roadmap Phase R50.1 (R50-T010, R50-T011, R50-T012, R50-T013).

---

## 1. Verdict of this remediation

**R50-002: FIXED.** The route now runs vendor-FIRST; code, README, form copy, and audit all state and execute the same order.

**R50-003: FIXED.** The trust identity of a detection probe is the REQUESTED ENDPOINT (`requestedHost` + credential port), decided by ADR and enforced by executable pins — DNS health cannot flip trust semantics because DNS is never consulted before the connection target is bound.

Production remains gated on the remaining open P1s (R50-004 IPv6 contract, R50-005 probe permission, R50-006 abuse controls) — Phase R50.2+ work.

## 2. Changes

### R50-T010 — vendor-first workflow (`src/app/api/v1/devices/auto-detect/route.ts`)

Explicit stage order (source-pinned):

```text
1. authorization            requirePermission("config.backup")     (device.detect → R50-T020)
2. target policy            request-schema validation today        (CIDR policy    → R50-T022/T023)
3. credential authorization profile exists + SSH_PASSWORD         (scope enrichment → R50-T021)
4. host-key policy          resolveHostKeyTrustState(connectionAddress, port) — R50-T001 fail-closed wiring unchanged
5. vendor detection         worker /live/detect-vendor, host = connectionAddress
6. hostname resolution      resolveHostToIp(requestedHost) — ONCE, after detection, informational only
7. preview response         additive R50-T011 naming + original fields (UI compatibility)
```

The credential stage moved BEFORE any network activity; DNS is no longer stage 1.

### R50-T011 — three explicit endpoint identities

- `requestedHost` — the operator-typed string (validated by the schema).
- `connectionAddress` — what the worker actually dials; by the ADR decision it EQUALS requestedHost for detection probes (deliberate, commented, pinned).
- `resolvedManagementIp` — the informational DNS mapping (stage 6), plus the kept `mgmtIpResolution` block for UI compatibility.

The response contract gained `requestedHost`, `connectionAddress`, `resolvedManagementIp`, and `hostKeyState` (`not-probed` | `pinned` | `capture-requested`); the audit event gained `credentialProfileId` + `hostKeyState` (groundwork for R50-010/R50-T070 enrichment).

### R50-T012 — canonical host-key identity ADR

`docs/adr/ADR-host-key-trust-identity.md` (NEW): trust is keyed by the exact connection endpoint string + port (known_hosts semantics); detection probes bind the connection to the requested endpoint BEFORE any DNS; device-plane surfaces keep their certified identities (mgmtIp / device host) with zero regression; cross-identifier probing presents as audited first contact (documented residual, mirroring OpenSSH); resolved-address identity and dual-lookup REJECTED with reasons.

### R50-T013 — resolve once, bind, no silent re-resolution

`resolveHostToIp` is called exactly ONCE, after detection; its output is never a fetch input (`host: connectionAddress` pinned); the connection target is bound before any DNS is consulted — silent re-resolution is structurally impossible on this path.

## 3. Test pins (suite 657 → 661; 661 pass / 12 skip / 0 fail; 3,587 expects; lint 0; tsc 0)

`tests/audit/vendor-detect.test.ts` route-contract block extended:

- vendor-first ORDER: authorization < credential < trust < worker fetch < DNS resolution (all five call sites indexed and ordered);
- resolution single-shot (`await resolveHostToIp(` exactly once) and strictly after the fetch; `host: connectionAddress` in the worker payload;
- `requestedHost` / `connectionAddress` / `resolvedManagementIp` explicit in code and response;
- trust identity precedes the fetch; `hostKeyState` + `credentialProfileId` present in the audit payload.

`tests/audit/r50-trust-failclosed.test.ts` (Phase R50.0 matrix) unchanged and still green — the fail-closed wiring survived the reorder.

## 4. Live evidence (sandbox stack, 2026-09-16)

1. **Vendor stage independent of DNS health:** `POST /api/v1/devices/auto-detect` with `host = no-such-host.invalid` (ENOTFOUND) + SSH credential → 200, `vendorStage: "executed"`, `hostKeyState: "capture-requested"`, the worker REACHED over the authenticated control plane, typed `CREDENTIAL_UNRESOLVED` refusal (the honest sandbox state), AND `mgmtIpResolution.mode: "failed"` in the same response — partial-success semantics working exactly as the roadmap's two-stage contract intends.
2. **DNS-only mode:** `host = 127.0.0.1`, no credential → 200, `requestedHost: 127.0.0.1`, `resolvedManagementIp: 127.0.0.1`, `vendorStage: "skipped-no-credential"`, `connectionAddress: null`.
3. **Deployment note:** the sandbox dev server served a stale compiled route module until an explicit restart; the live evidence above is post-restart. No repo implication.

## 5. Disposition

- R50-002 (P1): FIXED. R50-003 (P1): FIXED (ADR + pins + live evidence).
- The doc contradiction the verdict called systemic (README:926 + form copy vs code) is closed: code now matches the promised order, and the README block records the remediation.
- Next authorable phase: R50.2 (authorization & abuse controls, R50-T020..T025).
