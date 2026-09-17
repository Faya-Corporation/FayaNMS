# FayaNMS — NEXT TASKS (execution backlog, updated 2026-09-17, R51/z_ai_v2)

Derived from `FayaNMS-Independent-Current-Main-Audit-2026-09-15.md` + `FayaNMS-Production-Remediation-Roadmap-2026-09-15.md`, executed through the single-session remediation program (R34–R47), then the R50 program on branch `z_ai_v2`. ✅ LANDED entries are COMPLETED HISTORY — kept below for the audit trail, NOT active work. The ACTIVE backlog is everything still open, ALL of it outside the sandbox's control (except the R50.2+ phases, which are authorable code work):

## ACTIVE (only genuinely remaining work)

```text
R50-T021/T022-follow-up/T025 — actor→credential-profile→scope authorization enrichment; worker-side resolved-address policy; explicit DNS-timeout budget
R50.8 test-matrix consolidation — the roadmap §10 rows are largely covered by the suites landed in R50.0–R50.7 (unit/API/worker/security/browser); a coverage-mapping pass against that list closes the remaining gaps (e.g. tenant crossing is N/A single-tenant, documented)
R50-T090..T092 / LAB-FUNC-001 / LAB-CERT-HW-001 — real-device certification (needs operator-side hardware or free DevNet AAA credentials; Step 0: PUBLIC DEMO DEVICE PLANE — docs/certification/PUBLIC-DEMO-DEVICES.md + `bun run demo:fleet`)
R50-T100..T103 / OWNER-CI-001 — restore GitHub Actions runner capacity (infrastructure signature since run #34) and run the full gate on the release SHA
OWNER-GOV-001 — Enable required main protection/ruleset (settings-side; exact config in TASK-GOV-001-A + deploy note 4)
```

The remediation authoring backlog for the R34–R47 program is EMPTY: every code/doc task from the original backlog is ✅ LANDED with evidence (see the history below and worklog.md R34–R47). AUTH-001 is FIXED end-to-end (R35 guard + R46 fleet-wide store); the rendering layer is continuously verified (R47 browser journeys + axe a11y). The R50 P0 (R50-001) and P1s R50-002/003/004/005/006 are FIXED on `z_ai_v2` (Phases R50.0/R50.1/R50.2/R50.3 below).

---

TASK-R50-PHASE-7 — R50-T070..T072 audit + operational telemetry ✊ → ✅ LANDED (2026-09-17, branch `z_ai_v2`)

