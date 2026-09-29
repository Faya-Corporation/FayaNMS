# FayaNMS — Updated Full Repository Audit, Security Review & Production-Readiness Roadmap

**Repository:** `https://github.com/Faya-Corporation/FayaNMS.git`  
**Default branch:** `main`  
**Re-audited remote HEAD:** `d72cc9ecbb5ae427b585482825c01007b8fcfd10` (`d72cc9e`)  
**Re-audit date:** 2026-09-10  
**Previous audited baseline:** `3a9488061e9053ebbf1b30de3a1f9189a30840af`  
**Previous audit:** `docs/audits/FayaNMS-Full-Audit-Review-2026-09-09.md`  
**Review type:** Read-only source audit + remediation verification + architecture/security reassessment  
**Status:** **PRODUCTION BLOCKED**  
**Estimated production readiness:** **61/100**

---

# 1. Executive Summary

FayaNMS has improved materially since the first production-readiness audit.

The remediation work after the 2026-09-09 audit successfully addressed several serious findings:

- client-controlled `actAsUserId` was removed from the reviewed production flows;
- actors are now derived from the authenticated user session;
- raw configuration download gained an explicit `config.download` permission;
- restore no longer accepts the old `autoApprove` shortcut;
- worker-facing Next.js endpoints now require a machine JWT instead of accepting anonymous mutation;
- `.env.example` no longer ships usable secrets;
- production startup rejects missing/weak/demo security configuration;
- configuration snapshots now use AES-256-GCM envelope encryption;
- the runtime SQLite DB/WAL/SHM files are ignored instead of intentionally tracked;
- TypeScript build errors are no longer ignored;
- React Strict Mode is enabled;
- the audit chain gained a database uniqueness guard on `prevHash` with conflict retry;
- the old arbitrary-port Caddy proxy was reduced to an allowlist;
- UX/browser evidence was expanded substantially, including a full 43-view 320px reflow sweep and a full 43-view 1920px cycle;
- CI/security scan definitions were authored.

These changes deserve credit.

However, the re-audit found a **critical authorization gap that invalidates the statement that all Phase-19 P0 findings are closed**.

The key issue is:

> **FayaNMS now has server-authoritative identity, but it still does not have server-authoritative permission enforcement across the core change workflow.**

The role matrix defines permissions such as:

```text
change.create
change.approve
config.download
```

but several high-risk routes only authenticate the user; they do not enforce the required permission.

In particular:

- `POST /api/v1/changes/[id]/approvals`
  - authenticates the user;
  - enforces requester-vs-approver separation for HIGH/CRITICAL;
  - **does not require `change.approve`;**
  - **does not validate that the actor is authorized for TECHNICAL, SECURITY, MANAGER, or CAB level.**

- `POST /api/v1/changes/[id]/execute`
  - authenticates the user;
  - verifies the change state;
  - verifies no approvals remain PENDING;
  - **does not require a `change.execute` permission.**

- `POST /api/v1/devices/[id]/snapshots/[snapshotId]/restore`
  - authenticates the requester and creates an approval-required emergency change;
  - **does not require a `config.restore` / `change.create`-equivalent privilege.**

- `POST /api/v1/changes`
  - correctly derives requester identity from the session;
  - **does not enforce the seeded `change.create` permission.**

The coarse middleware only special-cases the `auditor` role for non-GET operations. A `viewer` is documented as read-only in the seeded permission matrix, but is not globally prevented from POSTing to these permission-unchecked routes.

This is a **P0 authorization / change-control blocker**.

Therefore the current conclusion is:

> **Phase 19 is substantially remediated, but its authorization gate must be reopened and completed before production.**

---

# 2. Updated Verdict

## 2.1 What FayaNMS is today

FayaNMS is a strong enterprise NMS **control-plane and UX prototype** with:

- broad domain coverage;
- mature operational UX;
- meaningful configuration-management concepts;
- a useful change state machine;
- incidents/alerts/NOC/performance/reporting/admin modules;
- English + Arabic/RTL;
- guarded high-risk UX;
- audit-aware engineering;
- job orchestration;
- configuration encryption;
- service-authentication foundations.

## 2.2 What it is not yet

It is not yet a production-grade multi-vendor NMS because:

- high-risk authorization remains incomplete;
- worker service privileges are not scoped;
- the worker mini-service is still publicly proxyable through the sandbox gateway;
- the network data plane is explicitly simulated;
- PostgreSQL/Redis/Timescale/object-storage production architecture is not implemented;
- application unit/contract/integration/E2E/security tests are still missing;
- CI definitions are not activated under `.github/workflows`;
- `main` is not branch-protected and has no required checks;
- audit-chain implementation still has scaling/order edge cases;
- configuration encryption still needs production KMS/keyring/integrity-context hardening;
- the single-route SPA/control-plane co-location remains a production architecture limitation.

---

# 3. Revised Production-Readiness Scorecard

| Dimension | Previous | Updated | Status |
|---|---:|---:|---|
| Product/domain completeness | 84 | **90** | Strong |
| UX/UI completeness | 82 | **89** | Strong / remaining certification gaps |
| Design governance | 82 | **91** | Strong |
| API/domain modeling | 74 | **80** | Good |
| Authentication | 48 | **82** | Major improvement |
| Authorization / RBAC | 26 | **38** | **P0 FAIL** |
| Separation of duties | 22 | **67** | Identity fixed, approval entitlement incomplete |
| Service authentication | 10 | **67** | Anonymous access fixed; scopes/isolation incomplete |
| Configuration confidentiality | 25 | **76** | Encryption implemented; production key management pending |
| Configuration integrity | 45 | **65** | GCM + plaintext SHA; binding/verification gaps remain |
| Audit integrity | 46 | **66** | DB fork guard added; concurrency/order/scale residuals |
| Database architecture | 38 | **40** | SQLite remains |
| Job architecture | 62 | **69** | Good prototype |
| Real network automation | 22 | **22** | Still simulator |
| Reliability/scalability | 40 | **47** | Still single-node/single-writer-oriented |
| Automated testing | 12 | **18** | Runtime shell checks only |
| CI/CD | 10 | **28** | Definitions exist but are not active/enforced |
| Accessibility / responsive evidence | 60 | **86** | Large improvement |
| Repository hygiene | 35 | **72** | Runtime DB tracking fixed |
| Documentation honesty | 45 | **82** | Much improved |
| Overall | **42** | **61** | **PRODUCTION BLOCKED** |

