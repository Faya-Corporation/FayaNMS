# FayaNMS — R50 Vendor Auto-Detection: Independent Audit Verdict

**Verdict date:** 2026-09-16
**Audited object:** the three external R50 review documents (archived in this folder, same date):
`FayaNMS-R50-Vendor-IP-Autodetect-E2E-Audit-2026-09-16.md`,
`FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md`,
`FayaNMS-R50-Vendor-IP-Autodetect-Summary-Evidence-2026-09-16.md`
**Reviewed implementation commits:** `5e99abd` + `572ba31` (both on `main`, pushed)
**Verdict method:** every finding re-verified directly against the working tree at `572ba31` (file:line evidence below), all local gates re-executed on the exact tree, CI state re-queried from the GitHub API. No reliance on the review documents' own claims.

---

## 1. Overall Verdict

The external audit is **ACCURATE and ACCEPTED in full**. All 8 findings rated P0/P1 were independently confirmed at code level; both P2 findings are confirmed as "partially addressed, roadmap items still valid"; all six positive findings (§4 of the E2E audit) were also verified as true. No finding was found to be overstated in substance; two findings (R50-001, R50-003) are in fact **broader than the audit stated** — sharper evidence is recorded in §3.

**R50 status stands as the audit concluded:** `IMPLEMENTED / SECURITY HARDENING REQUIRED / CI CERTIFICATION PENDING` — **production BLOCKED** until the P0 (R50-001) and the R50-002 contract violation are remediated and reverified.

---

## 2. Verification of the audit's positive findings (all CONFIRMED)

| Audit claim | Verdict | Evidence |
|---|---|---|
| 4.1 Detection separated from persistence | CONFIRMED | `src/app/api/v1/devices/auto-detect/route.ts` contains no `db.device.create/update/delete`; pinned by `tests/audit/vendor-detect.test.ts:319-323` |
| 4.2 LIVE_SSH stays worker-owned | CONFIRMED | route only issues an internal `fetch` with `workerControlHeaders()`; no SSH in the API plane |
| 4.3 Probe commands bounded | CONFIRMED | `mini-services/worker/vendor-fingerprint.ts:39-43` — `DETECT_COMMANDS` is exactly 3 read-only status probes; allowlist + mutation-literal scan pinned by tests (lines 159-196) |
| 4.4 Typed failure propagation | CONFIRMED | live verification surfaced `CREDENTIAL_UNRESOLVED` through the worker → API → toast chain (worklog `R50-device-autodetect`); worker handler maps `VaultError` → 400, `SshError` → 200 `ok:false` (`mini-services/worker/index.ts:670-687`) |
| 4.5 Typed DNS resolution | CONFIRMED | `src/lib/dns/resolve-host.ts` never throws; failures are typed results; injectable lookup verified by tests |
| 4.6 Vendor parser test coverage | CONFIRMED | 6-family + generic fixtures in `tests/audit/vendor-detect.test.ts:41-155` |

---

## 3. Finding-by-finding verdict

### R50-001 — Host-key enrollment lookup fails open — **CONFIRMED (P0) — and BROADER than stated**

Evidence at `src/app/api/v1/devices/auto-detect/route.ts:150-156`:

```ts
let pin: string | null = null;
try {
  const hostKeyPin = await getHostKeyPin(probeTarget, profile.port);
  pin = hostKeyPin?.fingerprint ?? null;
} catch {
  pin = null; // enrollment store hiccup → first-contact capture path
}
```

and line 170: `enrollHostKey: !pin` → any enrollment-store failure becomes `enrollHostKey: true`, i.e. the audited **first-contact capture mode**. The fail-open is real and it is a SAFE-001 regression: `src/lib/ssh/host-keys.ts:73-76` documents that a null pin "is a fail-closed state" precisely *because* "the worker refuses unpinned live connections" — the R50 route silently breaks that invariant by converting null into capture opt-in. The worker itself is correctly fail-closed (`mini-services/worker/index.ts:586-591` refuses unpinned unless `enrollHostKey === true`); the defect is confined to the API route, which conveniently scopes the fix.