The detection plane's evidence and operations layers are complete, with the HTTP contract UNCHANGED (DETECTION_CONTRACT_VERSION stays 1 — audit + metrics planes only). R50-T070: the `DEVICE_VENDOR_AUTODETECTED` `afterJson` is the roadmap's full structured NON-SECRET evidence — actor + correlationId mirrored from the audit columns (self-contained exports), `tenant: null` BY DESIGN (single-tenant schema — reserved, never silently omitted), the NEW `outcome` literal (matched / vendor-unknown / failed / not-attempted — vendor-stage precedence) and `durationMs` (total route wall-clock; the worker's latencyMs is only the probe leg), on top of the R50.4/R50.5/R50.6 fields (three endpoint identities, credential/host-key state, attribution facts, match reasons, typed codes, requestedStages). R50-T071: EVERY failure class is audited — `DEVICE_PROBE_AUTH_REFUSED` (NEW; actor identified on valid-session RBAC refusals, NULL actor BY DESIGN when unauthenticated — no identity fabricated), `DEVICE_PROBE_CREDENTIAL_REFUSED` (NEW; reason "not-found"/"type-unsupported" + profileType), `DEVICE_PROBE_HOST_KEY_MISMATCH` (NEW; a pre-auth first-contact substitution attempt against a pinned coordinate), plus the existing TARGET_REFUSED / TRUST_LOOKUP_FAILED events now emitted through the shared BEST-EFFORT helper (`auditProbeFailureBestEffort` — the target-policy emission was an unprotected await that could 500 on audit-plane failure); rate-limit refusals are counted NOT audited per-hit BY DESIGN (the budget is the abuse control — per-hit rows would let an attacker flood the audit plane). R50-T072: NEW `src/lib/metrics/detection-metrics.ts` — in-process, BOUNDED (1024-sample duration ring; 32 named failure keys + `_other`), zero new infra — answering the roadmap's six names VERBATIM (requests/success/failure/vendor_unknown/host_key_mismatch totals + duration_seconds in SECONDS with lifetime stats and recent-window p50/p95), with the documented taxonomy (matched→success; generic→vendor-unknown, neither success nor failure; refusals→failure WITH the per-registry-code `failureReasons` split; not-attempted counted in neither — except a requested address stage that FAILED, a failure with its resolution code; duration observed ONLY past the refusal gates). Read surface: GET `/api/v1/metrics/detection` (NEW), gated by `metrics.read`, payload is EXACTLY the snapshot (aggregates only — structurally incapable of echoing hostnames/credential ids/fingerprints), `since`-stamped per-instance honesty. LIVE wire matrix (real app+worker+IOS persona harness): unauthenticated (proxy-gated pre-route), matched cisco, loopback refusal, credential-unresolved, WRONG-PIN host-key mismatch (DB-seeded wrong fingerprint → HOST_KEY_MISMATCH, row deleted after), address-only DNS_NOT_FOUND (not-attempted outcome + failure counter), manager-session RBAC refusal (403 PROBE_NOT_AUTHORIZED + AUTH_REFUSED row with the real actor) — final counters matched the matrix EXACTLY (requests 6 / success 1 / failure 5 / mismatch 1 / duration count 3 = the three stage-running invocations, refusals excluded / all five failure reasons each exactly 1). Audit read-back through /api/v1/events verified the structured afterJson on the wire. Browser: admin → Devices → Add-Device → Detect → vendor auto-filled (golden path undisturbed); in-page metrics fetch moved requests/success by exactly +1; 0 console errors; mobile 390×844 no h-scroll. Tests: `tests/audit/r50-operational-telemetry.test.ts` (NEW, 28 pins — roadmap-name bidirectionality, taxonomy, double-count contract, bounds, route/endpoint source pins); suite 783 → 811 (811 pass / 12 skip / 0 fail, 4,275 expects, 46 files), lint 0, tsc 0. Evidence: `FayaNMS-R50-T070-T072-Audit-Telemetry-2026-09-17.md`.

TASK-R50-PHASE-6 — R50-T060..T064 UI/UX hardening ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

The Add/Edit device sheet's detection flow is now explicit at every step, driven by the NEW pure layer `src/lib/devices/detection-ui.ts` (`decideApply` / `buildVendorStageRow` / `buildAddressStageRow` / `buildHostKeyPanel` — DOM-free, fully test-pinned). R50-T060: a `Detection — <host>` panel renders TWO explicit stage rows (vendor + address) with state icons, headlines, typed-code lines and a contract-v1 badge. R50-T061: each row is built ONLY from its own R50.4 stage block, so partial success (vendor matched + DNS failed, or the inverse) is visible as what it is. R50-T062: the ONLY path a result takes into the form is `decideApply` — empty field auto-fills, unchanged field no-ops, and a field the operator filled gets a chip ("Detected Management IP: … — field has your input") with explicit **Use** / **Keep mine** buttons; silent overwrite is structurally impossible (chip flow browser-verified: 10.99.99.99 kept → Use → 21.0.17.144 applied). R50-T063: a first-contact host-key panel shows Target (the operator-typed trust identity, R50-T012), Dialed, Key type + OpenSSH fingerprint BEFORE any enrollment, with the out-of-band verification copy; the panel is absent when the vendor stage did not run — absent is never readable as "verified" (pinned). R50-T064: the route schema gained an optional `stages: ["vendor"|"address"]` filter (`resolveRequestedStages` in the contract module; min(1), omitted = both = the historical full run) and every unrequested stage answers `skipped-not-requested` — a no-op, never a failure — so per-stage Retry buttons on failed rows re-run EXACTLY one stage (an address-only retry performs NO device probe; a vendor-only retry performs NO DNS work; the success toast only summarizes what RAN). The detection section is a child of the sheet content on purpose (Radix unmount → fresh panel every session, no effect-driven resets); vendor/model picks are create-flow only (edit mode neither unlocks vendor nor persists model). LIVE wire matrix (real app + worker + IOS harness persona, forwarder onto 21.0.17.144): full run (no stages) matched cisco + ip-literal + capture-requested; `["address"]` → vendor `skipped-not-requested`/`not-probed` with NO probe (≈56 ms); `["vendor"]` on a DNS-blackhole → honest `SSH_UNREACHABLE` with NO bogus DNS failure; `["vendor"]` reachable → matched + address skipped; `stages: []` → 400 INVALID_BODY; contractVersion 1 everywhere; audit rows record `requestedStages` (T070 groundwork). Tests: `tests/audit/r50-detection-ui.test.ts` (NEW, 30 pins) + re-spelled resolution-gate pin in `r50-detection-contract.test.ts`; suite 753 → 783 (783 pass / 12 skip / 0 fail, 4,170 expects, 45 files), lint 0, tsc 0. Browser: two-stage panel + first-contact fingerprint panel (verify-r506-detect.png), chip Keep-mine/Use flow (verify-r506-chip.png), DNS-failed row with exactly one Retry + address-only re-run (verify-r506-retry.png), mobile 390×844 no h-scroll (verify-r506-mobile.png), 0 console errors. Evidence: `FayaNMS-R50-T060-T064-UIUX-Hardening-2026-09-16.md`.

TASK-R50-PHASE-5 — R50-T050..T054 vendor fingerprinting hardening ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

R50-T050: fingerprints are a frozen per-vendor REGISTRY (`VENDOR_REGISTRY` in `mini-services/worker/vendor-fingerprint.ts`) — each handler owns displayName, its honest probeCommand (sophos documents WebAPI/CERT-006, pinned to never enter DETECT_COMMANDS), signature matchers with STABLE ids + structural/soft strength, and ordered extractors; PLUS a probe-chain informativeness filter (`isInformativeCliOutput`) so authentic short CLI rejections (Cisco "% Invalid input", FortiOS "Command fail. Return code -3", PAN-OS "Unknown command", Junos "syntax error") never stop the candidate chain — the probe now REACHES the command the CLI answers (FortiOS probe #3, PAN-OS probe #2 — proven live). R50-T051: analysis byte-bounded (256 KiB), ANSI CSI/OSC stripped + C0 controls neutralized BEFORE matching, evidence capped per line (200) × count (3) × TOTAL bytes (512 — the total cap is real and test-pinned). R50-T052: attribution carries DETERMINISTIC `matchReasons` (exact matched signature ids, registry order — double-parse deep-equality pinned); `confidence` is derived, not opaque; the audit trail records matchReasons/softMatches; the Add-Device summary gained the additive "Matched: …" line. R50-T053: realistic fixtures for Cisco IOS/IOS XE/NX-OS, FortiOS, AOS-CX, Junos, PAN-OS + generic (tests/fixtures/detection/). R50-T054: STRUCTURAL-ONLY attribution — soft name tokens never attribute a vendor alone or in combination; banner/hostname/description near-misses are reported as `softMatches` on the generic result; the two pre-R50.5 banner-form pins were re-spelled (palo banner + sophos banner now pinned generic-with-near-misses — T054 supersedes the behavior they enshrined). LIVE E2E five-vendor wire matrix (real app :3000 + real worker :3030 + the five in-repo SSH persona harnesses, TCP-forwarded onto the non-loopback sandbox address): ALL FIVE matched with deterministic reasons on the wire (cisco WS-C2960X-24TS-L/15.2(4)E7, hpe FL.10.13.1050, fortinet FortiGate-60F/7.4.4 via probe #3, juniper srx1500/21.4R3-S4.9, palo PA-5410/11.0.4 via probe #2). Browser: the Add-Device sheet rendered "Matched: cisco.ios-banner, cisco.chassis-memory, cisco.vendor-name" + auto-fill; loopback → typed policy refusal copy; mobile 390×844 no h-scroll; 0 console errors. Tests: `tests/audit/r50-fingerprint-registry.test.ts` (30 pins) + fixtures (7 positive / 3 negative); suite 723 → 753 (753 pass / 12 skip / 0 fail, 4,101 expects), lint 0, tsc 0. Evidence: `FayaNMS-R50-T050-T054-Fingerprint-Registry-2026-09-16.md`.

TASK-R50-PHASE-4 — R50-T040..T042 typed detection API contract ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

The detection API is now a VERSIONED CONTRACT: `src/lib/net/detection-contract.ts` (NEW) holds the closed registry `DETECTION_ERROR_CODES` — the roadmap's recommended 15 verbatim (`PROBE_NOT_AUTHORIZED` … `DEVICE_PROBE_RATE_LIMITED`) plus six documented additions (`SSH_UNREACHABLE`, `SSH_SESSION_FAILED`, `DNS_LOOKUP_FAILED`, `WORKER_UNAVAILABLE`, `WORKER_REJECTED`, `INVALID_BODY`) — with pure mappers so transport strings (`SSH_TIMEOUT`, `DETECT_NO_OUTPUT`, vault codes, …) and DNS errnos (`ENOTFOUND`, `EAI_AGAIN`, the resolver's IPv4-only refusals) NEVER leak as codes. R50-T040: every success envelope carries TWO INDEPENDENT stage blocks — `vendorDetection` (status/outcome/code/message/detection/hostKey) and `addressResolution` (resolved/refused/failed + code) — so a matched vendor with a failed DNS (or the inverse) is reported as what it is; all pre-R50.4 flat fields retained. R50-T042: `DETECTION_CONTRACT_VERSION=1` stamped in data AND meta on success AND on every refusal (new shared `failWithMeta`); route refusals renamed to registry codes (`CREDENTIAL_UNRESOLVED` 404, `CREDENTIAL_NOT_AUTHORIZED` 403, `PROBE_NOT_AUTHORIZED`); the audit trail records `detectionErrorCode`/`resolutionErrorCode`/`contractVersion` (R50-070 groundwork); the client `AutoDetectResult` carries the typed blocks (optional — older servers stay assignable) and operator toasts are keyed on the STABLE codes. LIVE E2E (real app + real worker + the in-repo IOS SSH harness persona via a TCP forwarder onto a non-loopback address): 9-case matrix — matched detection (`cisco`/high, real `show version` evidence) with capture-mode host key, TARGET_NOT_ALLOWED/CREDENTIAL_UNRESOLVED/CREDENTIAL_NOT_AUTHORIZED stamped refusals, SSH_CONNECT_TIMEOUT-with-resolved-IP (partial), SSH_UNREACHABLE+DNS_NOT_FOUND (two independent codes in one response), IPV6_UNSUPPORTED refusal, skipped-vendor resolution-only. Browser journey: Add-Device sheet auto-fills Vendor=Cisco Systems + Model=WS-C2960X-24TS-L from the typed blocks; the IPv6 refusal toast names the policy; 0 console errors. Tests: `tests/audit/r50-detection-contract.test.ts` (27 pins: registry closed set + roadmap-doc↔code bidirectional literals, full mapper matrices, partial-results structure, version stamping incl. error envelopes, legacy-field retention, client typed-code copy); suite 696 → 723 (723 pass / 12 skip / 0 fail, 3,883 expects), lint 0, tsc 0. Evidence: `FayaNMS-R50-T040-T042-Detection-Contract-2026-09-16.md`.

---

TASK-R50-PHASE-3 — R50-T030..T033 IPv4 management-address policy ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

R50-004 is FIXED at the contract level: the T030 DECISION is recorded in `docs/adr/ADR-management-address-policy.md` — `Device.mgmtIp` is IPv4-ONLY (matching the already-IPv4 create/update/form/CSV surfaces and the IPv4-CIDR discovery scanner; dual-stack would be a multi-plane schema change with no operator demand). R50-T031: `resolveHostToIp` REFUSES IPv6 with the typed `IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED` result — an IPv6 literal pre-DNS (`refused-ipv6-literal`) and an AAAA-only hostname after an honest AAAA diagnostic (`refused-aaaa-only`) — the old A→AAAA fallback + IPv6-literal passthrough (the misleading success the audit flagged) is structurally gone and its mode union is re-pinned; detection itself is unaffected (probes dial the endpoint directly, never the mapping). R50-T033: multi-address A RRsets resolve deterministically to the numeric-ASCENDING first address (per-octet compare; resolver RR rotation cannot move a device's management address). The operator toast names the policy instead of a generic DNS failure; the client `AutoDetectResult` type carries the new mode union + the T011 fields. Tests: `tests/audit/r50-address-policy.test.ts` (15 pins) + re-pinned resolver matrix in vendor-detect.test.ts; suite 681 → 696 (696 pass / 12 skip / 0 fail, 3,741 expects), lint 0, tsc 0. Evidence: `FayaNMS-R50-T030-T033-AddressPolicy-2026-09-16.md`.

---

TASK-R50-PHASE-2 — R50-T020/T022/T023/T024 authorization & abuse controls ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

R50-005 and R50-006 are FIXED at the literal-policy + budget scope: the detection route requires the DEDICATED `device.detect` permission (operator + engineer; manager explicitly without — R50-T020); the NEW `src/lib/net/target-policy.ts` refuses loopback / cloud-metadata link-local / multicast / reserved / this-network literals BEFORE any credential, trust-store, or network work, with the dedicated `DEVICE_PROBE_TARGET_REFUSED` audit event + typed `TARGET_NOT_ALLOWED` 403 and the documented `FAYANMS_PROBE_ALLOW_SPECIAL=true` lab hatch (R50-T022/T023); detection budgets run per actor AND per target over the SHARED SCALE-001 rate store → typed `DEVICE_PROBE_RATE_LIMITED` 429 + Retry-After (R50-T024). Live evidence: the verdict's own demo case (localhost) now 403s alongside 169.254.169.254 / 224.0.0.1 / ::1; hostnames pass; the target budget 429s after 10 calls with Retry-After 60. Tests: `tests/audit/r50-target-policy.test.ts` (12 pins), suite 669 → 681 (681 pass / 12 skip / 0 fail, 3,697 expects), lint 0, tsc 0; live roles synced via sync-role-permissions.ts. Evidence: `FayaNMS-R50-T020-T024-Abuse-Controls-2026-09-16.md`. Remaining honest scope: R50-T021 enrichment, worker-side resolved-address policy, DNS-timeout budget (tracked ACTIVE).

---

TASK-R50-PHASE-1 — R50-T010..T013 vendor-first orchestration + trust-identity ADR ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

R50-002 and R50-003 are FIXED: the auto-detect route runs vendor-FIRST (authorization → target policy → credential authorization → host-key policy → detection → hostname resolution → preview), resolves the hostname exactly ONCE after detection and never retargets the probe (R50-T013), names the three endpoint identities explicitly (`requestedHost` / `connectionAddress` / `resolvedManagementIp`, R50-T011), and pins the trust identity of a detection probe to the REQUESTED ENDPOINT by ADR (`docs/adr/ADR-host-key-trust-identity.md`, R50-T012) — DNS health can no longer flip SSH trust semantics. The response gained `hostKeyState` and the audit event gained `credentialProfileId` + `hostKeyState` (R50-070 groundwork). Evidence: `FayaNMS-R50-T010-T013-VendorFirst-2026-09-16.md` — suite 657 → 661 (661 pass / 12 skip / 0 fail, 3,587 expects), lint 0, tsc 0, live proof that the vendor stage executes and reaches the worker even with DNS ENOTFOUND; the R50.0 fail-closed matrix unchanged and green.

---

TASK-OPS-003-A — Backup/DR drill + runbook ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

`scripts/drill-restore.ts` (NEW) makes recoverability an executable claim: READ-ONLY logical dump of the live database (PG-side `to_jsonb`, works without pg_dump) → FRESH scratch database restored via `prisma migrate deploy` (the production path) → every row reloaded (pool-proof per-table `DISABLE/ENABLE TRIGGER ALL` — the schema's genuine FK cycles make order advisory) → VERIFY: per-table row-count equality (42/42), health surface, simulator plane, and a REAL ConfigSnapshot decrypted from the restored database under the deployment KEK with sha256 plaintext integrity → measured RPO/RTO + printed dispositions (app loss / interrupted change / KEK-loss-catastrophic with the `migrate-encrypt-snapshots.ts` rotation path) → name-guarded scratch DROP (`--keep` to inspect). LIVE EVIDENCE (2026-09-16, sandbox): 66,694 rows / 42 tables round-tripped, 11/11 checks, RPO ≈ 1 s, RTO 3 s, snapshot v7 (3,638 bytes) decrypt verified. Tests: `tests/audit/drill-restore.test.ts` (8 pins: source-DB read-only shape, production schema path, pool-proof trigger state, guarded DROP, decrypt-not-just-counts, RPO/RTO + dispositions; live drill opt-in via `FAYANMS_DRILL=1`); suite 661 → 669 (669 pass / 12 skip / 0 fail, 3,609 expects), lint 0, tsc 0. Deploy doc Phase D1 expanded with the D1-DRILL runbook (both pg_dump/pg_restore and the no-pg_dump path, evidence bar, cadence: after every schema migration and quarterly).

---

TASK-R50-PHASE-0 — R50-T001/T002/T003 fail-closed trust gate ✊ → ✅ LANDED (2026-09-16, branch `z_ai_v2`)

The R50-001 P0 (verdict CONFIRMED, "broader than stated" — the defect was test-pinned as contract) is FIXED: `HostKeyTrustState` (enrolled / PROVEN-unenrolled / lookup-failed) replaces nullable trust semantics; `resolveHostKeyTrustState` is a total, injectable, fail-closed resolver; the auto-detect route aborts BEFORE the worker SSH connection on lookup failure with typed `HOST_KEY_ENROLLMENT_LOOKUP_FAILED` (503) + the `HOST_KEY_TRUST_LOOKUP_FAILED` audit event; capture mode is opted into ONLY on a proven-unenrolled state; the old fail-open literals are pinned dead and the worker-plane refusal is re-pinned as defense in depth. Evidence: `tests/audit/r50-trust-failclosed.test.ts` (17 pins — the roadmap's behavioral matrix + wiring + dead-literal pins), suite 640 → 657 (657 pass / 12 skip / 0 fail, 3,566 expects), lint 0, tsc 0; LIVE evidence in `FayaNMS-R50-T001-T003-Trust-FailClosed-2026-09-16.md` (E2E smoke through the real worker + REAL PostgreSQL-outage resolver proof returning lookup-failed, plus the app→worker control-plane key-set gap found and fixed in the sandbox runtime during that run).

---

TASK-AUTH-001-A — Login throttling, backoff, lockout, sign-in telemetry ✊ → ✅ LANDED (R35, 2026-09-15)

Goal: Bound online password guessing on `/api/auth/*` (outside the `/api/v1` gate; `authorize()` has no attempt control).
Files: `src/lib/auth/options.ts`, NEW `src/lib/auth/login-guard.ts`, `tests/audit/login-guard.test.ts`, deploy doc security note, README security paragraph.
Implementation: Pre-auth sliding-window guard keyed by (trusted-proxy IP, normalized account) with exponential backoff + temporary lockout; typed audit events (`SIGNIN_THROTTLED`, `SIGNIN_LOCKOUT`); enumeration-safe generic failure responses; store behind an interface so the SCALE-001-A shared backend can slot in.
Tests: budget/backoff/lockout/reset pins; trusted-hop keying; audit emission; enumeration-safety.
Acceptance: 50 simulated attempts → throttled with `Retry-After`; lockout recorded in audit trail; all existing suites still green.
Depends on: none.
Landed (R35): guard module + `authorize()` enforcement BEFORE the DB lookup/scrypt + route pre-check on the credentials callback only (429 + `Retry-After` envelope); HMAC-keyed non-reversible account identity (no raw identifiers stored/logged/emitted); 30 s·2^n lockout capped at 4 min (never permanent, decays fully, success resets); bounded store (5,000-key cap, 64 stamps/key) behind `LoginGuardStore`; 37 contract tests; env knobs documented in `.env.example` + `docs/deploy/env.production.example` + deploy-doc security note 20. **Honest scope: login abuse control implemented — this is the single-process store; distributed production rate limiting (fleet-wide budgets) remains TASK-SCALE-001-A, which reuses this guard's store interface. The parent AUTH-001 finding is PARTIALLY FIXED (in-process) until that lands.**

---

TASK-SVC-001-A — EdDSA-only production startup (Phase 2 made reachable) — **LANDED (R36)** ✅

Goal: Let production boot with symmetric service secrets fully retired, per the documented rotation end state.
Landed as: mode-aware startup policy (eddsa-only / dual / hs256-legacy / unconfigured, derived from configuration — no mode switch); Ed25519-only production config boots clean with NO `FAYANMS_SERVICE_SECRET`; app requires its own private key in eddsa-only mode (it mints control tokens); malformed/wrong-type key material fails at BOOT (static reasons, no material echoed); duplicate public keys deduplicated; `kid` pinned inert; worker boot check (`identity-boot.ts`) mirrors the policy worker-side; legacy HS256 minting made visible (explicit warning); env templates + README + deploy-doc note 17 rewritten around the three states and the two-plane ownership table.
Evidence: `tests/auth/service-identity-modes.test.ts` (38 pins incl. the full startup matrix and the Ed25519-public-key-as-HMAC confusion attempt); suite 456 → 494; LIVE production-boot proof with EdDSA-only env (`GET /` → 200, internal route → 401) plus boot-refusal negative controls; certify.ts exit 0.
Audit status: **SVC-001: FIXED** — Ed25519-only production identity is bootable and verified end-to-end.
Parent context: secret SCOPE separation (which process may hold which material) remains TASK-SEC-ENV-001-A.
Depends on: none.

---

TASK-SEC-ENV-001-A — Per-service environment split (secret compartmentalization) ✊ → ✅ LANDED (R37, 2026-09-15)

Goal: Stop one `.env.production` from serving app+worker+provision; enforce the secret ownership table.
Landed as: `.env.production` demoted to the HOST-SIDE interpolation file only (`--env-file`; build args, composed `DATABASE_URL`, host port); app runtime env split to `.env.production.app` (session/KEK/CONTROL identity, NO `FAYANMS_VAULT_*`); worker runtime env split to `.env.production.worker` (WORKER identity/vault entries/WebAPI CA pin, NO `NEXTAUTH_SECRET`/KEK/`POSTGRES_PASSWORD`/`DATABASE_URL`); provision receives NO env file (composed `DATABASE_URL`; demo-mode stays a `-e` override). Both runtimes WARN at boot on out-of-zone variables (by name, never values) — `findAppSecretScopeWarnings` (vault wildcard + worker-zone vars) in `security-policy.ts` and `findWorkerSecretScopeWarnings` in worker `identity-boot.ts` — with the documented deprecation window after which they refuse. Templates `docs/deploy/env.app.production.example` + `env.worker.production.example` (new), `env.production.example` rewritten host-side; deploy-doc T6 rewritten + security note 21; README LANDED block.
Evidence: `tests/audit/env-boundary.test.ts` (30 pins: compose env-file mapping incl. the shared-file abolition, template zone purity both ways, warning semantics, value-never-echoed, required-vars-never-forbidden, boot wiring); suite 494 → 524. `docker compose config` NOT VERIFIED — infrastructure limitation (no Docker in this environment); the static boundary tests are the executable verification here.
Audit status: **SEC-ENV-001: FIXED** — runtime configuration boundaries match the ownership table (runtime `docker compose config` render remains runner/lab evidence, CI-001).
Depends on: none.

---

TASK-SCALE-001-A — Shared rate-limit store ✊ → ✅ LANDED (R38, 2026-09-15) for the API gate plane

Goal: Fleet-wide quotas when multi-instance; keep single-host default zero-infra.
Landed as: `src/lib/api/rate-store.ts` — ONE store contract, two implementations: bounded in-memory default (identical gate semantics, zero new infra) and opt-in PostgreSQL shared store (`FAYANMS_RATE_STORE=postgres`) reusing the database the app already runs (no new service; a Redis service would add mandatory infra the single-host deployment does not run — the interface accepts further backends). Postgres hits serialize per key via `pg_advisory_xact_lock` and run prune → count → insert/deny in ONE transaction (no GET/increment/SET race); denied attempts consume no slots; per-key pruning + global stale sweep bound retention; unreachable store fails CLOSED (pinned, documented decision). `takeRateSlot` is now async over the resolved store; the proxy awaits it; unknown `FAYANMS_RATE_STORE` values refuse.
Evidence: `tests/audit/rate-store.test.ts` (19 pins: shared contract over BOTH backends — budget/Retry-After-oldest-stamp/slide/key-isolation/no-slot-consumption/parallel-atomicity 12→5 — PLUS the acceptance: two clients on separate Prisma pools share ONE budget both directions; fail-closed outage; resolution policy incl. unknown-refusal); rate-gate suite converted to await (26 pins intact, incl. bounded-sweep + spoofing + proxy-wiring order).
Honest scope: the LOGIN guard (AUTH-001-A) keeps its per-instance store — its read-modify-write lockout state needs the same atomic per-key transaction shape; a plain SQL KV would race across instances and was REFUSED as a false fix. Tracked as TASK-SCALE-001-B (below). Parent AUTH-001 remains PARTIALLY FIXED (distributed login plane pending).
Audit status: **SCALE-001: FIXED for the API rate gate (the finding's named surface); login plane → TASK-SCALE-001-B.**
Depends on: none (the AUTH-001-A store interface stays; the API gate had no shared seam before this).

---

TASK-SCALE-001-B — Distributed backend for the login guard's lockout state ✊ → ✅ LANDED (R46, 2026-09-15)

Goal: Close the remaining AUTH-001 half: fleet-wide login budgets/lockout when 2+ app instances.
Landed as: `AtomicLoginGuardStore` — when `FAYANMS_RATE_STORE=postgres` (the SAME knob as the API gate's shared store; one knob, both planes) every per-key read-modify-write of the guard (prune → budget → escalate → upsert/delete) runs inside ONE `pg_advisory_xact_lock(hashtextextended(key))` transaction over a new `LoginGuardState` row (failures = bounded epoch-ms stamp array, lockoutUntil, lockoutCount, denialEmittedAt); the guard's decision logic was refactored into pure per-key mutators shared by BOTH backends (memory path keeps its process-guaranteed semantics and every R35 pin); success reset is an awaited atomic mutation; once-per-window telemetry rides on the shared state (fleet rule); fail-closed on store outage (pinned SCALE-001-A decision); retention server-side (per-key rewrite + global stale sweep that never deletes an active lockout; rows defensively parsed).
Tests: `tests/audit/login-guard-distributed.test.ts` (20 pins: round-trip fidelity, upsert/delete/no-op outcomes, defensive parse, 12 parallel mutations no-lost-update, guard contract over the shared store incl. escalation 30→60 s and full decay, THE acceptance — A locks/B honors, symmetric source throttle, cross-instance reset, fleet telemetry exactly once per window, 12 parallel failures across BOTH instances → 12 stamps/1 escalation/1 event, fail-closed outage, pruneStale keeps active lockouts, resolution policy one-knob-both-planes); suite 580 → 600 (594 pass + 6 e2e skips; 3,354 expects); E2E journeys 6/6 live (J5 login throttle re-proven on the live stack).
Acceptance: Login budgets mean one fleet budget under `FAYANMS_RATE_STORE=postgres`; **AUTH-001 flips to FIXED**.
Depends on: SCALE-001-A (landed — same atomic pattern).

---

TASK-DOC-001-A — Governance-truth drift fixes ✊ → ✅ LANDED (R43, 2026-09-15)

Goal: Every governance claim in the docs must match live reality, and the docs must differentiate implemented / locally verified / CI verified / protocol certified / real-hardware certified / production deployed.
Landed as: `.github/workflows/ci.yml` header REWRITTEN around the live state ("Branch protection: NOT ACTIVE — live API read-back 2026-09-15: main.protected=false, required checks off"; the earlier "protection active" claim explicitly named as governance drift; the ruleset requirements documented as the GOV-001 owner action; the per-commit honest CI posture referenced). Deploy-doc notes 4/5 reconciled the same way ("Branch protection is NOT active today" + owner procedure + the unprotected-main credential warning). Across PHASES A–F the other drifted surfaces were reconciled in the same commits that changed reality: secret scope (note 21 + T6 + templates), service identity (note 17, SVC-001-A), rate limiting (note 8, SCALE-001-A), TLS (D2 + note 22), log retention (note 24), sessions (note 23).
Tests: `tests/audit/p3-hardening.test.ts` DOC-001-A block pins the workflow header + runbook truth claims (the flip to "active" requires the live API read-back saying so — GOV-001).
Acceptance: No doc claim contradicts the live API or the shipped policy.
Depends on: GOV-001-A for the flip to "active"; the corrective wording has landed.

---

TASK-GOV-001-A — Restore branch protection on `main` 👤

Goal: `main.protected=true` with required `gate`+`scan`; kill the GOV-001 P0.
Files: GitHub settings (owner token); `ci.yml` header stamp.
Implementation: Ruleset: PR required, ≥1 approval (+CODEOWNERS), conversation resolution, required checks, no force-push/deletion, scoped admin bypass decision recorded; verify via API read-back.
Tests: Governance verification step asserting the read-back.
Acceptance: Live API: `protected:true` + required checks; docs match.
Depends on: none (owner-side).

---

TASK-CI-001-A — Restore CI evidence on the release SHA 👤

Goal: Green `gate`+`scan` on current HEAD; kill the CI-001 P0.
Files: none (billing/minutes); optional runner fallback in `ci.yml`.
Implementation: Verify Actions minutes/billing; re-run from UI; if unavailability persists, self-hosted runner or scheduled weekly full run.
Tests: n/a.
Acceptance: Release SHA has successful required runs; artifacts retained.
Depends on: none (owner-side; parallel with GOV-001-A).

---

TASK-DEPLOY-001-A — HTTPS-by-default reference deployment ✊ → ✅ LANDED (R40, 2026-09-15, with OPS-002-A runtime hardening)

Goal: Make the safe path the default path.
Landed as: `compose.tls.yml` (override profile) + `docs/deploy/Caddyfile.tls` — a TLS-terminating proxy sidecar is the shipped DEFAULT ingress: automatic certificates (ACME for a public DNS name; internal CA for lab hosts), automatic HTTP→HTTPS redirect, HSTS owned at the single proxy hop, and the app's direct host-port publication REMOVED in the profile (`ports: []` override). The full TLS contract is documented (deploy-doc D2 + security note 22): exactly ONE trusted proxy hop (`FAYANMS_TRUST_PROXY_HOPS=1` stays correct), forwarded-header policy (Caddy APPENDS the client address — the app's rightmost-trusted-hop reading is untouched), `__Secure-*` cookie flip with the https origin, automatic cert rotation, health surface unchanged. Same profile ships the OPS-002-A container hardening: cap_drop ALL (+ explicit NET_BIND_SERVICE on the proxy only), no-new-privileges everywhere, read-only app/worker roots with tmpfs /tmp, PID + memory bounds on every service; the database keeps a writable data plane — documented deviation. Plain-80 base profile explicitly labeled isolated-LAN-pilot-only.
Tests: `tests/audit/deploy-hardening.test.ts` (11 pins: proxy-only ingress, port removal, Caddyfile contract, runbook honesty, hardening matrix, worker/postgres never publish).
Acceptance evidence: static config governance is executable here; `docker compose config` render + live TLS smoke remain NOT VERIFIED — infrastructure limitation (no Docker in this environment), recorded in the test header and NEXT-TASKS; CI execution runner-blocked (CI-001).
Depends on: none.

---

TASK-SUPPLY-001-A — Digest-pinned bases + built-image scanning ✊ → ✅ LANDED (R41, 2026-09-15)

Goal: Immutable inputs; image-level scan evidence.
Landed as: EVERY external base image reference digest-pinned from REAL registry resolutions (no invented values): `oven/bun:1.3.14@sha256:e10577f0…`, `oven/bun:1.3.14-slim@sha256:d56a2534…` (Dockerfile + Dockerfile.worker), `postgres:16-alpine@sha256:cf78e766…` (compose.yml), `caddy:2-alpine@sha256:5f5c8640…` (compose.tls.yml) — tags kept for readability, digests authoritative, inline bump procedure (resolve → update → commit → CI builds+scans). CI scan job now BUILDS both runtime images, runs trivy IMAGE scans (HIGH/CRITICAL fail) on each, and produces per-image CycloneDX SBOM artifacts (`sbom-runtime-images`) on top of the existing fs scan.
Tests: `tests/audit/supply-chain.test.ts` (8 pins: every external FROM digest-pinned with stage-ref exemption, byte-strict registry-resolved digest pins, bump-procedure documentation, CI image build/scan/SBOM steps).
Honest scope: provenance/signing remains owner-side (registry/OIDC infrastructure absent — the audit's E4 "prepare the workflow, mark operational activation owner-side" posture); CI image-scan EXECUTION is runner-blocked (CI-001) and recorded honestly per push. `docker build` locally is NOT VERIFIED (no Docker in this environment).
Depends on: none for authoring (execution remains CI-001-A).

---

TASK-TEST-001-A — Continuous browser + multi-container journeys ✊ → ✅ LANDED (R39, 2026-09-15) as HTTP-level E2E journeys + CI gate

Goal: Close the continuous-E2E gap.
Landed as: `tests/e2e/` — release-critical journeys driven over REAL HTTP against the REAL topology (production standalone server + poll-based worker + PostgreSQL + simulator plane — zero mocks, per the remediation prompt C2 "no giant brittle suite" + C3 "not mocked internal state"): J1 auth (NextAuth CSRF dance → session → authorized route → logout → session dead), J2 inventory (create/read/update/409-duplicate), J3 change lifecycle (submit → MEDIUM bindable approvals → worker-driven execute → SUCCESSFUL; PLUS the failure case failAt=APPLY → truthful FAILED per-step states), J4 API client (token-once → scoped bearer ack → scope refusal → revoke → 401 after), J5 login throttle (burst → 429+Retry-After → full recovery). The harness (`e2e-server.ts`) creates/migrates/seeds its own `fayanms_e2e` database, boots `.next/standalone/server.js` (fresh random secrets per run — the CI fixture values are production-refused by design, P1-019) and a minimal-env worker (SEC-ENV-001 modeled); journeys skip unless `FAYANMS_E2E=1` (the unit gate stays hermetic). `.github/workflows/ci.yml` gained a hard-gate `e2e` job (postgres service + build + `FAYANMS_E2E=1 bun test tests/e2e/`).
**Journey-found P1 regression, fixed in the same commit:** `src/app/api/auth/[...nextauth]/route.ts` dropped the Next.js route context when forwarding POST to NextAuth — `handler(req)` without ctx destructures `nextauth` from undefined → **EVERY runtime credentials sign-in 500'd since R35** (the unit tier mocked the handler and could not see it; the live journey could). Fix: forward ctx (next-auth v4.24.15 awaits params).
Evidence: `FAYANMS_E2E=1 bun test tests/e2e/` → **6/6 pass (52.6 s) against the live stack**; unit suite unchanged (journeys skip: 549 tests / 543 pass + 6 skips).
Honest scope: Playwright/visual browser journeys, RTL-parity and keyboard-only sweeps remain a separate authoring task (A11Y-001-A / browser-E2E) — these are HTTP-level journeys; the CI `e2e` job execution is runner-blocked (CI-001) and recorded honestly on every push.
Depends on: none (was: CI-001-A — decoupled: the journeys run locally and will run in CI the moment runners return).

---

TASK-OPS-003-A — Backup/DR drill + runbook ✊

Goal: Prove recoverability (app loss, DB loss, KEK loss/rotation, interrupted change).
Files: NEW `scripts/drill-restore.ts` (or runbook script), deploy doc D1 expansion.
Implementation: Scripted pg_dump→fresh-host restore→health→simulator restore drill; KEK-loss scenario documented as catastrophic-with-webhook/rotation guidance; RPO/RTO recorded.
Tests: Drill assertions (row counts, health endpoints, snapshot decrypt).
Acceptance: Drill passes from backups alone; runbook executed verbatim.
Depends on: none.

---

TASK-CERT-HW-001-A — Real/virtual appliance certification matrix 👤

Goal: Replace "protocol-harness certified" with per-vendor hardware evidence; unlock safe LIVE restore consideration (FUNC-001).
Files: NEW `docs/certification/MATRIX.md`; harnesses stay as CI anchors.
Implementation: Vendor × firmware × capability matrix (auth, backup, drift, change, fail-fast, rollback, restore, key rotation, interruption, large config); evidence recorded; then optional typed live-restore behind operator opt-in + preflight/canary.
Tests: CI pins that README/deploy claims match the matrix exactly.
Acceptance: Published matrix; claims ≡ evidence.
Depends on: hardware lab access (non-sandbox).

---

TASK-BROWSER-E2E — Playwright/visual browser journeys + axe-core a11y + RTL/keyboard sweeps ✊ → ✅ LANDED (R47, 2026-09-15)

Goal: Close the rendering-layer gap the HTTP-level journeys cannot see.
Landed as: `tests/browser/browser-journeys.test.ts` — 6 journeys in real headless Chromium against the SAME real production topology (shared e2e harness, made liveness-aware so sequential journey files re-boot cleanly): B1 sign-in journey (wrong credentials → honest generic error; real credentials through the REAL NextAuth client flow → app shell; sign-out → gate); B2 dashboard render (search, job center, language switcher, sidebar nav visible); B3a/B3b axe-core scans (wcag2a/aa + best-practice) of sign-in AND the authenticated dashboard — zero critical/serious violations; B4 keyboard-only sweeps (submit reachable without a pointer; 12 Tabs across the shell never drop focus to body); B5 RTL sweep (العربية flips `<html dir>` to rtl with NO horizontal overflow, then back to ltr; the switcher's localized aria-label pinned). THE scan found REAL defects, fixed at the token level in the same increment: light status tokens one WCAG step darker (`--success #166534`, `--warning #92400E`, `--danger #B91C1C`, `--danger-orange #9A3412`, `--info #1D4ED8`), NEW `--primary-ink` (`#1D4ED8`/dark `#60A5FA`) for AA text on primary-tinted fills (brand `--primary` untouched; 18 tinted-text usages swapped), 12 `max-h-96 overflow-y-auto` scrollable regions made keyboard-focusable (`tabIndex={0}`) — design-governance.md table + rules synced.
Tests: suite pinned by `tests/audit/browser-e2e-governance.test.ts` (5 pins: playwright + axe-core declared devDependencies, CI `browser` job + required-checks marker, hermetic skip gating); journeys gated behind `FAYANMS_BROWSER_E2E=1`; suite 600 → 611 (599 pass + 12 skips; 3,365 expects); LIVE evidence 6/6 browser journeys, and 12/12 together with the HTTP journeys in one invocation; CI `browser` job authored (execution runner-blocked — CI-001, recorded honestly per push).
Acceptance: the rendering layer is under continuous executable governance; axe critical/serious = 0 on both scanned surfaces.
Depends on: TEST-001-A (landed — shared harness).

---

## COMPLETED HISTORY (audit trail — not active work)

Every task marked ✅ LANDED above landed as its own green commit with the full local gate loop (lint 0 · full `bunx tsc --noEmit` 0 · full unit suite · prisma validate · drift guard 0 · worker certify · build:gate) and — where the phase produced runtime behavior — live verification evidence; see worklog.md R34–R43 for the per-task reports and the per-commit honest CI records (runner-blocked infrastructure signature documented on every push since run #34).

---

TASK-P3-BATCH — P3 hardening + classifications ✊ → ✅ LANDED (R42, 2026-09-15)

- **P3-AUTH-GUARD (F1): RESOLVED** — R35's contract pins + the R39 source pins (`handler(req, ctx)` forwarding) + E2E J5 live coverage; the journey-found context regression is pinned at source so it cannot regress.
- **P3-LOG / NEW-2 (F2): FIXED** — `package.json start` no longer pipes stdout into an unbounded `server.log`; retention is the process manager's contract (compose json-file caps pinned; bare-metal → journald/logrotate). Deploy-doc note 24.
- **P3-SESSION / NEW-3 (F3): FIXED** — NextAuth `maxAge` 30 d → **12 h** with documented rationale (per-request role/deactivation propagation already revalidates; the lifetime bounds anonymous persistence of valid credential state). Deploy-doc note 23.
- **P3-SSRF / NEW-4 (F4): ACCEPTED RESIDUAL RISK** — classified explicitly in `ssrf-guard.ts` with the threat model (attacker-controlled authoritative DNS between delivery re-check and connect; attacker must already be an authenticated webhook owner) and the refusal reason (a custom DNS-aware dispatcher rewrite risks the guard itself for a theoretical P3). Greppable marker pinned by test; revisit when the egress model is next touched.
- **NEW-1: FIXED** — governance pin: every route file under `/api/v1/auth/*` must stay read-only (GET); a future mutation there fails the test and forces an explicit governance decision instead of silently inheriting the rate-gate exemption.
Tests: `tests/audit/p3-hardening.test.ts` (10 pins).