The score increase reflects real remediation. It does **not** indicate that the project can be connected safely to production devices yet.

---

# 4. Finding Status — Previous Audit vs Re-Audit

| Previous ID | Previous Severity | Updated Status | Re-audit decision |
|---|---|---|---|
| SEC-001 Client-controlled acting identity | P0 | **Core issue fixed** | `actAsUserId` removal verified |
| SEC-002 Anonymous worker/service API | P0 | **Anonymous path fixed / residual P1** | JWT exists; service scope isolation incomplete |
| SEC-003 Plaintext config snapshots | P0 | **Fixed / residual P1 hardening** | AES-256-GCM envelope implemented |
| SEC-004 Fixed auth secret/demo defaults | P0 | **Fixed** | blank example + fail-closed startup |
| SEC-005 Raw download authorization | P0 | **Fixed with P2 audit-attribution gap** | explicit `config.download` |
| SEC-006 Seeded restore auto-approval | P0 | **Auto-approval fixed; AUTHZ P0 remains** | restore requester lacks explicit permission gate |
| SEC-007 Arbitrary localhost proxy | P0 | **Arbitrary-port fixed; worker exposure P1 remains** | allowlist still exposes 3030 |
| AUD-001 Audit-chain race | P0/P1 | **Partially fixed** | unique `prevHash` + retry; residual edge cases |
| QA-001 Missing test suite/CI | P0 GA | **Open** | CI definition only; test suite absent |
| QA-002 Ignore TypeScript errors | P1 | **Fixed** | `ignoreBuildErrors:false` |
| DATA-001 DB/WAL committed | P1 | **Fixed going forward** | runtime patterns ignored |
| DATA-002 SQLite/migration safety | P1 | **Open** | unchanged |
| ARCH-001 Simulated data plane | P1 | **Open** | unchanged |
| ARCH-002 Control/data co-location | P1 | **Open** | unchanged |
| AUTH-001 Permission matrix not authoritative | P1 | **REOPENED / upgraded to P0** | critical change routes still lack permission checks |
| DOC-001 Overclaiming | P1 | **Mostly fixed** | README now more honest |
| UX-001 QA evidence gap | P1/P2 | **Substantially fixed** | much stronger matrix evidence |

---

# 5. New / Reopened Critical Finding

# AUTHZ-101 — High-Risk Change Approval and Execution Are Authentication-Gated, Not Permission-Gated

**Severity:** **P0**  
**Status:** **OPEN — PRODUCTION BLOCKER**

## 5.1 Affected critical routes

```text
POST /api/v1/changes
POST /api/v1/changes/[id]/approvals
POST /api/v1/changes/[id]/execute
POST /api/v1/devices/[id]/snapshots/[snapshotId]/restore
```

## 5.2 Evidence — permission matrix exists

The seeded role matrix defines:

```text
operator:
  change.read

engineer:
  change.read
  change.create

manager:
  change.read
  change.approve

viewer:
  *.read
```

This means FayaNMS clearly intends `viewer` to be read-only, engineers to create changes, and managers to approve them.

## 5.3 Evidence — middleware is only a coarse gate

Current middleware:

```text
unauthenticated                → 401
auditor + non-GET/HEAD         → 403
every other authenticated role → route proceeds
```

A `viewer` is not blocked from mutation by middleware.

This is acceptable only if each mutation route performs its own authoritative permission check.

Several critical routes do not.

---

# 6. AUTHZ-101A — Approval Entitlement Missing

File:

```text
src/app/api/v1/changes/[id]/approvals/route.ts
```

The route correctly:

- resolves the session user;
- rejects unauthenticated requests;
- checks HIGH/CRITICAL requester self-approval;
- validates the approval row;
- validates change status.

It does **not** perform:

```ts
requirePermission(request, "change.approve")
```

and does not map approval levels to allowed roles/permissions.

Therefore a non-requester user with an authenticated session but no `change.approve` permission can reach the approval decision code.

## 6.1 More serious: approval-level entitlement is absent

A single permission is not enough for a mature CAB workflow.

The API accepts:

```text
TECHNICAL
SECURITY
MANAGER
CAB
```

but there is no server check proving the user is entitled to decide that level.

Recommended policy:

```text
TECHNICAL → change.approve.technical
SECURITY  → change.approve.security
MANAGER   → change.approve.manager
CAB       → change.approve.cab
```

or policy attributes/groups.

## 6.2 Required fix

At minimum:

```ts
const actor = await requirePermission(request, "change.approve");
```

Then enforce approval level:

```ts
await requireApprovalEntitlement(actor, level, change);
```

## 6.3 Acceptance tests

Must prove:

```text
viewer   cannot approve
operator cannot approve
engineer cannot approve unless explicitly delegated
manager  can approve only allowed level(s)
requester cannot approve own HIGH/CRITICAL
same principal cannot satisfy multiple independent approval levels unless policy explicitly allows it
disabled account cannot approve
expired session cannot approve
```

---

# 7. AUTHZ-101B — Change Execution Permission Missing

File:

```text
src/app/api/v1/changes/[id]/execute/route.ts
```

The route checks:

```text
authenticated principal
APPROVED/SCHEDULED state
no PENDING approvals
```

It does not enforce a `change.execute` permission.

The existing role matrix does not currently define a `change.execute` permission either.

## 7.1 Impact

Once a change becomes APPROVED/SCHEDULED, any authenticated non-auditor principal may be able to queue the execution request.

In the current simulator this drives simulated state.

When real adapters are enabled, the same pattern would become a direct production network-control risk.

## 7.2 Required fix

Introduce explicit permission:

```text
change.execute
```

Recommended role posture:

```text
admin     → yes
engineer  → yes where in scope
manager   → no by default
operator  → no by default
viewer    → no
auditor   → no
```

Add site/device scope.

## 7.3 Stronger execution policy

Execution should verify:

```text
permission
device/site scope
maintenance window
approval freshness
configuration drift since approval
device lock
change lock
credential entitlement
risk policy
```

---

# 8. AUTHZ-101C — Restore Request Permission Missing

File:

```text
src/app/api/v1/devices/[id]/snapshots/[snapshotId]/restore/route.ts
```

