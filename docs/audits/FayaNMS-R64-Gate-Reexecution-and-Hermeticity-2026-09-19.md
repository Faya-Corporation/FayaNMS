# FayaNMS — R64: Gate Re-Execution (R61–R63 Independently Reproduced) + Unit-Gate Hermeticity Hardening

**Date:** 2026-09-19 · **Branch:** `z_ai_v2` · **Base:** `b6bf443` (R63) · **Protocol:** every verification
claim in this program is now **independently re-executed**, not merely repository-recorded — the standard
set by the independent re-verification of 2026-09-19 (`FayaNMS-38c93f1-Independent-ReVerification-2026-09-19`).

---

## 1. What R64 is

R61–R63 closed all four authorable findings (2 P0 + 2 P1) from the independent re-verification and refreshed
the operator hand-off. Each round recorded a green gate state (final: **967 pass / 18 skip / 0 fail, 8,214
expects, 60 files**). R64 re-executes that verification from a cold shell — and, in doing so, **found and fixed
a unit-gate hermeticity defect** that could have produced a false regression record.

## 2. Re-execution forensics (the defect, in order of discovery)

| Run | Env shape | Result |
| --- | --- | --- |
| 1 | bare shell (only `DATABASE_URL` inherited) | 938 / 18 / **29 fail** |
| 2 | full **dev** env backup sourced (incl. EdDSA pair) | 938 / 18 / **29 fail** |
| 3 | canonical **CI-shape** env (`ci.yml` values) | 949 / 18 / **18 fail** |
| 4 | CI shape + root `.env` **stashed** (true CI topology) | **967 / 18 / 0 fail — exact reproduction** |

**Root cause (verified, not guessed):**