**Sharper than the audit stated:** the test suite does not merely omit this case — it *pins the defect*. `tests/audit/vendor-detect.test.ts:316` asserts `expect(ROUTE).toContain("enrollHostKey: !pin")`, enshrining the fail-open wiring as contract. Remediation must replace this pin, and add the DB-failure test matrix from the roadmap (R50-T001/T003).

### R50-002 — DNS resolves before vendor detection — **CONFIRMED (P1), and the documentation layer contradicts the code on every surface**

Evidence: `route.ts:100` runs `resolveHostToIp(host)` **before** the credential/vendor stage (lines 118-212); the route's own doc comment numbers DNS as stage 1 (lines 20-29). The user requirement is "vendor first, then map hostname → management IP".

The contradiction is systemic, not just code-order:
- `README.md:926` promises "vendor fingerprint first (when reachable), then hostname → management-IP mapping";
- `device-form-sheet.tsx:158-163` doc comment: "FIRST fingerprint the vendor … THEN map the hostname";
- `device-form-sheet.tsx:346` operator-visible copy: "…, then maps the hostname to its management address (DNS)".

All three promise vendor-first; the code does DNS-first. Additionally, the vendor stage *depends* on the DNS result (`route.ts:149` `probeTarget = resolution.mgmtIp ?? host`), so the reorder is a real orchestration change, not a cosmetic one.

### R50-003 — Host-key identity semantics — **CONFIRMED (P1), with a concrete failure scenario the audit implied but did not spell out**

