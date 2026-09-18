# FayaNMS — R62: P1 Remediations — Service-JWT Surface Isolation + Sensitive Read RBAC — 2026-09-19

Branch `z_ai_v2` · second half of the response to the independent
re-verification of `38c93f1` (2 P0 closed in R61; the P1 pair here; the INFO
doc drift and runbook ordering follow in R63).

## 1. P1-1 — service-JWT surface isolation at the proxy

**The finding (confirmed in-tree):** `src/proxy.ts` gave any cryptographically
valid service JWT an early `NextResponse.next()` on EVERY `/api/v1` path —
before pathname/scope enforcement, rate limiting, and session checks.
`verifyServiceToken()` returned scopes but nothing required one at that
boundary. A worker token could therefore enter human read surfaces (Dashboard,
Devices, Events, Credentials GETs) whose handlers trust the proxy gate.

**The fix:**

- NEW `isMachineSurface(pathname)`: `/api/v1/worker/` prefix + the three
  service-principal job routes (`/api/v1/alerts/evaluate`,
  `/api/v1/reports/execute`, `/api/v1/metrics/retention/prune`).
- A VERIFIED service token passes ONLY on the machine surface (rate-budget
  exemption preserved there — a live change must never self-throttle).
- A verified token on ANY other path → hard **401 UNAUTHENTICATED**, BEFORE
  the rate gate (no budget burn; matches the F-N1 auth-before-rate semantics).
  A service principal is a machine credential, not a session.
- Invalid/expired tokens keep the pre-existing fall-through (session plane
  401s them; the 3a worker exact routes remain public-with-handler-auth —
  `authenticateServiceRequest` still enforces token AND scope per handler).

## 2. P1-2 — sensitive GET/read RBAC

**The finding (confirmed in-tree):** `GET /api/v1/credentials` returned
username, vault pointer, port and notes with NO explicit permission;
`GET /api/v1/devices/[id]/snapshots` DECRYPTED and returned `rawText` +
`normalizedText` without the `config.download` authorization the dedicated
download route enforces. React masking is not an authorization boundary.

**The fix:**

| Route | Gate |
|---|---|
| `GET /api/v1/credentials` | explicit `requirePermission(request, "admin.credential")` FIRST (the same key already governing POST/PATCH; the only consumer is the admin credentials view). 401/403 without it. |
| `GET /api/v1/devices/[id]/snapshots` | explicit `requirePermission(request, "config.read")` FIRST; the decrypted texts ride ONLY for callers ALSO holding `config.download` (seeded: admin/operator/engineer/manager — auditor/viewer get metadata with the text fields OMITTED and `textIncluded: false`). `decryptSnapshotTexts` runs only on the privileged path — ciphertext is never decrypted for a non-privileged caller. The download route remains the raw-export path with its own audit rows. |

## 3. Test pins — `tests/audit/r62-p1-service-scoping-and-read-rbac.test.ts` (9)

| # | Pin |
|---|---|
| 1 | valid service token on `/api/v1/devices` GET → 401 `UNAUTHENTICATED` (was: free pass) |
| 2 | the same hard 401 on events / credentials / meta-users |
| 3 | the machine surface still passes (worker prefix incl. `status`, + the three job routes → `next()`) |
| 4 | rejected machine-token requests never consume a rate slot (401 pre-budget ×15, no 429) |
| 5 | expired token on a human route → session-plane 401 (worker exact routes stay handler-gated by design) |
| 6 | credentials GET without a session → 401 BEFORE any database work (wire: handler invoked directly) |
| 7 | snapshots GET without a session → 401 BEFORE any database work (wire) |
| 8 | SOURCE: explicit gates + ordering + the server-side text boundary (`textIncluded` / omission / decrypt-after-early-return) |
| 9 | SOURCE: the proxy machine surface set pinned exactly |

## 4. Gates (CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | clean |
| `bunx tsc --noEmit` | exit 0 |
| `bun test tests/` | **954 → 963 pass / 18 skip / 0 fail** (8,198 expects, 59 files) |

## 5. LIVE verification

App root 200 · `/api/v1/meta` 200. The unauth wire envelopes are unchanged
(devices POST → 401 `UNAUTHENTICATED` re-verified in the suite's proxy runs);
the session-bearing journeys are unchanged (no session plumbing touched — the
new gates only ADD refusals for token/principal misuse).

## 6. Honest scope

- The role matrix is untouched: `config.download` remains seeded to
  admin/operator/engineer/manager — the auditor/viewer config experience now
  shows metadata-only rows (`textIncluded: false`); the UI's viewer-layer
  masking continues to work and no longer receives plaintext it must mask.
- `GET /api/v1/credentials` was consumed ONLY by the admin credentials view,
  so the `admin.credential` gate breaks no operator/engineer workflow (the
  device-form pickers read `meta.credentialProfiles`, a different surface).
- Machine-route scope semantics remain handler-enforced
  (`authenticateServiceRequest(request, "<scope>")`) — the proxy now confines
  the principal to the surface; scope checking stays at the handlers that
  know their scopes.