The old dangerous `autoApprove` path was removed. This is a significant improvement.

However, the current route only requires an authenticated principal before creating an emergency restore change.

Recommended dedicated permission:

```text
config.restore.request
```

or:

```text
config.restore
```

For high-criticality devices:

```text
config.restore.critical
```

A viewer should not be able to create emergency restore requests merely because a later approval is required.

---

# 9. AUTHZ-101D — Change Creation Permission Missing

File:

```text
src/app/api/v1/changes/route.ts
```

The role matrix already declares:

```text
engineer → change.create
```

but the route only resolves the session actor.

It should use:

```ts
requirePermission(request, "change.create")
```

Otherwise the permission array is descriptive rather than authoritative.

---

# 10. Required Authorization Architecture

The current `requirePermission()` helper is a good start.

It needs to become the default mutation policy.

Recommended pattern:

```ts
const actor = await requirePermission(request, "change.execute");

await authorizeScope(actor, {
  organizationId,
  siteId,
  deviceIds,
});

await authorizeRisk(actor, {
  operation: "change.execute",
  riskLevel,
});
```

## 10.1 Never use only role strings for the final model

Prefer:

```text
Principal
  │
  ├── role
  ├── permissions
  ├── organization scope
  ├── site scope
  ├── device-group scope
  ├── temporary elevation
  └── approval entitlements
```

## 10.2 Create an authorization matrix test

Every mutation endpoint should have a machine-readable policy entry.

Example:

| Endpoint | Permission | Scope |
|---|---|---|
| POST `/changes` | `change.create` | device/site |
| POST `/changes/:id/approvals` | `change.approve.*` | approval level |
| POST `/changes/:id/execute` | `change.execute` | all affected devices |
| POST `/snapshots/:id/restore` | `config.restore` | target device |
| POST backup | `config.backup` | target device |
| set baseline | `config.baseline` | target device |
| alert ack | `alert.ack` | operational scope |
| maintenance write | `maintenance.write` | site |
| firmware upgrade | `firmware.execute` | device |
| ZTP provision | `ztp.provision` | site |

---

# 11. SVC-101 — Service JWT Auth Exists, but Scopes Are Not Enforced

**Severity:** P1  
**Status:** OPEN

## 11.1 Improvement verified

Internal job-engine routes now require a Bearer service JWT.

The verifier checks:

- HS256;
- signature;
- audience;
- expiry;
- future `iat`;
- `iss`;
- `sub`.

This closes the old anonymous mutation finding.

## 11.2 Residual issue

The service token contains:

```text
scopes:
  jobs
  simulate
  alerts
  reports
  metrics
```

The server parses the scopes into `ServicePrincipal`.

But the reviewed worker claim route only checks:

```ts
authenticateServiceRequest(request)
```

It does not check that the principal has a specific scope.

Thus scopes are metadata, not authorization.

## 11.3 Shared symmetric secret reduces service isolation

All trusted services use the same:

```text
FAYANMS_SERVICE_SECRET
```

Any service that knows this secret can mint a token with arbitrary:

```text
iss
sub
scopes
```

The verifier does not enforce an issuer allowlist or per-service key.

## 11.4 Required production model

Prefer:

```text
worker key         → jobs/config/change scopes
report-worker key  → report scopes
scheduler key      → scheduling scopes
collector key      → collector scopes
```

Better:

- asymmetric JWT signing;
- mTLS workload identity;
- per-service secrets/keys;
- issuer allowlist;
- required scope per route.

Example:

```ts
requireServiceScope(request, "jobs.claim");
requireServiceScope(request, "jobs.complete");
requireServiceScope(request, "alerts.evaluate");
requireServiceScope(request, "reports.execute");
requireServiceScope(request, "metrics.prune");
```

## 11.5 Replay hardening

`jti` exists but is not used for replay prevention.

For destructive or one-time service commands, add:

- idempotency key;
- nonce/job transition guard;
- optional replay cache.

---

# 12. GATEWAY-101 — Public Gateway Still Exposes Worker Port 3030

**Severity:** P1 now / P0 before real device worker  
**Status:** OPEN

## 12.1 What was fixed

The old proxy allowed arbitrary localhost port selection.

Current Caddy limits the query-controlled port to:

```text
3000
3030
```

This prevents arbitrary localhost scanning.

## 12.2 What remains

The worker on `3030` exposes unauthenticated routes:

```text
GET  /health
GET  /capabilities
POST /simulate/connect
POST /simulate/generate-config
POST /simulate/apply
```

The worker source comments say the gateway only exposes 3000, but the current Caddy allowlist explicitly permits 3030.

Therefore the worker mini-service remains reachable through the public gateway when the port-selector mechanism is used.

## 12.3 Current impact

Because the worker is a deterministic simulator, impact is primarily:

- internal architecture disclosure;
- resource consumption;
- simulator control exposure;
- future-risk inheritance.

## 12.4 Future impact

If `/simulate/*` evolves into real device operations without the gateway being redesigned, this becomes a direct production-device control exposure.

## 12.5 Required fix

Preferred:

```text
Public gateway
  └── 3000 only

Worker 3030
  └── loopback/private network only
```

If sandbox tooling truly requires public 3030:

- require service JWT at worker HTTP layer;
- expose only `/health` through a dedicated safe proxy;
- remove simulator mutation endpoints from public path.

---

# 13. CRYPTO-101 — Encryption Is Real, but Production Cryptographic Binding Needs Hardening

**Severity:** P1  
**Status:** PARTIAL

## 13.1 Verified improvement

The current implementation uses:

- random 256-bit DEK per snapshot;
- AES-256-GCM for `rawText`;
- distinct IV for `normalizedText`;
- AES-256-GCM DEK wrapping under a master key;
- GCM authentication tags;
- plaintext SHA-256 metadata;
- fail-closed missing-key behavior.

This is a substantial fix.

## 13.2 Current key-management limitation

The master key is:

```text
FAYANMS_CONFIG_ENC_KEY
```

from process environment.

The README correctly labels a keystore/keyring as future work.

Production should move to:

```text
Vault Transit
AWS KMS
Azure Key Vault
HSM-backed KMS
```

rather than a long-lived application-level KEK.

## 13.3 Key rotation limitation

