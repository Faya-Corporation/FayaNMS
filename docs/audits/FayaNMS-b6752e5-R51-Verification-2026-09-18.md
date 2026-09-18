# FayaNMS — R51 Increment Verification Report (commit `b6752e5`)

**Date:** 2026-09-18
**Scope:** Independent verification of the R51 re-audit increment (commit `b6752e5` on branch `z_ai_v2`) — every remediation claim re-derived from the tree, all gates reproduced in the CI environment shape, and the deployed stack exercised live (HTTP + browser) for behavioral proof.
**Method:** fresh read-only derivation (no reliance on the increment's own prose), full gate battery, live wire checks, browser golden path + adversarial dial test.
**Upload note:** the user-side upload of this report's namesake file did not land in the sandbox (`upload/` empty); per protocol the filename itself defined the task — verify commit `b6752e5` (R51).

---

## 1. Verdict

**PASS — the R51 increment is verified true on the audited tree.** Every claim in the R51 re-audit increment (commit message, NEXT-TASKS LANDED block, repo worklog) reproduced exactly:

| Claim | Expected | Observed | Verdict |
|---|---|---|---|
| Tree fingerprint | `z_ai_v2` @ `b6752e5`, clean, pushed | `git status` clean; HEAD == `origin/z_ai_v2` @ `b6752e5` | ✅ |
| Gate: lint | 0 issues | 0 issues | ✅ |
| Gate: tsc full | 0 errors | 0 errors | ✅ |
| Gate: suite | 884 pass / 18 skip / 0 fail, 4,754 expects, 51 files | **884 / 18 / 0, 4,754 expects, 51 files** (4.68 s) | ✅ exact |
| R51-A1 (F-1): dial-plane target policy | guardDialTarget on every live dial plane | verified statically (§3.1) AND behaviorally live (§4.2) | ✅ |
| R51-A2 (F-2): meta username disclosure closed | no credential-profile usernames pre-auth | verified statically (§3.2) AND on the live wire (§4.1) | ✅ |
| R51-D1: matrix prose pinned | COVERED=24, 4-disposition partition=41 machine-pinned | `r50-test-matrix.test.ts:144-155` | ✅ |
| R51-D2/D3: hygiene | `/db/META-INF/` gitignored; README OWNER-GOV-001 ×3 | in commit `b6752e5` diff | ✅ |

---

## 2. Environment at verification time

- Branch `z_ai_v2` @ `b6752e5` ("audit(R51): independent production re-audit 2026-09-18 — F-1 dial-plane target policy enforced, F-2 meta username disclosure closed, matrix prose pinned"); working tree clean; HEAD identical to `origin/z_ai_v2`.
- Deployed stack: app :3000 (next-server 16.3.4), worker :3030 (`bun --hot`), embedded PostgreSQL 16.4 :5433 — all healthy.
- Process/commit chronology consistent with the increment protocol: server processes started 23:23–23:24 with the remediated working tree; the commit recording it landed at 23:29 (verification-before-commit as documented).

## 3. Static verification (file:line re-derivation)

### 3.1 R51-A1 — guardDialTarget governs every live dial plane ✅

- **Definition:** `mini-services/worker/adapter-router.ts:135` — `guardDialTarget()` resolves and validates the dial target through `resolveTargetForDial` (`target-policy.ts:233`), throwing the typed `TargetPolicyError`.
- **resolveAdapter (both transports, pre-vault):** WebAPI path dials `webApiDialHost = await guardDialTarget(...)` (`adapter-router.ts:236`); SSH path dials `sshDialHost = await guardDialTarget(...)` (`adapter-router.ts:268`). Because both guards run inside adapter resolution, **every** caller of `resolveAdapter` inherits the control.
- **CONFIG_BACKUP runner:** `mini-services/worker/runner.ts:255` — `await resolveAdapter(target, credential, { hostKeyPin })`; the runner has no other dial path (the job payload address feeds `resolveAdapter`, not a raw dial). The F-1 finding's primary escape is closed.
- **Direct worker endpoints:** `/live/fetch-config` → `const dialHost = await guardDialTarget(host)` (`mini-services/worker/index.ts:529`); `/live/apply` → same (`index.ts:823`); the detection plane keeps its dedicated `resolveTargetForDial` (`index.ts:644`). The r51 suite pins the exact wiring: `tests/audit/r51-dial-target-policy.test.ts:267` requires the `guardDialTarget(host)` pattern exactly twice in `worker/index.ts`.
- **App-plane test-connection:** `src/app/api/v1/devices/test-connection/route.ts:137-139` delegates to the worker's governed live plane (no app-side raw dial); the app probe plane keeps `evaluateTargetPolicy` (`auto-detect/route.ts:337`).
- **16-pin suite present:** `tests/audit/r51-dial-target-policy.test.ts` (11.3 KB) — decision matrix, fail-closed RRset, pre-vault order proof, SIMULATOR untouched, runner/index wiring. All 16 pass in the reproduced suite.

### 3.2 R51-A2 — meta username disclosure closed ✅

- `src/app/api/v1/meta/route.ts:45-46`: the credential-profile select is `{ id: true, name: true, type: true }` with the in-code guard comment *"R51-A2: no `username` here — pre-auth bootstrap surface."*
- The only remaining `username` in the payload is the **users map** shaping `username: user.email.split("@")[0] ?? user.id` (`:62`) — the authenticated-identity email local-part explicitly classified acceptable in the R51 audit (not a credential-profile operator username).

### 3.3 R51-D1 — matrix prose machine-pinned ✅

- `tests/audit/r50-test-matrix.test.ts:144-155`: "R51-D1 — §4 prose counts are pinned to the §3 registry (26→24 COVERED drift)" — `count("COVERED") === 24`, the four dispositions partition exactly 41, and the literal §4 sentences are pinned. The prose drift class is now CI-enforced shut.

### 3.4 R51-D2/D3 — hygiene ✅

- Commit diff: `.gitignore` +2 (covers `/db/META-INF/` embedded-PG artifacts); `README.md` −3/+3 (OPS-001 → OWNER-GOV-001 ×3).

## 4. Live verification (deployed stack)

### 4.1 R51-A2 on the wire ✅

`GET /api/v1/meta` (unauthenticated, session-exempt surface) returns `credentialProfiles` objects with keys **`["id","name","type"]`** — zero operator usernames. The lone `username` string in the payload is the users-map email local-part (`"admin"`), the accepted identity shape.

### 4.2 R51-A1 behavioral proof (browser, adversarial dial) ✅

Golden-path + adversarial sequence against the deployed stack (already authenticated admin session):

1. Devices → **Add Device**: hostname `guard-e2e-01`, management IP `127.0.0.1` (governed loopback class), vendor `Generic (SNMP)`, data plane **Live device (read-only SSH)**, credential profile **Network Admin — SSH password** → device created successfully (the refusal must be at dial time, not admission time — as designed).
2. Device detail → **Test connection** → the live dial plane answered:

   > `SSH_TARGET_POLICY_REFUSED: loopback — the target network policy refuses this address class before any credential or connection work`

   — the F-1 remediation working end-to-end on a REAL live-plane dial (credential profile assigned; the worker refused **before** any credential/connection work, matching the pre-vault order proof).
3. The page simultaneously shows the SAFE-001 fail-closed posture ("No pinned host key — live connections are REFUSED (fail-closed)") and the audit event `DEVICE_CONNECTION_TESTED — guard-e2e-01` was recorded.
4. **F-2 UI confirmation:** the credential-profile picker renders only `name · type` rows ("Config Backup — SSH key · SSH_KEY", "FortiGate API token · API_TOKEN", "Network Admin — SSH password · SSH_PASSWORD") — no operator usernames anywhere in the operator surface.

Screenshot: `agent-ctx/verify-r51ver-f1-loopback-refusal.png`.

### 4.3 Incidentals observed (all healthy)

- **Zod query validation on the wire:** `pageSize=200` → `400 INVALID_QUERY ("pageSize: Too big: expected number to be <=100")` — the validation layer actively enforced.
- **Auth chain on the wire:** unauthenticated `curl` of `/api/v1/devices` → `401 UNAUTHENTICATED` (proxy gate); authenticated in-page `fetch` succeeded (31 devices).
- **Cleanup:** the artifact device was decommissioned via PATCH (status `UNMANAGED`, credential detached, data plane → `SIMULATOR`, description marked as the R51 verification artifact). Note: the device `[id]` route intentionally exposes GET/PATCH only (no DELETE) — decommissioning is the supported lifecycle path.
- **Stack after teardown:** app :3000 → 200; worker `/health` → `{"ok":true,...}` (141 jobs completed, 0 failed); PG :5433 ready.
- **Console:** 0 errors (HMR/DevTools info lines only). **Mobile 390×844:** no horizontal scroll. Screenshot: `agent-ctx/verify-r51ver-mobile-390.png`.

## 5. Honest scope & limitations

- `build:gate` remains unexecuted in this sandbox (documented OOM ceiling with the deployment stack resident — unchanged since R50.8; compile-plane evidence is the full `tsc --noEmit` 0 + the 51-file suite).
- The suite was reproduced in the **CI env shape** (ci.yml:91-96, `.env` planes stashed/restored) per the documented protocol — a bare sandbox run auto-loads local EdDSA keys and yields ~24 environment-caused failures that are NOT code defects (§6 of the R51 re-audit).
- GitHub Actions remains runner-blocked (OWNER-CI-001) and branch protection off (OWNER-GOV-001) — both outside sandbox control, unchanged.
- The verification exercised the loopback governed class (the F-1 finding's canonical case). The full address-class decision matrix remains covered by the hermetic 16-pin suite rather than re-played live here.

## 6. Conclusion

Commit `b6752e5` does exactly what it claims: the F-1 dial-plane gap is closed on every live transport and endpoint (statically wired AND behaviorally refusing a real loopback dial pre-credential), the F-2 pre-auth username disclosure is gone from the wire and the UI, the matrix prose is machine-pinned, and the hygiene corrections are in. All gates reproduce exactly (884/18/0). The R51 increment stands verified; the remaining open items are unchanged and exclusively owner-side (OWNER-CI-001, OWNER-GOV-001) and lab-side (R50-T090..T092 real-device certification).
