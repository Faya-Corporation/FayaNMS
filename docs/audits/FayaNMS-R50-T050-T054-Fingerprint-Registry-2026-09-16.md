# FayaNMS — R50.5 Vendor Fingerprinting Hardening (R50-T050..T054) — Increment Evidence

- Branch: `z_ai_v2` · Date: 2026-09-16 · Phase: R50.5 of `FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md`
- Predecessor: R50.4 typed detection API contract (0ce8d63 / 58e9ab0). The R50.4 stage blocks and `contractVersion` stamp are the data layer R50.5 enriches.
- Scope delivered: **R50-T050** per-vendor probe-handler registry · **R50-T051** bounded + sanitized evidence · **R50-T052** deterministic match reasons · **R50-T053** realistic fixtures for Cisco IOS/IOS XE/NX-OS, FortiOS, Aruba AOS-CX, Junos, PAN-OS + generic · **R50-T054** negative fixtures (banners, hostnames, descriptions) with a structural-only attribution policy.

---

## 1. R50-T050 — Fingerprints are a Registry (`mini-services/worker/vendor-fingerprint.ts`)

- The signature array became `VENDOR_REGISTRY: readonly VendorProbeHandler[]` — a **frozen, ordered list of per-vendor probe handlers**. Each handler owns:
  - `vendorKey` + `displayName`;
  - `probeCommand` — the read-only command this vendor answers (`show version` for cisco/hpe/juniper, `show system info` for palo, `get system status` for fortinet; sophos documents the WebAPI transport (CERT-006) honestly — its `probeCommand` is NOT an SSH command and is pinned to never appear in `DETECT_COMMANDS`);
  - `signatures` — matchers with **stable cross-release ids** (`cisco.ios-xe-banner`, `fortinet.status-version`, `palo.model-line`, …) and a declared `strength` (`"structural" | "soft"`);
  - ordered `model` / `osVersion` extractors.
