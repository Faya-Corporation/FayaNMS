# FayaNMS — R50-T020/T022/T023/T024 Remediation Evidence (Phase R50.2, authorization & abuse controls)

**Date:** 2026-09-16
**Branch:** `z_ai_v2`
**Remediates:** R50-005 (P1 — broad permission for active probing), R50-006 (P1 — no abuse controls: loopback/metadata/multicast probeable, no rate limits); implements roadmap Phase R50.2 core (R50-T020, R50-T022, R50-T023, R50-T024).

---

## 1. Verdict of this remediation

**R50-005: FIXED.** Auto-detection requires the DEDICATED `device.detect` permission (operator + engineer; admin via wildcard; manager explicitly WITHOUT); the broad `config.backup` data-plane class no longer guards the probe.

**R50-006: FIXED (literal-form scope).** Loopback, cloud-metadata link-local, multicast, reserved and this-network targets are refused BEFORE any credential, trust-store, or network work — the R50 demonstration's own success case (`localhost → 127.0.0.1`) now answers typed `TARGET_NOT_ALLOWED` 403. Detection budgets are enforced per actor AND per target over the SHARED rate store (fleet-wide when `FAYANMS_RATE_STORE=postgres`).

Honest remaining scope (tracked in NEXT-TASKS): R50-T021 (actor→credential-profile→scope authorization enrichment), worker-side resolved-address policy (hostnames resolve at dial time; the literal policy cannot see their addresses), R50-T025 residual (explicit DNS-timeout budget — the worker call is already bounded at 30 s and the SSH plane has per-stage budgets).

## 2. Changes

### R50-T020 — dedicated probe permission

- `src/lib/auth/role-matrix.ts`: `device.detect` added to operator + engineer; posture comment records the decision; `KNOWN_PERMISSIONS` derives automatically.
- Route: `requirePermission(request, "device.detect")`.
- `docs/security/authorization-matrix.md`: `/devices/auto-detect` row documents the new permission + in-route controls.
- Live sandbox DB synced via `bun scripts/sync-role-permissions.ts` (operator 24 permissions, engineer 28).

### R50-T022/T023 — target network policy (`src/lib/net/target-policy.ts`, NEW)

- Literal-form classification: `this-network 0/8`, `loopback 127/8`, `link-local 169.254/16` (cloud metadata), `multicast 224/4`, `reserved 240/4` → DENY; `private 10/8 · 172.16/12 · 192.168/16`, `cgnat 100.64/10`, public, hostname → ALLOW. IPv6: `::`, `::1`, `fe80::/10`, `ff00::/8` → DENY; IPv4-mapped specials classified through the embedded v4; ULA/global → ALLOW. (fec0::/10 deprecated site-local deliberately outside the deny classes.)
- Escape hatch: `FAYANMS_PROBE_ALLOW_SPECIAL=true` re-allows specials WITHOUT hiding their class (still audited).
- Route stage 2 (position-pinned BEFORE credential/trust/fetch): denied → dedicated audit event `DEVICE_PROBE_TARGET_REFUSED` + typed `TARGET_NOT_ALLOWED` 403.

### R50-T024 — detection budgets

- Stage 3 (position-pinned BEFORE credential stage): two shared-store budgets per invocation — `device-detect:actor:{actorId}` (default 20/min, `FAYANMS_DETECT_RATE_LIMIT`) and `device-detect:target:{host}` (default 10/min, `FAYANMS_DETECT_TARGET_RATE_LIMIT`); exhausted → typed `DEVICE_PROBE_RATE_LIMITED` 429 + `Retry-After`. Reuses the SCALE-001 store contract (in-memory default; PostgreSQL shared store when configured — no new infra).

## 3. Tests (suite 669 → 681; 681 pass / 12 skip / 0 fail; 3,697 expects; lint 0; tsc 0)

`tests/audit/r50-target-policy.test.ts` (NEW, 12 pins): full deny/allow class matrix (v4 + v6 + mapped), escape-hatch semantics, role matrix grants (operator/engineer yes, manager no), route position pins (policy + rate stages precede credential/trust/fetch), typed refusals, shared-store budget keys. `tests/audit/vendor-detect.test.ts` permission pins updated. The R50.0/R50.1 matrices unchanged and green.

## 4. Live evidence (sandbox stack, 2026-09-16, post-restart)

| Probe | Result |
|---|---|
| `127.0.0.1` | 403 `TARGET_NOT_ALLOWED` (loopback) |
| `169.254.169.254` | 403 `TARGET_NOT_ALLOWED` (link-local) |
| `224.0.0.1` | 403 `TARGET_NOT_ALLOWED` (multicast) |
| `::1` | 403 `TARGET_NOT_ALLOWED` (loopback) |
| `no-such-host.invalid` (hostname) | 200 — vendor stage executes (typed `CREDENTIAL_UNRESOLVED` from the worker, the honest sandbox state) |
| hostname target × 11 | 429 `DEVICE_PROBE_RATE_LIMITED` after the 10/min target budget, `Retry-After: 60` |

## 5. Disposition

- R50-005 (P1): FIXED. R50-006 (P1): FIXED at the literal-policy + budget scope; worker-side resolved-address enforcement tracked as the R50-T022 follow-up.
- Next authorable phase: R50.3 (IPv4/IPv6 contract decision) and R50.4 (typed per-stage error codes) — both authorable; R50.5+ follow.
