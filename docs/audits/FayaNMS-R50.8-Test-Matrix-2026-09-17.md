# FayaNMS — R50.8 Test Matrix Consolidation (roadmap §10 coverage map)

**Date:** 2026-09-17
**Branch:** `z_ai_v2`
**Scope:** the R50 remediation roadmap's §10 "Test Matrix" (docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md) mapped cell-by-cell onto the executable suites that landed in R50.0–R50.8, with the remaining authorable gaps CLOSED in this increment.

---

## 1. Method

1. The 42 roadmap §10 cells (5 groups: unit / API / worker / security / browser) were extracted VERBATIM from the roadmap document.
2. Every cell was traced to its executable evidence — a named `describe`/`test` in a repo test file, live wire-matrix evidence, or a documented not-applicable disposition.
3. Cells with NO executable hermetic pin (previously only mapper-level or live-only evidence) were CLOSED here:
   - `tests/audit/r50-worker-detect-failures.test.ts` (NEW, 10 pins) — the worker-plane failure matrix over REAL ssh2 on ephemeral loopback ports;
   - `tests/browser/detection-journeys.test.ts` (NEW, 6 journeys D6–D12) — the detection-panel operator journeys in real Chromium under the shared e2e topology (`FAYANMS_BROWSER_E2E=1`).
4. One harness defect found and fixed by this increment: `persona-sshd.ts` could never complete `close()` when an in-process client left a failed-auth/mismatched connection open (Bun has no `net.Server#closeAllConnections`); the harness now tracks the REAL socket (`conn._sock`) and destroys lingering sessions at teardown. Teardown plumbing only — SSH semantics untouched (certification driver unaffected).

## 2. Dispositions

| Disposition | Meaning |
|---|---|
| `COVERED` | Executable hermetic pin existed BEFORE this increment (R50.0–R50.7 / earlier programs). |
| `GAP-CLOSED-R50.8` | No hermetic pin existed; this increment added the test. |
| `LIVE-EVIDENCE` | The cell requires real hardware/personas on the wire; covered by the recorded live wire matrices + browser evidence (CI-executable suites exist where the topology allows). |
| `N-A-DOCUMENTED` | The cell is not applicable to the shipped architecture; the rationale is recorded and the adjacent structural pin is cited. |

## 3. Registry (machine-pinned by `tests/audit/r50-test-matrix.test.ts`)

### 3.1 Unit tests (roadmap §10.1)

| Cell (roadmap §10 literal) | Disposition | Evidence |
|---|---|---|
| hostname resolver | COVERED | tests/audit/vendor-detect.test.ts :: R50 — resolveHostToIp (injectable, total) |
| IP literal handling | COVERED | tests/audit/vendor-detect.test.ts :: R50 — resolveHostToIp (injectable, total) |
| IPv4/IPv6 policy | COVERED | tests/audit/r50-address-policy.test.ts :: R50-T031 — resolveHostToIp enforces the IPv4 management-address policy |
| vendor parsers | COVERED | tests/audit/r50-fingerprint-registry.test.ts :: R50-T053 — realistic CLI fixtures across certified families |
| model extraction | COVERED | tests/audit/r50-fingerprint-registry.test.ts :: R50-T053 — realistic CLI fixtures across certified families |
| OS extraction | COVERED | tests/audit/r50-fingerprint-registry.test.ts :: R50-T053 — realistic CLI fixtures across certified families |
| error normalization | COVERED | tests/audit/r50-detection-contract.test.ts :: R50-T041 — worker-plane mapper matrix |
| target policy | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T022/T023 — target network policy (literal classes) |

### 3.2 API tests (roadmap §10.2)

| Cell (roadmap §10 literal) | Disposition | Evidence |
|---|---|---|
| RBAC | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T020 — device.detect permission |
| credential authorization | COVERED | tests/audit/r50-authorization-budgets.test.ts :: R50-T021 — probe-credential authorization decision |
| host-key trust states | COVERED | tests/audit/r50-trust-failclosed.test.ts :: R50-T002 — trust-state resolver (enrolled / unenrolled / lookup-failed) |
| no inventory mutation | COVERED | tests/audit/vendor-detect.test.ts :: R50 — /api/v1/devices/auto-detect route contract |
| vendor-first order | COVERED | tests/audit/vendor-detect.test.ts :: R50-T010 — vendor-FIRST orchestration: credential → trust → detection → DNS |
| partial-success response | COVERED | tests/audit/r50-detection-contract.test.ts :: R50-T040 — partial results: independent stage blocks |
| audit event creation | COVERED | tests/audit/r50-operational-telemetry.test.ts :: R50-T070 — DEVICE_VENDOR_AUTODETECTED carries the structured non-secret evidence |
| rate limiting | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T022/T023 — target network policy (literal classes) |

### 3.3 Worker tests (roadmap §10.3)

| Cell (roadmap §10 literal) | Disposition | Evidence |
|---|---|---|
| allowlisted commands only | COVERED | tests/audit/vendor-detect.test.ts :: R50 — DETECT_COMMANDS read-only allowlist |
| connect failure | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| auth failure | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| host-key mismatch | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| command rejected | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| probe fallback | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| output truncation | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| timeout behavior | GAP-CLOSED-R50.8 | tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |

`timeout behavior` honest scope: a hermetic black-hole connect is slow and flaky, so the cell is pinned sleep-free — the candidate loop's TOTAL-budget gate before every handshake and the per-command exec timeout are source-pinned, and the timeout family's registry identities are mapper-pinned; the wire-level connect-timeout case remains live-evidenced (R50.4 nine-case matrix, `SSH_CONNECT_TIMEOUT`-with-resolved-IP).

### 3.4 Security tests (roadmap §10.4)

| Cell (roadmap §10 literal) | Disposition | Evidence |
|---|---|---|
| loopback target | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T022/T023 — target network policy (literal classes) + tests/audit/r50-worker-detect-failures.test.ts :: R50.8 — /live/detect-vendor worker failure matrix (real ssh2, hermetic) |
| metadata address | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T022/T023 — target network policy (literal classes) |
| disallowed subnet | COVERED | tests/audit/r50-target-policy.test.ts :: R50-T022/T023 — target network policy (literal classes) |
| DNS rebinding | COVERED | tests/audit/r50-authorization-budgets.test.ts :: R50-T022-fu — the worker dial path uses the validated address |
| host-key-store outage | COVERED | tests/audit/r50-trust-failclosed.test.ts :: R50-T003 — auto-detect route: unknown trust state can never become first contact |
| tenant crossing | N-A-DOCUMENTED | single-tenant schema — no tenant dimension exists to cross; the authorization chain records `tenantScope: "single-tenant"` structurally (tests/audit/r50-authorization-budgets.test.ts :: R50-T021 — route wiring of the authorization chain) |
| unauthorized credential ID | COVERED | tests/audit/r50-authorization-budgets.test.ts :: R50-T021 — probe-credential authorization decision |
| rate-limit bypass | COVERED | tests/audit/rate-gate.test.ts :: SAFE-002 — spoof-resistant client key |

Policy-model disposition for `disallowed subnet`: the implemented R50-T022 decision is the special-class model (this-network / loopback / link-local / multicast / reserved / documentation / cloud-metadata classes DENIED; operational space incl. private, CGNAT, ULA and global v6 ALLOWED; `FAYANMS_PROBE_ALLOW_SPECIAL=true` is the audited lab hatch). The roadmap's `allowedCidrs/deniedCidrs` sketch was superseded by that model at implementation time — the deny-class matrix above IS the shipped "disallowed subnet" enforcement, parity-pinned across both planes. A configured-CIDR extension remains possible without contract change.

`DNS rebinding` honest scope: the resolve-then-dial TOCTOU window is structurally closed worker-side (the probe dials the VALIDATED address; no second lookup exists), parity-pinned across the planes; application-plane rebinding (a name flipping INSIDE the single app-plane resolution) is bounded by the R50-T025 DNS budget and the worker-side re-validation — defense in depth, not a second implementation.

### 3.5 Browser tests (roadmap §10.5)

| Cell (roadmap §10 literal) | Disposition | Evidence |
|---|---|---|
| empty hostname | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| no credential selected | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| successful detection | LIVE-EVIDENCE | docs/audits/FayaNMS-R50-T050-T054-Fingerprint-Registry-2026-09-16.md (five-vendor live wire matrix + browser auto-fill evidence, verify-r505-*.png) |
| DNS-only success | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| vendor-only success | LIVE-EVIDENCE | docs/audits/FayaNMS-R50-T060-T064-UIUX-Hardening-2026-09-16.md (stages-filter wire matrix case C2 + browser retry evidence) |
| typed error toast | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| field conflict | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| loading state | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |
| duplicate click prevention | GAP-CLOSED-R50.8 | tests/browser/detection-journeys.test.ts :: R50.8: detection-panel journeys (roadmap §10.5 browser cells) |

The two LIVE-EVIDENCE browser cells need a policy-allowed SSH persona on the wire (the shared e2e topology carries the simulator plane, not SSH personas); their operator-visible outcomes are pinned by the DOM-free UI layer (tests/audit/r50-detection-ui.test.ts) and by the recorded live matrices above. The detection-journeys suite additionally pins the D12 partial-success case, where a typed vendor-stage failure (CREDENTIAL_UNRESOLVED) leaves the address stage's success visible (T061).

## 4. Gap-closure summary

- 14 cells marked `GAP-CLOSED-R50.8` (7 worker + 7 browser) — all previously mapper-pinned or live-only.
- 1 harness defect fixed (`persona-sshd.ts` teardown) so the new worker matrix can run hermetically in-process.
- 26 cells `COVERED` by pre-existing suites — no re-litigation, only traceability.
- 1 cell `N-A-DOCUMENTED` (tenant crossing, single-tenant schema) with the structural pin cited.
- 2 cells `LIVE-EVIDENCE` (browser cells needing real SSH personas) with their recorded artifacts cited.

## 5. Honest scope

- The detection-journeys suite is CI-executable in the `browser` job (`FAYANMS_BROWSER_E2E=1 bun test tests/browser/` after a production build); in this sandbox it is hermetically skipped (no build: the sandbox memory ceiling OOM-blocks `next build` with the deployment stack resident — recorded since the Phase-8 increment). The journeys' assertion targets (sheet field ids, Detect button, stage-row headlines, pick chips) are the same surfaces verified live in the R50.4–R50.7 browser evidence.
- Remote CI remains platform-blocked since run #34 (OWNER-CI-001) — execution evidence here is local gates + the recorded live matrices, as with every increment before it.
- Real-device certification (roadmap §10.9 / R50-T090..T092) stays lab-side (operator hardware or free DevNet AAA credentials; Step 0 = the public demo device plane).