`encKeyId` is stored, but the decrypt path uses the current master key rather than a keyring selected by `encKeyId`.

The migration script therefore needs all rows re-encrypted during rotation.

Production needs:

```text
keyId → resolver → historical KEK/KMS key
```

to support controlled rolling rotation.

## 13.4 Context binding / substitution hardening

GCM authenticates each ciphertext, but the reviewed implementation does not use additional authenticated data (AAD) binding the encrypted payload to metadata such as:

```text
snapshotId
deviceId
version
configType
```

Also, raw download decrypts the payload but does not recompute and compare the plaintext SHA-256 before returning it.

Recommended:

```text
AAD = canonical(
  snapshotId,
  deviceId,
  version,
  configType,
  schemaVersion
)
```

Then:

```text
decrypt
→ recompute SHA-256
→ constant-time compare with stored expected hash
→ only then return/use config
```

This provides stronger defense against DB-level ciphertext-envelope substitution.

---

# 14. AUD-101 — Audit Chain Improved, but Chain Order and Scale Need Rework

**Severity:** P1  
**Status:** PARTIAL

## 14.1 Improvement verified

Current schema now includes:

```prisma
@@unique([prevHash])
```

and the Prisma extension retries on a `prevHash` unique conflict.

This is a meaningful improvement over process-local mutex protection alone.

## 14.2 Residual ordering issue

The verifier walks audit events using:

```text
createdAt ASC
id ASC
```

while the true chain relation is:

```text
prevHash → hash
```

Under concurrent writers:

1. two writes receive timestamps before commit;
2. a later-timestamped event may win the current tail;
3. an earlier-timestamped event may lose, retry, and then chain after it;
4. chronological sort can disagree with link order.

The unique `prevHash` prevents a fork, but it does not guarantee that `(createdAt,id)` ordering is identical to chain-link order.

A robust verifier should follow the chain relation or use a monotonic sequence allocated under the same serialized DB operation.

## 14.3 Genesis/backfill edge

SQLite UNIQUE permits multiple NULL values.

Since `prevHash=null` represents genesis/unbackfilled rows, database uniqueness does not itself guarantee only one root during concurrent backfill across processes.

## 14.4 Verification cap

The verifier still has a default finite maximum row count.

In production, a “valid” result must distinguish:

```text
FULLY_VERIFIED
PARTIALLY_VERIFIED
INVALID
```

Do not return an unqualified success after checking only the first N events.

## 14.5 Recommended Phase-21 implementation

With PostgreSQL:

```text
BEGIN

pg_advisory_xact_lock(hashtext('fayanms_audit_chain'))

read tail

allocate chain_sequence

compute hash

insert audit row

COMMIT
```

Add:

```text
sequence BIGINT UNIQUE
```

and verify by sequence.

For stronger assurance:

- periodic checkpoint hash;
- sign checkpoint;
- store checkpoint outside primary DB;
- immutable/WORM archive.

---

# 15. QA-101 — CI Definitions Exist but CI Is Not Active

**Severity:** P1 / GA blocker  
**Status:** OPEN

## 15.1 Improvement

`docs/ci/ci-gate.yml` now defines:

```text
lint
typecheck
Prisma validation
fresh DB push
i18n parity
production build
gitleaks
semgrep
osv-scanner
SBOM
conditional trivy
```

This is a useful template.

## 15.2 Critical operational reality

The file itself says:

> copy this file to `.github/workflows/ci.yml`

The repository currently has no active `.github/workflows` directory.

The current `main` branch:

- is unprotected;
- has no required status checks.

The audited HEAD has no commit status checks.

Therefore the CI gate is **not currently non-bypassable**.

## 15.3 Required immediate action

Activate:

```text
.github/workflows/ci.yml
```

Then configure branch protection/ruleset:

```text
require pull request
require CI gate
require scan gate
require branch up to date
block force push
block branch deletion
```

For production releases also require:

```text
signed tag
release artifact provenance
SBOM
```

---

# 16. QA-102 — CI Template May Not Be Green on First Activation

**Severity:** P1  
**Status:** VERIFY BEFORE ENFORCEMENT

The secret scan is configured with full history:

```text
fetch-depth: 0
gitleaks history + working tree
```

The repository history previously contained the fixed `NEXTAUTH_SECRET` that the startup blocklist now explicitly treats as public knowledge.

Therefore full-history secret scanning may flag historical material.

This is not a reason to disable secret scanning.

Instead:

1. run the gate;
2. triage all historical findings;
3. rotate anything that was ever real;
4. decide whether history rewrite is required;
5. create narrowly documented allowlist entries only for definitively dead demo values.

Also test every third-party action/tool in a real GitHub Actions run before marking the gate complete.

---

# 17. QA-103 — Application Test Suite Still Missing

**Severity:** P1 / GA blocker  
**Status:** OPEN

Current root `package.json` has no normal:

```text
test
test:unit
test:integration
test:e2e
test:security
```

The `tests/` directory still contains only deployment/runtime shell checks.

The source log explains that test code was blocked by the previous sandbox policy.

That explains the gap; it does not remove the production requirement.

## 17.1 Minimum test suite now required

### Unit

```text
permission matcher
approval policy
risk scoring
config normalization
config encryption/decryption
audit hash canonicalization
alert thresholds
retention
SLA
```

### Authorization integration tests — first priority

Must cover every role:

```text
admin
operator
engineer
manager
auditor
viewer
```

against every critical mutation.

### Change lifecycle

```text
create
submit
approve
reject
schedule
execute
failure
rollback
rollback failure
```

### Service auth

```text
missing token
bad signature
wrong audience
expired
wrong scope
wrong issuer
replay/idempotency
```

### Crypto

```text
round trip
tamper ciphertext
tamper tag
tamper wrapped DEK
wrong KEK
rotation
AAD mismatch
plaintext SHA mismatch
```

### Playwright

```text
auth
RBAC visibility
permission denial
change workflow
config download
restore
incident
reports
Arabic RTL
dark mode
320/375/768/1440/1920
keyboard
```

---

# 18. DATA-201 — SQLite and `db push --accept-data-loss` Remain Prototype-Only

**Severity:** P1  
**Status:** OPEN

`package.json` still defines:

```text
db:push = prisma db push --accept-data-loss
```

The Prisma datasource remains SQLite.

This is acceptable for the deterministic demo.

