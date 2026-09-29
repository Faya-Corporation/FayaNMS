# FayaNMS — Independent Review of the ULTRA Production-Readiness Audit (2026-09-13)

**Reviewed artifact:** `FayaNMS-ULTRA-End-to-End-Production-Readiness-Audit-2026-09-13.md` (external audit, verdict **BLOCKED**, score **74/100**)
**Reviewed against:** local clone of `Faya-Corporation/FayaNMS`, audited commit `5ca36a5` (= current `origin/main`; one later local commit `a3b761b` adds a screenshot PNG only — zero source delta)
**Review method:** every claim re-derived from source, not trusted. Each cited file was opened and the defect located at line level. Live GitHub API used for branch protection + CI state. Full local test run executed.
**Review verdict:** **THE AUDIT IS ACCURATE.** All 5 P0s, all 8 sampled P1s, and all 3 sampled P2s were **CONFIRMED** at the cited locations. The BLOCKED verdict and the "remediation sprint before new features" directive are **accepted**.
**Review mode:** read-only; this document adds evidence, two nuances the audit understated, and five items it missed.

---

## 1. Evidence Re-Verification Matrix

### P0 release blockers — 5/5 CONFIRMED

| ID | Claim | Verified evidence | Verdict |
|---|---|---|---|
| P0-001 | SSH server host key not verified | `mini-services/worker/ssh-transport.ts` `openConnection()` — `client.connect({host, port, username, password, readyTimeout, keepaliveInterval})`; **no `hostVerifier`, no fingerprint pin**. Every connection (probe, exec, CLI write session) accepts any server key. Schema has no `sshHostKey*` fields. | **CONFIRMED** |
| P0-002 | Rate limit evaluated after side effects | `src/app/api/v1/_lib/api.ts` — `ok()` L179, `fail()` L194, `failWithDetail()` L215 all call `govern()` **at response-construction time**; a handler that already committed a transaction can be turned into `429`. `resolveIp()` trusts client-supplied `X-Forwarded-For` blindly (L57, L122). | **CONFIRMED** |
| P0-003 | Execution not single-flight; step claim non-atomic | `changes/[id]/execute/route.ts` — POST unconditionally creates a new `QUEUED` `CHANGE_EXECUTE` `JobExecution` for any APPROVED/SCHEDULED change; no idempotency key, no partial unique index, transaction does not guard duplicates. `worker/change-step/route.ts` — step picked via `change.steps.find(s => s.status === "PENDING")` (L556) then marked RUNNING by **blind id update** (L649); no `UPDATE … WHERE status='PENDING'` CAS with rowcount check. | **CONFIRMED** |
| P0-004 | Restore does not restore the selected snapshot | `restore/route.ts` — target snapshot used **only** in `title`/`description` prose and audit `afterJson`; steps are generic CHECK/BACKUP/APPLY/VALIDATE/BACKUP; no typed operation carries `snapshotId`. Engine side — `applyLiveDevice()` loads the job's **PRE_CHANGE** snapshot (L1278), `extractLiveAnchor()`, posts `plan {kind:"APPLY", anchor, slug}` (L1324). The approved restore target is never read by the execution engine. | **CONFIRMED** |
| P0-005 | Multi-device APPLY continues past first failure | `worker/change-step/route.ts` L1091–1143 — the APPLY loop contacts **every** `change.devices` entry (LIVE `applyLiveDevice()` or simulator apply) and only evaluates `anyFailure` **after** the loop; later LIVE devices really are modified, then labeled `SKIPPED` in the DB update (L1148–1165). | **CONFIRMED** |

### P1 gaps — sampled 8/8 CONFIRMED

| ID | Claim | Verified evidence | Verdict |
|---|---|---|---|
| P1-001 | No two-person CAB quorum | `prisma/schema.prisma` L416 `@@unique([changeId, level])` — exactly one decision per level. | **CONFIRMED** |
| P1-003 | Business-hours risk uses server-local tz | `src/lib/change/risk.ts` `isBusinessHours()` L106–112 — `date.getDay()`/`getHours()`, no IANA tz; affects approval-level policy. | **CONFIRMED** |
| P1-005 | "Vault" is env-var lookup | `mini-services/worker/vault.ts` L39 — `vault://ssh/network-admin` → `FAYANMS_VAULT_SSH_NETWORK_ADMIN`. | **CONFIRMED** |
| P1-007 | Symmetric service JWT trust | `src/lib/auth/service-auth.ts` L121 — HS256 shared-secret only; holder of the secret can mint any token. | **CONFIRMED** |
| P1-010 | Webhook SSRF | `admin/webhooks/route.ts` — URL validation is `z.string().url()` + http(s) scheme only; no loopback/private/link-local/metadata blocking; no redirect/DNS re-check policy. | **CONFIRMED** |
| P1-011 | Webhook secret plaintext in DB | `prisma/schema.prisma` L774 `WebhookEndpoint.secret String`. | **CONFIRMED** |
| P1-012 | API-client bearer auth not wired | `admin/api-clients/route.ts` L30–31 self-documents: "no route validates tokens yet"; `lastUsedAt` stays null by design. | **CONFIRMED** |
| P1-017 | `main` unprotected while docs claim protected | Live GitHub API: `branches/main → protected: false` (checked this session); `README.md` L212 still states "`main` is protected"; CI badge alt-text says "gate + scan required on main". | **CONFIRMED** |

