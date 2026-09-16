# FayaNMS — R50-T060..T064 UI/UX Hardening — Evidence (2026-09-16, branch `z_ai_v2`)

**Verdict: LANDED** — all five R50.6 tasks implemented, suite green (783 pass / 12 skip / 0 fail), LIVE wire matrix through the real app + real worker + the in-repo IOS SSH harness, browser journey verified with screenshots, zero console errors.

Scope note: this phase is the UI/UX hardening half of roadmap §8 (R50-T060..T064). The audit/telemetry half (§9, R50-T070..T072) remains authorable. R50-T070 groundwork landed here: the audit record now also carries `requestedStages`.

---

## 1. What each task demanded and where it landed

| Task | Demand | Landing |
| --- | --- | --- |
| R50-T060 | Show detection as TWO explicit stages | `DetectionSection` in `src/components/device/device-form-sheet.tsx`: a `Detection — <host>` panel with a vendor row and an address row, each with state icon + headline + detail + stable code line (contract v1 badge in the header) |
| R50-T061 | Show partial success (keep useful results when the other stage fails) | Each row is built ONLY from its own wire block (`buildVendorStageRow` / `buildAddressStageRow`) — matched vendor + failed DNS renders one green row and one red row; nothing is collapsed into one boolean |
| R50-T062 | Never overwrite user changes silently; explicit replace/keep | The ONLY path a result takes into the form is `decideApply` (`src/lib/devices/detection-ui.ts`): empty field → apply; already-equal → no-op; anything else → a chip "Detected <field>: <value> — field has your input" with **Use** / **Keep mine** buttons. Silent overwrite is structurally impossible through this function |
| R50-T063 | Host-key first-contact UX: target, resolved/dialed address, fingerprint before enrollment | The first-contact sub-panel (warning-tinted; success-tinted when pinned): Target (the operator-typed trust identity, R50-T012), Dialed, Key type, OpenSSH fingerprint, and the "verify out-of-band, FayaNMS has NOT trusted this key yet" copy. Absent when the vendor stage did not run — an absent panel is never readable as "verified" (pinned) |
| R50-T064 | Stage-specific retry | Server: the route schema gained `stages: Array<"vendor"\|"address">` (min 1, max 2, optional = both = the historical full run); `resolveRequestedStages` normalizes it; an unrequested stage performs NO work and answers `skipped-not-requested` (a no-op, never a failure). Client: failed/refused rows render a **Retry** button that re-issues the mutation with exactly that stage — an address-only retry does NOT re-probe the device over SSH; a vendor-only retry does NOT do DNS work |

Supporting pure module (NEW): `src/lib/devices/detection-ui.ts` — `decideApply`, `buildVendorStageRow`, `buildAddressStageRow`, `buildHostKeyPanel`, the `StageRow` model. DOM-free by design so the audit suite pins every operator-visible branch.

Contract additions (additive, version stays 1): `vendorDetection.status` and `addressResolution.status` gained `"skipped-not-requested"`; `mgmtIpResolution.mode` gained `"skipped-not-requested"`; `vendorStage` gained `"skipped-not-requested"`; request schema gained optional `stages`. No code was renamed or removed — legacy flat fields and all pre-R50.4 statuses unchanged (R50-T042 governance).

Honest-UI details worth naming:
- The hook's success toast is stage-aware: a skipped stage contributes NOTHING to the summary (an address-only retry cannot report a bogus DNS failure; a vendor-only retry cannot report "no signature matched" for a probe that never ran). The toast title names what RAN.
- The detection section is a child of the sheet CONTENT on purpose: Radix unmounts that subtree on close, so every sheet session starts with a fresh panel — no stale detection story, no effect-driven state reset.
- Vendor/model picks are create-flow only: on edit the vendor select is locked and the edit submit does not persist model — a pick there would silently do nothing on save. The vendor/model ROWS still display on edit (informational); mgmtIp picks work in both modes.
- The retry buttons disable while a mutation is in flight or the hostname is empty; retry re-reads the CURRENT hostname.

## 2. Tests — `tests/audit/r50-detection-ui.test.ts` (NEW, 30 pins) + re-spelled legacy pin

- T062 `decideApply` matrix: empty → apply; whitespace-only → apply; already-equal → noop; differing → STAGE (never overwrite); null → apply; values trimmed.
- T060/T061 vendor row: running / idle / matched (headline names vendorKey; detail carries model · OS · latency) / generic (T054 softMatches stay visible in the detail) / failed (typed code surfaced + retryable) / `skipped-not-requested` (no-op row, NOT retryable, no code) / `skipped-no-credential` (names the fix, not retryable).
- T060/T061 address row: resolved (headline carries the IP; detail says DNS A-record vs "used the entered address") / failed (code + retryable) / refused (IPV6_UNSUPPORTED + retryable) / `skipped-not-requested` / running.
- T063 `buildHostKeyPanel`: capture-requested (target + dialed + key + fingerprint), pinned (verified panel, trust identity still shown), null for skipped/no-run (absent ≠ verified).
- T064 `resolveRequestedStages`: undefined → both; `["vendor"]`; `["address"]`; `["vendor","address"]`; defensive `[]` → both (schema enforces min(1)); `DETECTION_STAGES` literal set pinned.
- Route structure pins re-spelled/added in `tests/audit/r50-detection-contract.test.ts`: resolution still runs AFTER detection and its only gate is the caller's stage SELECTION (never the detection outcome); schema accepts the filter with min(1); the skipped stage answers as a no-op.