It is not acceptable for production.

## Required production path

```text
PostgreSQL
Prisma migration history
connection pooling
backup/restore
upgrade test
schema drift check
```

Never use `--accept-data-loss` as a production deployment operation.

---

# 19. ARCH-201 — Real Network Data Plane Still Not Implemented

**Severity:** P1 / product-production blocker  
**Status:** OPEN

The worker adapter source still explicitly states:

```text
SIMULATION engine
no real SSH/SNMP
```

Therefore:

```text
configuration backup
change application
discovery
telemetry
HA
flow data
```

remain demo/simulated semantics.

This is properly disclosed in the README.

## Recommended implementation order

```text
1. Adapter SDK
2. Secret provider
3. SSH transport
4. SNMPv3
5. NETCONF
6. RESTCONF
7. HTTPS API
8. gNMI
9. Cisco certification
10. FortiGate
11. Sophos
12. HPE/Aruba
```

The simulator should remain as a test fixture.

---

# 20. ARCH-202 — Control Plane and Data Plane Still Co-Located

**Severity:** P1  
**Status:** OPEN

Current architecture still places a large amount of business logic in Next.js API route handlers.

Target architecture remains:

```text
apps/web
apps/api
apps/network-worker
apps/collector
apps/scheduler
apps/report-worker
```

Do not perform a big-bang rewrite.

Extract gradually after authorization and tests are in place.

---

# 21. REL-201 — Simulator Worker Contains “Continue After Uncaught Exception” Policy

**Severity:** P2 now / P1 in production worker

The Bun worker intentionally catches:

```text
uncaughtException
unhandledRejection
```

and continues serving.

The comment correctly says this is intentional for the simulator.

Do **not** carry this behavior into the real network worker.

For a production process, an uncaught exception can leave unknown in-memory state.

Preferred:

```text
log structured fatal event
stop accepting new jobs
terminate
supervisor restarts process
lease/reaper recovers job
```

---

# 22. UX-201 — UX Evidence Has Improved Significantly

**Status:** STRONG / NOT YET FULL WCAG CERTIFICATION

The updated design-governance matrix now records real evidence.

Verified/high-value improvements include:

- full 43-view cycle at 1920 light EN;
- full 43-view 320px reflow sweep;
- 768 light/dark EN/AR representative passes;
- keyboard flow at 375/768/1440/1920;
- skip-link focus fix;
- command palette keyboard verification;
- zoom-equivalent sweeps;
- RTL overflow fixes;
- table `sr-only` containment fix;
- SectionCard wrapping fix;
- Device Drivers nowrap fix;
- Calendar legend wrapping.

This is a substantial improvement.

## Remaining UX certification work

- full 43-view dark EN cycle;
- full 43-view AR light/dark cycles;
- full zoom matrix;
- real `prefers-reduced-motion` browser emulation;
- real screen-reader testing;
- known chart-alternative gaps;
- TableHead `scope`;
- 16px checkbox target-size gap.

Recommended current claim:

> **WCAG 2.2 AA target — substantially verified, not fully certified.**

---

# 23. REPO-201 — Runtime State Tracking Fix Verified

**Status:** RESOLVED GOING FORWARD

`.gitignore` now excludes:

```text
/db/*.db
/db/*.db-shm
/db/*.db-wal
/db/*.sqlite
/db/*.sqlite3
*.pid
.zscripts/*.pid
```

This closes the previous forward-looking hygiene issue.

Historical binary DB commits remain in Git history.

Before making the repository broadly public or treating it as a clean production source history:

- assess whether historical DBs contained only deterministic demo data;
- if any real secret/data existed, rotate and rewrite history as necessary.

---

# 24. REPO-202 — Branch Protection and Release Governance Missing

**Severity:** P1

Current `main` is not protected.

Recommended GitHub ruleset:

```text
main:
  require pull request
  require 1+ review
  require CI
  require security scans
  require conversation resolution
  disallow force push
  disallow deletion
```

Release tags:

```text
signed
immutable
artifact checksums
SBOM
provenance
```

Current recent commits are unsigned. Signed commits are optional for development, but signed protected release tags are recommended.

---

# 25. Positive Engineering Findings to Preserve

Do not rewrite the product from zero.

Preserve:

## Domain model

- device inventory;
- sites/interfaces/topology;
- snapshots;
- baseline/drift/compliance;
- change state model;
- approval model;
- incident model;
- alert model;
- SLA;
- maintenance;
- job model;
- reports;
- CMDB;
- collectors;
- firmware;
- ZTP;
- HA/DR concepts.

## API patterns

- Zod DTO validation;
- structured success/error envelope;
- correlation IDs;
- short transactions;
- explicit error codes;
- resource ownership checks;
- audit linkage.

## UX patterns

- PageHeader;
- SectionCard;
- KpiCard;
- status badges;
- technical monospace islands;
- HighRiskActionDialog;
- RTL;
- density;
- command palette;
- NOC wallboard;
- browser QA discipline.

## Security improvements

- session-derived actor;
- `requirePermission` helper;
- service JWT foundation;
- fail-closed startup policy;
- config envelope encryption;
- DB audit fork guard.

---

# 26. Immediate Advice — Stop Feature Expansion for One Short Security Sprint

The best next move is **not Phase 21 infrastructure yet**.

Before PostgreSQL or real devices, complete one focused security sprint:

# Phase 19-C — Authorization Completion Gate

## P19C-AUTHZ-001 — Make permissions authoritative

Add explicit permission checks to every mutation.

Priority:

```text
changes create
changes approve
changes execute
restore
backup-now
baseline
drift decision
firmware
ZTP
collector rebalance
maintenance
alert actions
incident mutations
admin mutations
```

## P19C-AUTHZ-002 — Approval-level policy

Define:

```text
TECHNICAL
SECURITY
MANAGER
CAB
```

entitlements.

## P19C-AUTHZ-003 — Introduce `change.execute`

Update role seed and UI permission response.

## P19C-AUTHZ-004 — Introduce `config.restore`

Do not overload generic config read/write.

## P19C-AUTHZ-005 — Authorization contract inventory

Create:

```text
docs/security/authorization-matrix.md
```

Every mutation endpoint must appear.

## P19C-AUTHZ-006 — Negative authorization tests

This is non-negotiable.

### Phase 19-C exit gate