The established trust identity across every certified surface is **`device.mgmtIp` + port**:
- `src/app/api/v1/devices/test-connection/route.ts:135` — `getHostKeyPin(device.mgmtIp, …)`
- `src/app/api/v1/worker/claim/route.ts:124` — `getHostKeyPin(device.mgmtIp, …)`
- `src/app/api/v1/worker/change-step/route.ts:262` — `getHostKeyPin(host, credential.port)` (the device's configured host)

The R50 route instead looks the pin up against `resolution.mgmtIp ?? host` (`route.ts:149,152`). When DNS resolution fails (mode `"failed"` — a routine, non-exceptional result by design), `probeTarget` silently becomes the **hostname**. A device enrolled under its mgmtIp identity then produces a pin miss → `enrollHostKey: true` → **capture mode on an endpoint that IS enrolled**, with a perfectly healthy enrollment store. DNS health therefore silently changes SSH trust semantics. This must be resolved by pinning the trust identity decision in an ADR (roadmap R50-T012) and binding probe target + identity together (R50-T013).

### R50-004 — AAAA fallback vs IPv4-only form — **CONFIRMED (P1)**

- Resolver: A→AAAA fallback (`resolve-host.ts:69-73`), IPv6 literal passthrough (`:58-60`).
- Form: `mgmtIp` is validated `IPV4_PATTERN` with the message "Enter a valid IPv4 management address" (`device-form-sheet.tsx:35-36,50-53`).

An IPv6-only host auto-fills an AAAA address with `shouldValidate: true` (`device-form-sheet.tsx:172-174`) → immediate, guaranteed form validation error. The advertised end-to-end IPv6 fallback cannot complete. Decide IPv4-only vs dual-stack (roadmap R50-T030..T033); if IPv4-only, return a typed `IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED` result instead of a success that the form rejects.

### R50-005 — Broad permission for active probing — **CONFIRMED (P1)**

`route.ts:89` gates the probe on `requirePermission(request, "config.backup")` — the data-plane class reused from test-connection. No dedicated `device.detect` / `device.probe` capability exists anywhere in the tree. The roadmap's R50-T020 (introduce and enforce a dedicated probe permission server-side) stands.

### R50-006 — Abuse controls — **CONFIRMED (P1)**

The route has no rate limiting and no target policy beyond the hostname charset regex (`route.ts:48-50`). Loopback, link-local (169.254/16 — cloud metadata endpoints), multicast and arbitrary internal CIDRs are all probeable; the R50 demonstration itself used `localhost → 127.0.0.1` as the success case, underscoring that no special-address guard exists. Roadmap R50-T022/T023/T024 (target network policy, special-address protection, per-actor/tenant rate limits) stand.

### R50-007 — No successful real-device detection evidence — **CONFIRMED (P1; honestly self-documented)**

The repo's own worklog states the chain was proven only through credential resolution (`CREDENTIAL_UNRESOLVED` typed refusal — no vault secret in the sandbox) and that "Real-device fingerprint evidence needs a reachable target + vault secret (operator-side)". Matches the audit exactly; the R48-era pending operator-creds item (DevNet AAA) remains the unblock path.

### R50-008 — CI did not certify — **CONFIRMED (P1; honestly self-documented)**

GitHub API re-verification (this audit, 2026-09-16):
- run `35042579421` on `5e99abd` — completed **failure**;
- run `35042635771` on `572ba31` — completed **failure**; jobs: `gate` failure with **0 steps executed and empty `runner_name`**; `browser`/`e2e`/`scan` skipped (no runner ever assigned).

This is the identical documented infrastructure no-runner signature recorded continuously since run #34 (see worklog CI addenda). Honest status: locally gate-proven, CI-blocked by infrastructure only. Roadmap R50-T100 stands as an external blocker.

### R50-009 — Partial-success semantics — **CONFIRMED as PARTIALLY addressed (P2)**

The response already carries independent stage blocks (`route.ts:243-260`): `mgmtIpResolution {mgmtIp, mode, error}` + `detection` + `vendorStage` + top-level `error` — so e.g. DNS-success + worker-down does return useful partial data. What is missing for the roadmap contract: stable typed per-stage error codes (the current values are free-text strings) and explicit stage status enums (R50-T040/T041). Valid as an enhancement item.

### R50-010 — Audit event richness — **CONFIRMED as PARTIALLY addressed (P2)**

`DEVICE_VENDOR_AUTODETECTED` (`route.ts:217-241`) already records actor id/name, correlation ID, host, mgmtIp, resolution mode/error, vendorStage, vendorKey, confidence, model, osVersion, probeCommand and outcome — more structured evidence than the audit's phrasing suggests. Still missing: credential profile ID, host-key state (pinned vs captured vs captured fingerprint), duration, tenant scope (R50-T070/T071). Valid as an enhancement item.

---

## 4. Independent gate re-execution (exact tree `572ba31`, this audit)

| Gate | Result |
|---|---|
| `bun run lint` | 0 |
| `bunx tsc --noEmit` (full, unfiltered) | 0 |
| `bun test tests/` | **640 pass / 12 skip / 0 fail** — 652 tests / 38 files / 3,506 expects (matches the audit's reported counts exactly) |
| Drift guard (fresh `fayanms_shadow`) | 0 — "No difference detected." |
| `certify.ts` | PASSED — 5 LIVE_SSH flavors, protocol level |
| `bun run build:gate` | 0 |
| CI on `5e99abd` / `572ba31` | failure — infrastructure no-runner signature (see R50-008 above) |

---

## 5. Disposition

1. **Accept all 10 findings** with the two sharpenings recorded above (R50-001 is test-pinned as defect; R50-003 has a concrete DNS-failure → capture scenario).
2. **Endorse the remediation roadmap's delivery order** unchanged: R50-T001 → T002 → T003 (fail-closed trust + regression guard) first, then R50-T010..T013 (vendor-first orchestration + trust-identity ADR), then the authorization/abuse phase, IPv6 decision, contract typing, fingerprint hardening, UI hardening, audit/telemetry, test matrix, real-device certification, CI certification.
3. **Release gate stays:** no production certification while any P0/P1 R50 finding is open; local gates are the source of truth until the CI runner blockage is externally resolved.
4. The three source review documents are archived in this folder as the audited record.