- `getVendorHandler(key)` is the typed registry lookup. Test pins: registry frozen; exactly the six non-generic families in fixed order; ids globally unique + well-formed; every SSH-detectable handler has ≥1 structural anchor (sophos pinned all-soft BY DESIGN); every non-sophos `probeCommand ∈ DETECT_COMMANDS`.
- **Probe-chain informativeness filter (new, R50-T050):** `isInformativeCliOutput()` — real CLIs answer an unknown probe with a SHORT rejection line and (often) exit 0 (Cisco `% Invalid input detected…`, Junos `syntax error…` / `unknown command`, FortiOS `Command fail. Return code -3` / `Unknown action 0`, PAN-OS `Unknown command`). The `/live/detect-vendor` chain now treats those as non-informative and walks to the next allowlist command, so the probe REACHES the command the CLI actually answers (FortiOS answers probe #3, PAN-OS probe #2 — proven live in §5). A LONG output that merely contains an error line stays informative.

## 2. R50-T051 — Evidence is Bounded and Sanitized

- The analysis input is bounded: `ANALYSIS_MAX_BYTES = 262_144` (256 KiB) — `Buffer.from(raw,'utf8').subarray(0, N)`; a signature line placed beyond the bound is never seen (test-pinned adversarial case).
- Sanitization happens **BEFORE matching**: ANSI CSI + OSC escape sequences stripped, C0 controls (except `\t \n \r`) + DEL neutralized — escape sequences can neither spoof a signature line nor hide one, and every token/evidence line is clean text.
- Evidence caps (all exported + pinned): `EVIDENCE_MAX_LINES = 3`, `EVIDENCE_LINE_MAX = 200`, `EVIDENCE_MAX_TOTAL_BYTES = 512` — the TOTAL cap is REAL (3 × 200 > 512, so a third full-length line is dropped; test pins both which cap binds).

## 3. R50-T052 — Deterministic Match Reasons

- `VendorFingerprint.matchReasons: string[]` — the EXACT matched signature ids, in registry declaration order. Deterministic across runs and releases (double-parse deep-equality pinned).
- `confidence` is no longer an opaque score: it is **derived** from the attribution policy ("high" ⇔ attributed via structural evidence, "low" ⇔ generic).
- The audit trail (`DEVICE_VENDOR_AUTODETECTED` afterJson) now records `matchReasons` (+ `softMatches`) — the trail records WHY a vendor was claimed, not just that it was.
- UI: the Add-Device sheet summary gained an additive `Matched: <ids>` line (and `Unconfirmed vendor tokens: <ids>` for generic near-misses); client types are optional-field extensions so older servers stay assignable.

## 4. R50-T054 — Structural-Only Attribution (false-positive prevention)

- **Policy: only STRUCTURAL (CLI-shaped) signatures attribute a vendor. SOFT name tokens never do — alone or in combination.** Soft matches on un-attributed handlers are returned as `softMatches: string[]` on the generic result so the operator sees the near-miss.
- Structural anchors are CLI structure (`Cisco IOS Software`, `NX-OS Version`, `^Version:\s*Forti`, `^Firmware Version:\s*FortiOS`, `^Junos:\s*`, `JUNOS OS`, `^model:\s*PA-`, `^sw-version:\s*\d`); soft anchors are the banner-prone name tokens (`Fortinet`, `Juniper Networks`, `Palo Alto Networks`, `PA-460`, `mx204`, `Sophos`, `FortiGate-100F`, …).
- Honest scope note: hpe's `AOS-CX`/`ArubaOS`/`ProCurve` anchors are product names kept structural (real `show version` always carries them; a MOTD explicitly naming "AOS-CX" is the residual banner risk — documented, accepted).
- **Two pre-R50.5 pins re-spelled** (the roadmap's T054 supersedes the behavior they enshrined; precedent from R50.0/R50.3 pin maintenance):
  - `vendor-detect.test.ts` "Palo Alto PAN-OS banner form → palo" → now pins the banner line as generic + `softMatches: [palo.vendor-name, palo.panos-name, palo.model-token]`;
  - `vendor-detect.test.ts` "Sophos banner text → sophos" → now pins generic + all four sophos soft ids (SFOS rides WebAPI; SSH stays generic BY DESIGN).
- Negative fixtures (`tests/fixtures/detection/negative-*.txt`): a MOTD naming four vendors, vendor-shaped hostnames/prompts, and an inventory/asset text mentioning chassis tokens + image versions — ALL answer generic with the near-miss ids reported; even `FortiGate-100F` + `FortiOS 7.2.4` together in prose never attribute fortinet.

## 5. LIVE E2E — five-vendor wire matrix (real app :3000, real worker :3030, real SSH personas)

Setup (R50.4 runbook): the in-repo persona harnesses (`mini-services/worker/harness/*-sshd.ts` — genuine SSH handshake + password auth + exec channels, ed25519 host keys, `netadmin`/vault-resolved password) bound to loopback :2222–:2226 with per-port bun TCP forwarders onto the sandbox's non-loopback address (21.0.17.144:222x → 127.0.0.1:222x) so targets pass the R50-T022 target policy as class `public`. Additive demo credential profiles `cred-r505-{aoscx,fortios,junos,panos}` (ports 2223–2226) + the R50.4 `cred-r504-harness` (2222). Signed in via the REAL credentials callback; authenticated `POST /api/v1/devices/auto-detect` per persona. Wire results (contractVersion 1 on every envelope; hostKeyState capture-requested = audited first-contact capture, never enrollment):

| persona | outcome | vendorKey | model | osVersion | matchReasons (from the WIRE) | probeCommand |
|---|---|---|---|---|---|---|
| cisco-ios | matched | cisco | WS-C2960X-24TS-L | 15.2(4)E7 | `cisco.ios-banner`, `cisco.chassis-memory`, `cisco.vendor-name` | show version |
| hpe-aoscx | matched | hpe | 1050 Switch Software | FL.10.13.1050 | `hpe.aoscx-name`, `hpe.arubaos-name`, `hpe.hpe-name` | show version |
| fortinet-fortios | matched | fortinet | FortiGate-60F | 7.4.4 | `fortinet.status-version`, `fortinet.chassis-token`, `fortinet.forti-product` | **get system status (probe #3)** |
| juniper-junos | matched | juniper | srx1500 | 21.4R3-S4.9 | `juniper.junos-version-line`, `juniper.kernel-line`, `juniper.junos-name`, `juniper.junos-token`, `juniper.model-token` | show version |
| palo-panos | matched | palo | PA-5410 | 11.0.4 | `palo.model-line`, `palo.sw-version-line`, `palo.model-token` | **show system info (probe #2)** |

The fortios and panos rows ARE the probe-chain fix working live: their personas reject `show version` with authentic short CLI rejections, and the chain walked to the command each CLI answers (FortiOS probe #3, PAN-OS probe #2) — before R50.5 both answered generic from probe #1's error text.

## 6. Browser journey (agent-browser, real UI)

sign-in gate → admin sign-in → Devices → Add Device sheet → Host 21.0.17.144 + cred-r504-harness → Detect → the sheet rendered inline: **"Auto-detect complete — Vendor signature: cisco · Model: WS-C2960X-24TS-L · OS: 15.2(4)E7 · Matched: cisco.ios-banner, cisco.chassis-memory, cisco.vendor-name · Management IP: 21.0.17.144 (as entered)"** and auto-filled the form fields (POST /api/v1/devices/auto-detect → 200). Loopback second probe → typed refusal copy **"Auto-detect failed — Probe target refused by the target network policy (loopback)"**. Mobile 390×844 devices view: no horizontal scroll. ZERO console errors. Screenshots: `agent-ctx/verify-r505-autodetect.png`, `agent-ctx/verify-r505-mobile.png` (+ `verify-r505-{signin,dashboard,devices}.png`). App health 200 after harness teardown.

## 7. Gates

- On the exact pushed tree (documented CI env shape; root `.env` moved aside per the parity procedure and RESTORED after): `bun run lint` **0** · `bunx tsc --noEmit` **0** · `bun test tests/` **753 pass / 12 skip / 0 fail, 4,101 expects across 44 files** (from 723 / 3,883 / 43).
- New: `tests/audit/r50-fingerprint-registry.test.ts` — 30 pins across five describe blocks (registry shape/honesty, evidence safety incl. ANSI + control chars + both caps + the 256 KiB window, matchReasons exactness + determinism, seven realistic fixtures, seven negative/policy pins). New fixtures: `tests/fixtures/detection/*.txt` (7 positive, 3 negative).

## 8. Honest scope

- Live evidence covers the five SSH-detectable families through persona harnesses (real SSH protocol, simulated CLI text — certification semantics unchanged); real-device certification remains lab-side (R50-T090..T092 / LAB-CERT-HW-001).
- CI remains platform-blocked since 27e0eea (OWNER-CI-001) — no Actions run for this push; the release gate is the local loop documented above.
- The hpe residual banner risk (a MOTD explicitly naming "AOS-CX"/"ArubaOS"/"ProCurve") is documented and accepted; the corporate-name negatives (the realistic banner case) are covered and pinned.
- `softMatches`/`matchReasons` are additive; the flat legacy fields and the R50.4 stage blocks are unchanged.