PASS only if:

```text
viewer cannot mutate
auditor cannot mutate
operator cannot create/approve/execute unless policy grants it
engineer can create but cannot approve by default
manager can approve but cannot execute by default
requester cannot satisfy forbidden SoD
approval level entitlement enforced
admin wildcard works
disabled user denied
```

---

# 27. Phase 20-B — Activate, Then Enforce CI

## Immediate tasks

```text
P20B-001 copy docs/ci/ci-gate.yml → .github/workflows/ci.yml
P20B-002 run it on a PR
P20B-003 fix all scan/runtime failures
P20B-004 add branch protection
P20B-005 require gate + scan
P20B-006 add CODEOWNERS for security-sensitive paths
```

Suggested CODEOWNERS:

```text
/src/lib/auth/                   security owners
/src/lib/audit/                  security owners
/src/lib/config/crypto.ts        security owners
/src/app/api/v1/worker/          platform/security owners
/prisma/                         database owners
/Caddyfile                       platform/security owners
/.github/workflows/              platform/security owners
```

---

# 28. Phase 20-C — Build the Missing Test Foundation

Do this before introducing real device writes.

Order:

```text
1 authorization tests
2 service-auth tests
3 crypto tests
4 audit-chain concurrency tests
5 change state-machine tests
6 worker idempotency tests
7 E2E critical workflows
8 browser matrix automation
```

The authorization tests should be the first code written.

---

# 29. Phase 21 — Production Persistence and Trust Infrastructure

After Phase 19-C/20-B/20-C:

## Database

```text
PostgreSQL
migration history
pg advisory locks
connection pooling
backup/restore
```

## Metrics

```text
TimescaleDB
retention
rollups
```

## Jobs

```text
Redis
leases
distributed locks
idempotency
DLQ
```

## Artifacts

```text
MinIO/S3
encrypted config objects
reports
large exports
```

## Secrets

```text
Vault/KMS
service-specific keys
config KEK keyring
```

---

# 30. Phase 22 — Real Network Worker

Only after the security/test foundation.

## Safety rule

The first real adapter must default to **read-only capability**.

Recommended maturation:

```text
Stage 1:
  facts
  inventory
  backup

Stage 2:
  monitoring

Stage 3:
  dry-run validation

Stage 4:
  controlled change

Stage 5:
  rollback/restore
```

Do not enable writes simply because transport connectivity works.

---

# 31. Required Real-Device Certification Matrix

For each vendor/platform:

```text
supported OS/version
authentication
host-key/cert behavior
facts
inventory
interfaces
neighbors
backup
large config
timeout
auth failure
privilege failure
normalization
diff
pre-check
change
validation
rollback
restore
connection interruption
HA device behavior
```

Production support must be declared at the exact version/platform level.

---

# 32. Revised Production Hard Blockers

FayaNMS must not reach production with any of these:

```text
viewer can approve a change
viewer can execute an approved change
approval level lacks entitlement validation
restore requester lacks permission gate
mutation permission matrix is not server-authoritative
service scopes exist but are ignored
public gateway exposes real worker-control routes
CI workflow is not active
main branch lacks required checks
no automated authorization tests
SQLite used as production control-plane DB
production migrations use --accept-data-loss
real network writes use simulator-era worker safety policy
audit verification can overstate partial-chain verification
config encryption uses unmanaged env KEK at scale
```

---

# 33. Revised Gate Matrix

| Gate | Current status |
|---|---|
| Product UI breadth | **PASS prototype** |
| Design system | **STRONG** |
| 320px reflow | **PASS 43 views** |
| 1920 EN light | **PASS 43 views** |
| Keyboard basic | **PASS evidenced** |
| Full WCAG certification | **PARTIAL** |
| Authentication | **PASS foundation** |
| Session-authoritative actor | **PASS** |
| Permission helper | **IMPLEMENTED** |
| Permission enforcement across mutations | **FAIL — P0** |
| Change approval entitlement | **FAIL — P0** |
| Change execution entitlement | **FAIL — P0** |
| Raw config download permission | **PASS** |
| Restore de-auto-approval | **PASS** |
| Restore requester authorization | **FAIL — P0/P1 boundary** |
| Service JWT authentication | **PASS foundation** |
| Service scope authorization | **FAIL — P1** |
| Config encryption at rest | **PASS prototype** |
| Production KMS/keyring | **NOT STARTED** |
| Audit fork DB guard | **PASS prototype** |
| Production audit sequencing | **PARTIAL** |
| Runtime DB Git tracking | **FIXED** |
| PostgreSQL | **NOT STARTED** |
| Redis/distributed jobs | **NOT STARTED** |
| Real device adapters | **NOT STARTED** |
| Application tests | **FAIL** |
| CI definition | **PASS template** |
| Active GitHub CI | **FAIL** |
| Branch protection | **FAIL** |
| Production GA | **BLOCKED** |

---

# 34. Updated Severity List

## P0

```text
AUTHZ-101
  permission matrix is not authoritative across critical change mutations

AUTHZ-101A
  approval route lacks change.approve + approval-level entitlement

AUTHZ-101B
  execution route lacks change.execute

AUTHZ-101C
  restore request lacks config.restore

QA-001 for GA
  no automated authorization/security regression suite
```

## P1

```text
SVC-101
  service scopes/issuer isolation not enforced

GATEWAY-101
  public gateway still allows worker 3030

CRYPTO-101
  production keyring/KMS + AAD/hash-verification hardening

AUD-101
  audit ordering/genesis/full-verification edge cases

QA-101
  CI template not active

QA-102
  full-history scan activation needs real run/triage

DATA-201
  SQLite + db push --accept-data-loss

ARCH-201
  simulated data plane

ARCH-202
  control/data co-location

REPO-202
  main unprotected / no required checks
```

## P2

```text
raw-download denied audit actor recorded as "unknown"
worker crash policy must not migrate to production
single-route SPA/deep-link limitations
remaining screen-reader/reduced-motion live testing
generic package metadata / repository cleanup items
unsigned development commits
```

---

# 35. Specific Code-Level Recommendations

## Approval route

Replace session-only resolution with:

```ts
const actor = await requirePermission(request, "change.approve");

await requireApprovalEntitlement({
  actor,
  level,
  change,
});
```

## Execute route

```ts
const actor = await requirePermission(request, "change.execute");
```