- The sandbox dev `.env` was **regenerated at 2026-09-18 22:57:14** — after R62's commit (22:51:31) and
  moments before R63's commit (22:58:40, whose gate run preceded the regen during that turn's dev-server
  restart). The regenerated file carries a fresh EdDSA identity in the app-side shape
  (`FAYANMS_SERVICE_PRIVATE_KEY` = control key; `FAYANMS_SERVICE_PUBLIC_KEYS` = **worker key only** —
  byte-verified: the list does NOT contain the private key's own public half).
- `bun test` auto-loads the repo-root `.env` into `process.env`, and the worker's env readers
  (`control-auth.ts` canonical + a duplicate in `service-token.ts`) fall back to **reading the `.env` file
  directly** whenever `process.env` is empty/absent — two independent leak channels:
  1. **auto-load channel** — injected key material reaches every plain `process.env` reader (the app-side
     service-JWT core included): mint goes EdDSA with the control key while the same process verifies
     against a list that does not contain it;
  2. **file-fallback channel** — tests that DELETE a service variable (the `withServiceEnv` semantics:
     "this process has no such config") have dev material re-supplied behind their backs.
  Together these poisoned every in-process mint/verify round trip (the 18–29 false failures).
- **CI was always immune** (no `.env` file exists there; the gitignored file never reaches runners).

The tree under test was byte-identical to the pushed R63 commit throughout — **no code regression existed**;
this was purely environment drift invisible to the recorded gates. That invisibility is itself the finding:
a green tree must not fail its own suite because a dev env file changed.

## 3. Hardening (authored in R64)

`readRootEnvValue` (both copies: `mini-services/worker/control-auth.ts`, `mini-services/worker/service-token.ts`)
gains TWO documented, backward-compatible knobs:

1. **Explicit-empty suppression** — a `process.env` value of `""` is authoritative and reads as
   "unconfigured" (previously it fell through to the file). Neutralizes bun's auto-load channel per-variable.
2. **`FAYANMS_SERVICE_ENV_FILE` knob (completion)** — the fallback FILE itself is knob-controlled:
   unset ⇒ repo-root `.env` exactly as before; non-empty ⇒ that named file (fixture support); **explicit
   empty ⇒ the file fallback is disabled entirely**. Covers tests that DELETE variables.

Behavior matrix (no production topology changes):

| `process.env` state | Before | After |
| --- | --- | --- |
| var unset, no knob, `.env` has the key | file fallback | file fallback (unchanged) |
| var non-empty (production) | trimmed value | trimmed value (unchanged) |
| **var explicit `""`** | file fallback ⚠ | **null — deliberate unset** |
| **`ENV_FILE=""`, var unset** | file fallback ⚠ | **null — fully hermetic** |

The gate env contract (`/tmp/fayanms-ci-gate.env`, reproducible from `ci.yml` + the three R64 knobs):

```text
DATABASE_URL=postgresql://fayanms:fayanms-ci-only@localhost:5433/fayanms
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<64-hex test value — ci.yml literal>
FAYANMS_SERVICE_SECRET=<64-hex test value — ci.yml literal>
FAYANMS_CONFIG_ENC_KEY=<64-hex test value — ci.yml literal>
FAYANMS_SERVICE_PRIVATE_KEY=          # R64 knob 1: neutralize bun auto-load of the dev pair
FAYANMS_SERVICE_PUBLIC_KEYS=          # R64 knob 1: neutralize bun auto-load of the dev pair
FAYANMS_SERVICE_ENV_FILE=             # R64 knob 2: disable the worker file fallback entirely
```

With this env the full suite runs green **with the sandbox `.env` present** — no stash dance, and the
sandbox now reproduces the CI topology deterministically. (An intermediate state — knob 2 without the
two knob-1 lines — is itself a false-failure generator: auto-load still injects the dev pair into plain
`process.env` readers. The three knobs are a SET; the gate env above is the canonical shape.)

## 4. Re-executed gates (R64, this branch)

- `bun run lint` → **0 issues**.
- `bunx tsc --noEmit` → **0 errors**.
- Full suite → **967 pass / 18 skip / 0 fail, 8,214 expects, 60 files** at the R63 tree (exact match with
  the R63 record, via the `.env`-stash CI topology), then **972 pass / 18 skip / 0 fail, 8,231 expects,
  61 files** with the R64 hardening + its 5 pins (A–E) included — green WITH the sandbox `.env` present
  under the three-knob gate env (lint 0 · tsc 0).
- LIVE: `GET /api/v1/meta` → **200**; worker `:3030` unauthenticated probe → **401 `WORKER_UNAUTHENTICATED`**
  (fail-closed posture intact).

## 5. Source-level invariants re-verified at the fix sites (not trusted from the ledger)

- **P0-1 (SSH first contact):** `captureSshHostKey` builds a connection with **no password / no private key**
  (fixed non-secret marker username only), `hostVerifier` captures + returns **false** (handshake aborts
  during key exchange), a `ready`-after-auth handler kills the connection and rejects as a config bug, and
  `resolveAdapter`'s **enrollment branch structurally precedes `resolveVaultSecret`** (`adapter-router.ts`
  — enrollment can never reach the vault line). Persona harness `authAttempts` counter remains the
  server-side measurement instrument for the zero-auth invariant.
- **P0-2 (IPv6 canonicalization):** BOTH target-policy copies (`src/lib/net/target-policy.ts`,
  `mini-services/worker/target-policy.ts`) classify via `ipv6ToGroups` **group math** — `::1` in every
  textual form (7 zero groups + 1), IPv4-mapped `::ffff:0:0/96` delegated to v4 classification,
  `fe80::/10` / `ff00::/8` by mask math, unparsable literals fail closed. The old textual rules survive
  only inside the explanatory comments.
- **P1-1 (service-JWT surface isolation):** `src/proxy.ts` — verified service JWTs pass **only**
  `isMachineSurface(pathname)`; any other path answers a hard **401 UNAUTHENTICATED before the rate gate**
  (no budget burn; invalid-token fall-through unchanged).
- **P1-2 (sensitive read RBAC):** `GET /api/v1/credentials` requires **`admin.credential`**;
  `GET /api/v1/devices/[id]/snapshots` requires **`config.read`**, and decrypted `rawText`/`normalizedText`
  ride **only** for `config.download` holders (`textIncluded` flag; decryption runs on the privileged path
  only — React masking is no longer the boundary).

## 6. Scope honesty

- The hermeticity defect was a **sandbox gate** issue; production identity planes (each process reading its
  own configured material) and CI (no `.env`) were never affected.
- The operator path is unchanged and remains exactly as corrected in R63: restore CI runner capacity → run
  HC-6 via **workflow_dispatch or the z_ai_v2→main candidate PR** → protect `main` (TASK-GOV-001-A) →
  hardware certification (demo fleet Step 0 available) → protective merge → **independent final audit on the
  final release SHA**.
