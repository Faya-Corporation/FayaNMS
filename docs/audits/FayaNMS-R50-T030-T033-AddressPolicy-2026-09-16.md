# FayaNMS — R50-T030..T033 IPv4 Management-Address Policy (2026-09-16)

Task ID: R50-phase-3 · Agent: Orchestrator (Z.ai Code) · Branch: `z_ai_v2`
Closes: R50-004 (P1 — AAAA fallback / IPv6-literal passthrough vs the IPv4-only form)
Roadmap: `docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md` §5 (Phase R50.3)
Decision record: `docs/adr/ADR-management-address-policy.md`

## What landed

| Task | Delivery |
|---|---|
| R50-T030 (support-policy decision) | ADR `docs/adr/ADR-management-address-policy.md`: `Device.mgmtIp` is **IPv4-ONLY** — the already-validated surfaces (create/update API, form sheet, CSV import UI + API) and the IPv4-CIDR discovery scanner define the contract; dual-stack would be a multi-plane schema change (shared types, exports, reports, ZTP, IPv6 discovery) with no operator demand recorded. |
| R50-T031 (no misleading AAAA success) | `src/lib/dns/resolve-host.ts`: the A→AAAA fallback and the IPv6-literal passthrough are structurally REMOVED. IPv6 literal → `{ mgmtIp: null, mode: "refused-ipv6-literal", resolutionError: IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED }` (pre-DNS). AAAA-only hostname → an honest AAAA diagnostic, then `{ mode: "refused-aaaa-only", ... }` with the same typed code. Neither family → `"failed"` + the A-query DNS code. The typed code is exported (`IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED`). |
| R50-T032 (dual-stack schema upgrade) | NOT TAKEN — the explicit consequence of the T030 decision (documented in the ADR §2/§3; revisiting requires lifting the ADR and re-auditing every listed surface). |
| R50-T033 (multi-address selection policy) | `deterministicIpv4Pick()` — a multi-address A RRset resolves to the numeric-ASCENDING first address (per-octet compare: 10.0.0.2 < 10.0.0.20 < 10.0.1.2). Resolver RR rotation cannot move a device's management address between lookups; a management address is a stable inventory identifier, not a load-balancing handle. |

## Surfaces aligned

- **Resolver** (`src/lib/dns/resolve-host.ts`): mode union is now `ip-literal | dns-a | refused-ipv6-literal | refused-aaaa-only | failed` — `"dns-aaaa"` no longer exists; the AAAA query can never produce `mgmtIp`. Lookup injection switched to the RRset-shaped `resolve4`/`resolve6` contracts (structural fakes, no casts).
- **API route** (`src/app/api/v1/devices/auto-detect/route.ts`): response `mgmtIpResolution.{mode,error}` + audit `resolutionMode`/`resolutionError` carry the typed refusal; the audit trail can count IPv6 refusals (R50-T070 groundwork). Detection is deliberately NOT gated on the address policy — probes dial the endpoint directly (R50-T013) and never consult the mapping.
- **UI** (`src/hooks/api/use-devices.ts`): the operator toast names the policy ("the target advertises IPv6 only — the device inventory requires an IPv4 … management address") instead of a generic DNS failure; the client `AutoDetectResult` type carries the new mode union + the R50-T011 endpoint fields (`requestedHost` / `connectionAddress` / `resolvedManagementIp` / `hostKeyState`) as optional.
- **Governance pins**: the five IPv4-validated inventory surfaces are pinned to stay IPv4 (`IPV4_PATTERN` / inline octet regex); the resolver is pinned to have no AAAA-success path.

## Honest scope

- An IPv6-reachable device CAN still be fingerprinted (detection unaffected); only the inventory mapping is refused.
- No live AAAA-only host was available in the sandbox for a browser screenshot of the refusal toast; the refusal paths are proven by the resolver/route pin suites (15 new pins + re-pinned vendor-detect matrix), and the live IPv4 path (localhost → 127.0.0.1 autofill) remains the browser-verifiable golden path.
- `resolution.mgmtIp ?? host` never participates in trust decisions — that identity question is governed by `ADR-host-key-trust-identity.md` (R50-T012), unchanged by this increment.

## Gates (exact final tree, CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | 0 errors |
| `bunx tsc --noEmit` (full) | 0 errors |
| `bun test tests/` | 696 pass / 12 skip / 0 fail (3,741 expects, 42 files) — from 681/12/0 |
| New pins | `tests/audit/r50-address-policy.test.ts` (15) + 4 re-pinned resolver tests in `tests/audit/vendor-detect.test.ts` |