Then verify affected-device scope.

## Restore route

```ts
const actor = await requirePermission(request, "config.restore");
```

## Create change

```ts
const actor = await requirePermission(request, "change.create");
```

## Middleware

Keep middleware coarse.

Do not try to encode the whole permission system into middleware.

Route/domain authorization should remain authoritative.

## Service routes

```ts
const service = requireServiceScope(request, "jobs.claim");
```

Do not just authenticate.

---

# 36. Recommended Permission Matrix v2

Example:

```text
device.read
device.write
device.delete

config.read
config.download
config.backup
config.baseline
config.restore

change.read
change.create
change.submit
change.approve.technical
change.approve.security
change.approve.manager
change.approve.cab
change.schedule
change.execute
change.cancel

alert.read
alert.ack
alert.assign
alert.suppress

incident.read
incident.create
incident.write
incident.close

maintenance.read
maintenance.write

firmware.read
firmware.execute

ztp.read
ztp.provision

collector.read
collector.rebalance

report.read
report.create
report.schedule
report.export

audit.read
audit.export
audit.verify

admin.user
admin.role
admin.credential
admin.api-client
admin.integration
admin.system
```

---

# 37. Approval Policy Recommendation

Do not encode approval authority only as generic RBAC.

Create policy configuration:

```yaml
approval_levels:
  TECHNICAL:
    permissions:
      - change.approve.technical

  SECURITY:
    permissions:
      - change.approve.security

  MANAGER:
    permissions:
      - change.approve.manager

  CAB:
    permissions:
      - change.approve.cab
    minimum_distinct_approvers: 2
```

Risk policy:

```yaml
LOW:
  required: []

MEDIUM:
  required:
    - TECHNICAL

HIGH:
  required:
    - TECHNICAL
    - MANAGER

CRITICAL:
  required:
    - TECHNICAL
    - SECURITY
    - MANAGER
    - CAB
```

Additional rules:

```text
requester != approver
executor may be different from final approver for critical changes
one user cannot satisfy multiple distinct roles unless policy allows
approval expires after material config drift
approval expires when execution window changes materially
```

---

# 38. Change Approval Freshness

Current pre-check already compares snapshot state around approval.

Build on this.

Invalidate approval when:

```text
target devices change
implementation plan changes
rollback plan changes
risk score increases
maintenance window changes
current config changes
credential identity changes materially
firmware changes
```

Use:

```text
approvalFingerprint
```

computed over canonical change inputs.

Execution requires current fingerprint to match approved fingerprint.

---

# 39. Device Lock Recommendation

Before real writes, create explicit per-device lock semantics.

```text
lock key:
  device:{deviceId}:mutation
```

Protected operations:

```text
change execute
restore
firmware upgrade
destructive ZTP
manual config push
```

Use Redis/PostgreSQL advisory locks with:

- owner;
- lease/TTL;
- heartbeat;
- audit;
- safe recovery.

---

# 40. Configuration Snapshot Commit Semantics

Encryption is fixed, but backup truth should also be upgraded.

Recommended state:

```text
COLLECTED
  ↓
ENCRYPTED
  ↓
PAYLOAD_DURABLE
  ↓
HASH_VERIFIED
  ↓
METADATA_COMMITTED
  ↓
COMMITTED
```

Only `COMMITTED` should satisfy backup compliance.

This will become important when moving payloads to S3/MinIO.

---

# 41. Audit Chain v2 Recommendation

Use:

```text
AuditChainHead
  id = singleton
  sequence
  hash
```

Transaction:

```text
BEGIN
lock head
allocate sequence
compute hash
insert event
update head
COMMIT
```

Event fields:

```text
sequence
prevHash
hash
createdAt
actorType
actorId
action
resource
result
correlationId
payloadDigest
schemaVersion
```

Verifier:

```text
by sequence
not createdAt
```

Add external checkpoint.

---

# 42. CI Activation Checklist

Before declaring Phase 20 CI complete:

```text
[ ] workflow under .github/workflows
[ ] first PR run green
[ ] lint green
[ ] typecheck green
[ ] Prisma validate green
[ ] fresh schema green
[ ] build green
[ ] gitleaks triaged
[ ] semgrep triaged
[ ] osv green/accepted
[ ] SBOM artifact present
[ ] branch ruleset enabled
[ ] required checks enabled
[ ] admin bypass policy documented
```

---

# 43. Test Plan — First 20 Tests to Implement

1. viewer cannot POST `/changes`.
2. operator cannot POST `/changes` unless granted `change.create`.
3. engineer can create change.
4. viewer cannot approve.
5. engineer cannot approve by default.
6. manager can approve allowed level.
7. requester cannot approve own HIGH change.
8. one manager cannot fake SECURITY approval.
9. viewer cannot execute.
10. manager cannot execute by default.
11. engineer with `change.execute` can execute approved change.
12. viewer cannot request restore.
13. engineer without `config.restore` cannot restore.
14. authorized restore requester creates AWAITING_APPROVAL only.
15. service token without jobs scope cannot claim.
16. report worker cannot claim config jobs.
17. wrong service issuer rejected.
18. encrypted config tamper rejected.
19. swapped encrypted snapshot context rejected.
20. concurrent audit writes verify deterministically.

These tests will close more risk than another feature phase.

---

# 44. Recommended Next Three Milestones

## Milestone A — Phase 19-C

**Authorization completion**

Exit score target:

```text
authorization >= 80
no P0
```

## Milestone B — Phase 20-B/C

**Active CI + automated security/contract tests**

Exit requirements:

```text
protected main
required checks
authorization matrix tests
service-auth tests
crypto tests
audit concurrency tests
```

## Milestone C — Phase 21

**Production infrastructure**

```text
PostgreSQL
Redis
Timescale
object storage
KMS/Vault
distributed locks
```

Then begin real adapters.

---

# 45. Updated “Do Not Connect to Production Devices Until” Checklist

Do not connect FayaNMS to write-capable production credentials until:

```text
[ ] P0 authorization fixed
[ ] approval-level entitlements fixed
[ ] change.execute permission fixed
[ ] config.restore permission fixed
[ ] service scopes enforced
[ ] worker 3030 private
[ ] CI active
[ ] main protected
[ ] authorization tests active
[ ] crypto tests active
[ ] PostgreSQL migration complete
[ ] distributed device locks implemented
[ ] Vault/KMS secrets available
[ ] one vendor adapter certified read-only
[ ] one vendor adapter certified change/rollback in lab
```