### P2 / misc — sampled 3/3 CONFIRMED

| ID | Claim | Verified evidence | Verdict |
|---|---|---|---|
| P2-1 | Prisma query logging in production | `src/lib/db.ts` L12 `log: ['query']`. | **CONFIRMED** |
| P2-3 | `db:push --accept-data-loss` under ordinary name | `package.json` L12 `"db:push": "prisma db push --accept-data-loss"`. | **CONFIRMED** |
| P1-019 | CI sample secrets satisfy production shape validation | `.github/workflows/ci.yml` L89/91 uses deterministic `6b1f0f4c…9a03` for `NEXTAUTH_SECRET` + `FAYANMS_CONFIG_ENC_KEY`; `src/lib/startup/security-policy.ts` `KNOWN_BAD_SECRETS` contains only the pre-P19 example + weak defaults — **the committed CI value passes production validation today**. | **CONFIRMED** |

### Repo/CI fingerprint — matches the audit exactly

| Audit claim | Re-verified | Match |
|---|---|---|
| HEAD `5ca36a5` "feat(live): Phase 22 slice 3 + Phase 23 …" | `git log` | ✅ |
| Commit unsigned | git metadata | ✅ |
| Gate run #25, ID 34733556330, conclusion success | GitHub API (`runs?per_page=3`) | ✅ |
| 118 pass / 0 fail / 377 expectations / 9 files | local `bun test tests/` | ✅ (exact) |
| Five live flavors certified (cisco/fortinet/hpe/juniper/palo) | worklog R17/R18 + `certify.ts` | ✅ |
| `main.protected = false` | GitHub API | ✅ |

---

## 2. Corrections and Nuances (audit-of-the-audit findings)

These do **not** overturn any verdict; they sharpen the record.

1. **N-01 — The step-claim race window is narrower than described, but real.** P0-003 says "two callers can observe the same PENDING APPLY". The engine also has a freshness guard (`STEP_IN_FLIGHT`, `ORPHAN_THRESHOLD_MS = 5 min`, L486–496): a *fresh* RUNNING step makes a second caller back off with 409. The race therefore exists only in the check-then-act gap between L556 (read PENDING) and L649 (blind RUNNING update) — microseconds per caller, but still a genuine TOCTOU under concurrency. The required fix (conditional CAS claim) is unchanged.
2. **N-02 — `ChangeRequest.number` is `@unique`** (schema L326). Concurrent restore/change creation races fail **loudly** (P2002 → 500) rather than silently minting duplicate change numbers. The audit missed this existing invariant; a retry-on-conflict wrapper is a P3 nicety, not a correctness hole.
3. **N-03 — The audit chain already forbids forks at the DB level**: `@@unique([prevHash])` (schema L720). Complements the hash-linking the audit credited; append-only *permissions* (P1-015) remain the open half.
4. **N-04 — Stale header comment**: `worker/change-step/route.ts` L29 still says "the worker never touches SQLite" (PostgreSQL since Phase 21). Cosmetic, but fix alongside P0 work so audit trails stay truthful.
5. **N-05 — A documented false assumption**: `executeApplyStep()` catch-path comment claims "already-applied devices are idempotent (same plan)" (L1110–1111). On real hardware, re-running a plan is plan- and vendor-dependent; this is exactly the retry-duplication hazard the audit's SAFE-003/004 idempotency requirements address. The comment should not survive remediation.

---

## 3. Disposition

- **Accept the BLOCKED verdict** and the claim-level ladder (§15 of the audit): Level 0/1 PASS; Level 2+ BLOCKED.
- **Accept the priority order** (§16): items 1–6 before any new feature work. The previously planned "Sophos WebAPI adapter / further vendor expansion" arcs are **deprioritized behind the P0 safety gate**, per the audit's explicit instruction.
- **Accept the suggested task IDs** (§17) as the remediation backlog taxonomy: SAFE-001…009, TEST-001…003 first; POL/SEC/OPS/API/AI/CERT after.

## 4. Remediation Order (adopted)

```text
1. SAFE-007  Disable/guard inaccurate LIVE restore          ← immediate safe action, smallest diff, kills the most misleading behavior
2. SAFE-001  SSH host-key enrollment + pinning (fail-closed)
3. SAFE-002  Pre-handler mutation rate limiting (+ trusted-proxy policy)
4. SAFE-003/004/005  Execution single-flight, atomic step claim, per-device write lock
5. SAFE-006  Fail-fast/canary multi-device strategy + truthful per-device states
6. TEST-001/002/003  Concurrency / restore / host-trust suites
→ then POL-*, SEC-*, OPS-* per audit §16
```

Each step lands as an independently CI-green commit; `bun test` grows with every step; no live-write behavior becomes less restrictive at any point.

---

*End of independent review — 2026-09-13. Reviewer: FayaNMS engineering (re-verification pass). No source files were modified for this review.*