Gates on the exact tree: `bun run lint` 0 · `bunx tsc --noEmit` 0 · `bun test tests/` **783 pass / 12 skip / 0 fail, 4,170 expects across 45 files** (753 → 783), with the documented CI-env-shape + root-`.env`-stash/restore discipline.

## 3. LIVE wire matrix (real app :3000 + real worker :3030 + real SSH harness)

Harness: `mini-services/worker/harness/ios-sshd.ts` persona (genuine SSH handshake, ed25519 host key, netadmin / vault-resolved password) on 127.0.0.1:2222 with a queueing bun TCP forwarder onto the sandbox's non-loopback address (21.0.17.144:2222 → 127.0.0.1:2222) so the target passes the R50-T022 target policy as class `public`. Credential profile `cred-r504-harness` (SSH_PASSWORD, port 2222). Signed in via the REAL credentials callback. Every response `contractVersion=1` (data + meta).

| # | Scenario | Wire result |
| --- | --- | --- |
| A | Full run, NO `stages` field (historical payload) | 200 · vendor `executed`/`matched` (`cisco`, model WS-C2960X-24TS-L, matchReasons `cisco.ios-banner, cisco.chassis-memory, cisco.vendor-name`) · `hostKeyState=capture-requested` + fingerprint · address `resolved` 21.0.17.144 (ip-literal) · `errorCode=null` · probe latency 43 ms |
| B | Address-only retry (`stages:["address"]`) | 200 · vendor `skipped-not-requested` / `not-attempted` / hostKeyState `not-probed` — NO device probe happened (the point of T064) · address `resolved` · wall ≈56 ms |
| C | Vendor-only retry, DNS-blackhole hostname (`stages:["vendor"]`) | 200 · vendor `executed` (attempted; the worker dials the requested host verbatim → honest `SSH_UNREACHABLE` failure) · address `skipped-not-requested` — NO bogus DNS failure reported for the skipped stage |
| C2 | Vendor-only retry, reachable endpoint (`stages:["vendor"]`) | 200 · vendor `executed`/`matched` (cisco, full matchReasons, capture-requested + fingerprint) · address `skipped-not-requested` · `errorCode=null` (a skipped stage cannot contaminate the outcome) · probe latency 8 ms |
| D | `stages: []` (empty array) | 400 `INVALID_BODY` ("stages must name at least one stage") with `meta.contractVersion=1` |

Audit trail (`DEVICE_VENDOR_AUTODETECTED`, read back from the embedded PG): every invocation records `requestedStages` (null for the historical full run, `["address"]` / `["vendor"]` for retries), `vendorStage` reflects the skip literal, and the typed stage codes + `contractVersion` ride alongside (T070 groundwork).

## 4. Browser journey (agent-browser, screenshots in `agent-ctx/`)

- `verify-r506-detect.png` (subagent run): Add-Device sheet → hostname 21.0.17.144 + credential `R50.4 Harness` → Detect → panel "Detection — 21.0.17.144 · contract v1", green vendor row "Vendor identified — cisco (WS-C2960X-24TS-L · OS 15.2(4)E7 · 22 ms)", green address row "Management address — 21.0.17.144 (Used the entered address)", and the first-contact panel "First contact — host key captured (NOT enrolled)" with Target/Dialed 21.0.17.144, Key ssh-ed25519, full SHA256 fingerprint + the out-of-band verification copy. Empty fields (vendor/model/mgmtIp) auto-filled.
- `verify-r506-chip.png`: with Management IP pre-typed as 10.99.99.99 → Detect → the chip "Detected Management IP: 21.0.17.144 — field has your input" with Use / Keep mine; **the field still reads 10.99.99.99** (no silent overwrite); vendor row shows the honest "Skipped — no credential profile selected" state; toast "Hostname resolved — Management IP: 21.0.17.144 (as entered)".
- Keep mine → chip gone, field still 10.99.99.99 (DOM-verified). Re-Detect → **Use** → field becomes 21.0.17.144 (DOM-verified), chip gone.
- `verify-r506-retry.png`: hostname `r506-no-such-host.invalid` → Detect → "Address resolution failed / ENOTFOUND / DNS_NOT_FOUND" row WITH a Retry button; the vendor skip row correctly has NO Retry button (exactly one Retry button in the panel — DOM-counted). Clicking Retry re-ran the ADDRESS stage only (wire matrix case B proves no device probe) and refreshed the row.
- `verify-r506-mobile.png`: 390×844 viewport — `scrollWidth 390 == clientWidth 390` (no horizontal scroll), both stage rows render, footer present.
- Console: 0 errors, 0 page errors. `dev.log` tail clean; app healthy (200) after teardown.

## 5. Honest scope

- Remote CI remains platform-blocked since `27e0eea` (OWNER-CI-001) — gates are local (lint/tsc/tests) + live wire + browser evidence, as for every z_ai_v2 phase.
- The `failWithMeta` error-envelope stamp still covers this route only (repo-wide adoption is deliberate future work).
- The Edit-device sheet shares `DetectionSection`; its panel-absent-until-detect state is exercised by the component contract (child of sheet content) and the create-flow journeys above; a dedicated edit-mode browser journey was not separately recorded this phase.
- Real-device certification remains lab-side (R50-T090..T092 / LAB-CERT-HW-001).
- R50-T070..T072 (structured audit enrichment + operational metrics) are the next authorable R50 phase; this phase landed the `requestedStages` audit field as its groundwork.