Read-only lab integration can begin earlier with dedicated low-privilege credentials.

---

# 46. Advice on Roadmap Priority

The current source log says Phase 21/22 were considered infrastructure-blocked and the test suite was blocked by sandbox policy.

That is understandable for that environment.

For the actual project roadmap, do not let sandbox limitations become product architecture decisions.

The priority should be:

```text
NOW
  authorization fix
  activate CI
  add tests

NEXT
  PostgreSQL + Redis + KMS

THEN
  real read-only device adapters

THEN
  controlled write/rollback adapters

THEN
  control-plane extraction / scaling
```

---

# 47. Updated Final Assessment

FayaNMS is materially better than at the first audit.

The remediation shows disciplined progress and several strong fixes are real.

The most important positive change is the move from:

```text
client-selected identity
```

to:

```text
server-authenticated identity
```

But production security requires the next step:

```text
server-authenticated identity
          +
server-authorized action
          +
resource scope
          +
risk/approval policy
```

FayaNMS currently has the first part reliably and only partial coverage of the second.

That distinction matters.

The system should therefore not claim:

> “all P0s closed”

until the change-create/approval/execution/restore permission path is fixed and regression-tested.

A more accurate status is:

> **Phase 19 security remediation: SUBSTANTIALLY COMPLETE — AUTHORIZATION GATE REOPENED.**

---

# 48. Final Recommendation

## Immediate

Reopen:

```text
Phase 19-C — Authorization Completion
```

Make it the next mandatory gate.

## After it passes

Activate:

```text
Phase 20 — CI + Test Foundation
```

## Then

Proceed to:

```text
Phase 21 — Production Persistence
Phase 22 — Real Network Automation
Phase 23 — Control Plane Separation
Phase 24 — Full UX/Accessibility Certification
Phase 25 — Production Hardening / GA
```

The project should remain feature-frozen for high-risk new capabilities until Phase 19-C and Phase 20 are complete.

---

# Appendix A — Re-audit Evidence

## Remote HEAD

```text
d72cc9ecbb5ae427b585482825c01007b8fcfd10
```

Commit:

```text
P20-016 / Phase 24 (G8 QA matrix)
```

GitHub:

`https://github.com/Faya-Corporation/FayaNMS/commit/d72cc9ecbb5ae427b585482825c01007b8fcfd10`

## Important reviewed files

```text
README.md
.env.example
.gitignore
Caddyfile
package.json
next.config.ts

prisma/schema.prisma
prisma/seed.ts

src/middleware.ts
src/lib/db.ts

src/lib/auth/session.ts
src/lib/auth/service-auth.ts
src/lib/startup/security-policy.ts

src/lib/audit/chain.ts

src/lib/config/crypto.ts
src/lib/config/create-snapshot.ts

src/app/api/v1/changes/route.ts
src/app/api/v1/changes/[id]/approvals/route.ts
src/app/api/v1/changes/[id]/execute/route.ts

src/app/api/v1/devices/[id]/snapshots/[snapshotId]/download/route.ts
src/app/api/v1/devices/[id]/snapshots/[snapshotId]/restore/route.ts

src/app/api/v1/worker/claim/route.ts
src/app/api/v1/worker/change-step/route.ts

mini-services/worker/index.ts
mini-services/worker/service-token.ts
mini-services/worker/adapters.ts

docs/ci/ci-gate.yml
docs/design-governance.md
tests/
```

---

# Appendix B — Verified Improvements

## Actor identity

Verified by current code / remediation history:

```text
actAsUserId removed
session user revalidated
real actor used for success audit
```

## Raw config

```text
config.download required
session actor audited
no-store
encrypted snapshot decrypted only after permission check
```

## Restore

```text
autoApprove removed
always AWAITING_APPROVAL
requester = session principal
```

## Config encryption

```text
random DEK
AES-256-GCM raw
AES-256-GCM normalized with separate IV
wrapped DEK
fail closed key
```

## Startup security

```text
blank repo secrets
known-bad NEXTAUTH secret blocklist
production rejects demo mode
seed production guard
```

## Audit

```text
unique prevHash
retry after P2002
```

## Build

```text
ignoreBuildErrors:false
reactStrictMode:true
```

## UX

```text
43 views @ 1920
43 views @ 320 reflow
keyboard checks
RTL/dark representative checks
```

---

# Appendix C — Residual Findings Summary

```text
P0
  AUTHZ-101 permission enforcement

P1
  service scopes
  public worker 3030
  crypto production hardening
  audit sequence/order
  CI inactive
  test suite absent
  SQLite
  simulated worker
  main unprotected
  control-plane co-location

P2
  denied download actor quality
  screen-reader/reduced-motion completion
  worker fatal-error behavior before production
  route/deep-link architecture
```

---

# Appendix D — Suggested Updated Worklog Entry

```markdown
## Phase 19-C — Authorization Completion Reopened by Independent Re-Audit

Re-audit at remote HEAD d72cc9e confirmed the P19 actor-model, service-auth,
snapshot-encryption, secret-policy, repository-hygiene, build-safety and UX
remediations.

However, P19 cannot be considered fully closed:

- changes/[id]/approvals authenticates but does not require change.approve or
  validate approval-level entitlement;
- changes/[id]/execute authenticates but does not require change.execute;
- changes POST authenticates but does not enforce change.create;
- snapshot restore authenticates but does not enforce config.restore;
- middleware only globally blocks auditor writes, so viewer/operator roles can
  reach permission-unchecked mutation handlers.

Decision: reopen P19 as Phase 19-C (Authorization Completion). No real device
write integration is permitted until the authorization matrix is server-
authoritative and negative role tests pass.
```

---

# Appendix E — Production Readiness Statement

Use this wording in README/release notes until the next gate:

> **FayaNMS is an advanced, security-hardened demo/control-plane prototype.
> Core identity, configuration encryption and internal service authentication
> have been substantially remediated, but production deployment remains
> blocked pending completion of mutation-level RBAC authorization, automated
> test/CI enforcement, production persistence infrastructure and real
> vendor-device adapter certification.**

---

**End of updated audit.**
