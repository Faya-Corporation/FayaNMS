# FayaNMS — R61: P0 Remediations from the Independent Re-Verification — 2026-09-18/19

Branch `z_ai_v2` · responds to the independent re-verification of `38c93f1`
(reviewer verdict: NO-GO; findings: 2 P0 + 2 P1 authorable + INFO drift). This
round closes **both P0s**. The P1 pair follows in R62; the INFO doc drift and
the runbook ordering error in R63.

## 1. P0-1 — credential-free SSH first contact (worker)

**The finding (confirmed in-tree at `38c93f1`):** enrollment mode resolved the
REAL vault secret, built a credentialed ssh2 connection, captured the host key
through a `hostVerifier` that returned `true` when no pin existed — password
authentication proceeded BEFORE the operator could verify the captured
fingerprint. Both the enrollment probe and auto-detect sent real credentials
with `enrollHostKey: true`. The existing pin even encoded the flaw
("enrollment mode → adapter resolves").

**The fix — the required invariant is now structural:**

| Layer | Change |
|---|---|
| `ssh-transport.ts` | NEW `captureSshHostKey({host, port})` — the parameter TYPE accepts no credential material; the connect config carries no password/private key (only ssh2's mandatory username field, filled with a FIXED non-secret marker `fayanms-hostkey-probe`); no auth method exists. The `hostVerifier` captures the presented key and returns FALSE — the handshake aborts DURING key exchange, so the SSH protocol never reaches authentication. The post-capture abort is the EXPECTED outcome (resolved with `{keyType, fingerprint, latencyMs, banner}`); pre-capture transport failures stay typed `SshError`. A `ready` event (structurally unreachable) is treated as a config bug and kills the connection. |
| `ssh-transport.ts` | The legacy `onHostKey` capture mode is REMOVED from `SshCredentials` — a credentialed connection without a pin is now structurally impossible (type-level retirement, HC-3 style). |
| `adapter-router.ts` | The enrollment branch runs BEFORE `resolveVaultSecret` (zero vault access) and throws `HostKeyCaptureSignal` carrying the captured key. NEW `captureTimeoutMs` option bounds the capture window. |
| `worker/index.ts` (`/simulate/connect`) | Catches `HostKeyCaptureSignal` → answers the SAME enrollment shape as before (`ok:true` + `hostKey{keyType,fingerprint}` + latency/banner) — the app contract is unchanged; the difference is that NO credential was ever resolved and NO authentication was ever attempted. |
| `worker/index.ts` (detect) | Dial policy runs BEFORE the vault (a policy refusal never reads a secret). `enrollHostKey=true` without a pin → credential-free capture → `ok:true` + `hostKey` + `detectionDeferred:true` — NO `DETECT_COMMANDS`, NO vault. Detection is a genuine two-stage flow now: pin the captured key, re-run over the pinned (verified-pre-auth) path. |
| `auto-detect/route.ts` (app) | Handles `detectionDeferred` as a capture-stage SUCCESS (no failure metric, audit SUCCESS, outcome `not-attempted`), forwarding `hostKeyCaptured` with `hostKeyState: "capture-requested"` — the R50 two-stage UI already renders exactly this state. |
| `scripts/demo-fleet-probe.ts` | Runs the credential-free capture FIRST, then the credentialed probe — no capture side effect on authenticated connections. |

## 2. P0-2 — canonicalization-safe IPv6 target policy (app + worker)

**The finding (confirmed in-tree):** BOTH `target-policy.ts` copies classified
IPv6 with TEXTUAL rules (`v === "::1"`, `v.startsWith("::ffff:")`), so
equivalent expanded forms — `0:0:0:0:0:0:0:1`, `0:0:0:0:0:0:0:0`,
hex-form v4-mapped `0:0:0:0:0:ffff:7f00:1` — fell through as allowed
`ipv6-global`. (`ssrf-guard.ts` already used group math; the flaw was the
policy pair.)

**The fix:** both copies now parse the literal into its eight 16-bit groups
(`::` compression, uppercase, embedded dotted-quad tail with separator-colon
handling) and classify on GROUP VALUES: unspecified/loopback/v4-mapped
(embedded v4 → the v4 classes)/fe80::/10/ff00::/8. Unparsable IPv6-ish
literals now FAIL CLOSED (`malformed`, refused) instead of riding the global
allow. Policy SCOPE is unchanged: global unicast/ULA/doc-range remain allowed;
private v4-mapped remain allowed; the `FAYANMS_PROBE_ALLOW_SPECIAL` lab hatch
still governs the refused classes. One shared 25-vector corpus pins APP and
WORKER parity.

## 3. Test pins — `tests/audit/r61-p0-ssh-first-contact.test.ts` (7) + rewritten SAFE-001 pin

| # | Pin |
|---|---|
| 1 | **PROTOCOL (gold pin):** against a REAL in-process SSH persona, `captureSshHostKey` yields the persona's TRUE fingerprint and the server-side `authAttempts` counter (NEW on the harness handle) stays **0** |
| 2 | PROTOCOL sanity: the credentialed probe DOES authenticate (`authAttempts ≥ 1`) — counter proven live, normal path intact |
| 3 | ROUTER: enrollment mode signals `HostKeyCaptureSignal` with the persona fingerprint and NEVER consults the vault (bogus secretRef would surface `VaultError` first) |
| 4 | SOURCE: `onHostKey` removed tree-wide; the capture path's no-credential construction is pinned textually |
| 5 | IPv6: 25-vector shared corpus passes on the APP implementation |
| 6 | IPv6: the SAME corpus passes on the WORKER implementation (parity) |
| 7 | v4/hostname zero-regression + documented empty-input asymmetry |
| rewritten | SAFE-001 routing: the old "enrollment → adapter resolves" pin is REPLACED by "enrollment NEVER resolves a credential" (unresolvable secretRef + bounded capture → refusal that is NOT VaultError) |

Supporting: `persona-sshd.ts` gained the `authAttempts` server-side counter
(exposed on the harness handle) — the measurement instrument for the invariant.

## 4. Gates (CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | clean |
| `bunx tsc --noEmit` | exit 0 |
| `bun test tests/` | **947 → 954 pass / 18 skip / 0 fail** (8,151 expects, 58 files) |

## 5. LIVE verification

App root 200 · `/api/v1/meta` 200 · worker service live on :3030 (unauth
control POST → 401, fail-closed intact) · the protocol invariant is proven
behaviorally against the real SSH persona inside the pin suite (the sandbox
has no real device, by definition — that remains LAB's job).

## 6. Honest scope

- The persona harness is a REAL ssh2 server but still a harness — real-device
  certification (R50-T090..T092) is unchanged operator-side work.
- `detectionDeferred` changes the auto-detect UX on TRUE first contact: the
  wizard now shows the capture panel and expects a re-run after pinning (the
  documented R50 two-stage design; previously the single connection silently
  did both — at the cost of the P0).
- The reviewer's uploaded report file did not land in the sandbox (upload/
  empty) — all findings were verified directly against the source tree before
  fixing, per the standing verify-first protocol.
