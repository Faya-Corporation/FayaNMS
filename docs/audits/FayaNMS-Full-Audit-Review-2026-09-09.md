# FayaNMS — Full Repository Audit, Security Review & Production-Readiness Roadmap

**Repository:** https://github.com/Faya-Corporation/FayaNMS.git  
**Audited branch:** `main`  
**Audited commit:** `3a9488061e9053ebbf1b30de3a1f9189a30840af`  
**Commit date:** 2026-09-09  
**Audit date:** 2026-09-09  
**Review type:** Read-only end-to-end repository audit  
**Target:** Production-grade enterprise Network Management, Configuration Backup, Change Management, Incident Management, Monitoring, Reporting and Automation platform  
**Overall production-readiness assessment:** **42/100 — NOT READY FOR PRODUCTION**

---

# 1. Executive Summary

FayaNMS is already a substantial enterprise network-management prototype with broad domain coverage, a mature operational UX language, a useful job/state-machine model, configuration backup/diff/baseline/drift concepts, change-management workflows, incident and alert surfaces, performance views, reporting, administration, English/Arabic localization, and a centralized design-governance document.

The repository is not currently production-ready because several demo-era assumptions remain embedded in security-sensitive and integrity-sensitive paths.

The main problem is no longer lack of product breadth. The main problem is that identity, authorization, worker trust, configuration-secret storage, audit-chain correctness, database architecture, real network automation, automated testing, and release evidence are not yet at a production standard.

The most serious blockers are:

1. **Client-controlled acting identities (`actAsUserId`) undermine approvals, execution attribution, and separation of duties.**
2. **Internal worker/service endpoints are intentionally public.**
3. **Raw configuration snapshots are stored in plaintext relational columns although the README claims AES-256-GCM encryption at rest.**
4. **A fixed public `NEXTAUTH_SECRET` and shared demo password are provided as copy-to-production defaults.**
5. **The Caddy reverse proxy accepts a user-controlled local upstream port.**
6. **Audit-chain correctness depends on process-local memory and assumes a single Next.js writer.**
7. **Runtime SQLite database/WAL/SHM state is committed to Git.**
8. **The repository contains almost no production-grade automated test suite or CI gate.**
9. **Next.js builds explicitly ignore TypeScript errors.**
10. **The network worker is explicitly a simulator; no production SSH/SNMP/NETCONF/RESTCONF/gNMI data plane exists yet.**

The correct engineering strategy is:

> **Do not rewrite FayaNMS from zero. Preserve the existing domain model and UX, then harden the trust boundaries, persistence, automation, test evidence, and deployment architecture.**

Recommended next milestone:

> **Phase 19 — Production Security, Trust Boundary & Data Integrity Remediation**

All P0 findings in this report should be treated as release blockers before FayaNMS is connected to production network devices.

---

# 2. Audit Scope

The audit reviewed the live repository structure and representative critical implementation paths, including:

- repository layout and runtime architecture;
- README and documented operating assumptions;
- application framework and build configuration;
- authentication and authorization helpers;
- API middleware;
- user administration;
- change-management creation, approval and execution paths;
- configuration snapshot creation;
- raw configuration download;
- restore-as-change behavior;
- worker claim/completion trust boundaries;
- metrics retention;
- audit-chain implementation;
- credential-profile handling;
- Prisma database design;
- demo seed data and credentials;
- worker adapter contract and simulator behavior;
- deployment scripts;
- Caddy reverse proxy configuration;
- tests directory;
- GitHub commit/check status;
- design-governance document;
- alignment with the FayaNMS target architecture/design specification.

This was a **source-level, read-only audit**. It did not claim runtime penetration testing, production network certification, load testing, or live-device validation.

---

# 3. Current Repository Characterization

The repository itself describes FayaNMS as:

> “A full-stack network management system (NMS) demo platform”

and explicitly states that device state, metrics, flow data, HA topology, collector fleets and failover tests are deterministic simulations.

That description is accurate.

## 3.1 Current architecture

The current implementation is approximately:

```text
Browser
  │
  ▼
Next.js 16 application
  ├── UI / client-side view router
  ├── /api/v1 route handlers
  ├── authentication
  ├── business logic
  ├── persistence logic
  └── audit logic
  │
  ▼
Prisma
  │
  ▼
SQLite + WAL

Dedicated Bun mini-service
  │
  ├── HTTP job claim loop
  ├── simulated device adapters
  ├── simulated discovery
  ├── simulated config collection
  └── staged job execution
```

## 3.2 Intended production architecture

The FayaNMS project specification calls for a substantially more isolated architecture:

```text
Next.js Web
   │
   ▼
NestJS API / Control Plane
   │
   ├── PostgreSQL
   ├── Redis
   ├── TimescaleDB
   ├── MinIO / S3
   └── Event / Job Orchestration
           │
           ▼
      Network Workers
        Python
           │
           ▼
    Device Adapter Layer
      ├── Cisco
      ├── FortiGate
      ├── Sophos
      ├── HPE / Aruba
      └── Generic
           │
           ▼
     Production Devices
```

The current repository therefore represents a strong product/control-plane prototype rather than the final production architecture.

---

# 4. Production-Readiness Scorecard

| Dimension | Score | Status | Notes |
|---|---:|---|---|
| Product/domain completeness | 84/100 | Strong | Excellent breadth across NMS domains |
| UX/UI & design governance | 82/100 | Strong / evidence gaps | Mature design system and operations language |
| API/domain modeling | 74/100 | Good prototype | Broad API surface and Zod validation |
| Configuration-management UX | 78/100 | Strong prototype | Snapshot/diff/baseline/drift flows are useful |
| Change-management workflow | 76/100 | Functionally strong / trust failure | Good state model, identity model invalidates approvals |
| Incident/operations experience | 79/100 | Strong prototype | NOC/alerts/incidents/job center are well represented |
| Reporting/admin breadth | 73/100 | Good prototype | Broad management surfaces |
| Authentication | 48/100 | Incomplete | NextAuth exists, defaults are unsafe |
| Authorization / RBAC | 26/100 | **FAIL** | Permission matrix not consistently enforced |
| Separation of duties | 22/100 | **FAIL** | `actAsUserId` defeats evidence integrity |
| Worker/service authentication | 10/100 | **FAIL** | Important internal routes intentionally public |
| Secret/config protection | 25/100 | **FAIL** | Raw configs stored in plaintext |
| Audit integrity | 46/100 | Partial | Strong concept, unsafe multi-process correctness |
| Database architecture | 38/100 | Prototype only | SQLite/WAL, no production migration history |
| Job architecture | 62/100 | Useful prototype | Queue/state concepts good, distributed guarantees missing |
| Real network automation | 22/100 | **Not production** | Worker adapters explicitly simulated |
| Reliability/scalability | 40/100 | Partial | Single-process/single-file assumptions |
| Automated testing | 12/100 | **FAIL** | No meaningful application test suite |
| CI/CD / release gates | 10/100 | **FAIL** | No repository CI workflow evidence |
| Observability/SRE readiness | 38/100 | Partial | Some health concepts, no production telemetry platform |
| Repository hygiene | 35/100 | Weak | Runtime DB/WAL/PID artifacts committed |
| Overall | **42/100** | **PRODUCTION BLOCKED** | P0 remediation required |

---

# 5. Severity Model

## P0 — Production blocker

A defect that can cause:

- unauthorized privileged action;
- cross-trust-boundary compromise;
- false audit evidence;
- secret/configuration disclosure;
- destructive action without trustworthy authorization;
- silent integrity corruption;
- ability to fabricate trusted system state;
- release without meaningful correctness evidence.

## P1 — High priority

A defect that can cause:

- serious operational failure;
- scalability/reliability problems;
- unsafe deployment/upgrade;
- governance gaps;
- major maintainability problems;
- inability to certify production behavior.

## P2 — Medium priority

A quality/operability problem that should be corrected before broad production adoption but is not by itself a critical blocker.

## P3 — Improvement

Recommended enhancement, cleanup, maintainability or advanced capability.

---

# 6. Critical Findings Summary

| ID | Severity | Finding | Primary Impact |
|---|---|---|---|
| SEC-001 | P0 | Client-controlled acting-user identity | SoD/audit/approval bypass |
| SEC-002 | P0 | Internal worker/service APIs publicly reachable | Job and data integrity compromise |
| SEC-003 | P0 | Raw configuration plaintext at rest | Credential/config disclosure |
| SEC-004 | P0 | Unsafe public auth defaults | Session/account compromise |
| SEC-005 | P0 | Raw config export lacks permission-level enforcement | Confidential configuration disclosure |
| SEC-006 | P0 | Restore flow can auto-approve via seeded identities | Unauthorized high-risk restore workflow |
| SEC-007 | P0 | User-controlled Caddy localhost upstream port | Internal service exposure |
| AUD-001 | P0/P1 | Audit chain relies on process-local state | Forks / invalid audit evidence |
| QA-001 | P0 GA | No substantive application test/CI gate | Regressions can ship undetected |
| QA-002 | P1 | Next build ignores TypeScript errors | Broken application can “build” successfully |
| DATA-001 | P1 | Runtime DB/WAL/SHM committed | Leakage, non-reproducible state |
| DATA-002 | P1 | SQLite + `db push --accept-data-loss` | Unsafe production persistence/migrations |
| ARCH-001 | P1 | Network adapters are simulators | No real production NMS data plane |
| ARCH-002 | P1 | Control/data responsibilities remain co-located | Weak fault and trust isolation |
| AUTH-001 | P1 | Permission model exists but is inconsistently authoritative | Role behavior cannot be trusted |
| DOC-001 | P1 | Documentation overclaims encryption/QA | False readiness/security assurance |
| REPO-001 | P2 | Runtime/tool artifacts tracked in source | Repository hygiene/reproducibility |
| UX-001 | P1/P2 | QA matrix claims execution but stores no per-cell evidence | UX acceptance not auditable |

---

# 7. Detailed Security Findings

## SEC-001 — Client-Controlled Identity Breaks Separation of Duties

**Severity:** P0  
**Files:**

```text
src/app/api/v1/_lib/actor.ts
src/app/api/v1/changes/[id]/approvals/route.ts
src/app/api/v1/changes/[id]/execute/route.ts
src/app/api/v1/changes/route.ts
```

### Evidence

The approval API accepts:

```text
actAsUserId
```

from the request body.

The server then resolves that identifier to an active user via `resolveActingUser()`.

If the value is absent, the helper defaults to the seeded admin account.

The SoD check compares the change requester with the selected acting identity rather than the authenticated request principal.

The execution path uses the same acting-user mechanism.

Change creation also contains demo-identity behavior instead of consistently deriving the requester from the authenticated session.

### Why this matters

This creates a trust failure:

```text
Authenticated caller
      │
      ├── chooses actAsUserId = manager
      ▼
Server treats manager as actor
      ▼
SoD compares requester vs impersonated manager
      ▼
Approval / execution audit records wrong principal
```

Even when the UI is honest, server-authoritative evidence is invalid because the client is allowed to choose the actor.

### Required remediation

Remove production support for `actAsUserId`.

Every authenticated user action must use the principal resolved from the session:

```text
Request
  │
  ▼
Authentication
  │
  ▼
Principal
  │
  ▼
Permission check
  │
  ▼
Resource-scope check
  │
  ▼
Business operation
  │
  ▼
Audit = same principal
```

Create centralized authorization helpers such as:

```ts
requirePermission(request, "change.create")
requirePermission(request, "change.approve")
requirePermission(request, "change.execute")
requirePermission(request, "config.restore")
```

### Acceptance criteria

- `actAsUserId` removed from all production request DTOs.
- Request actor cannot be selected by the client.
- SoD uses the authenticated principal ID.
- Approval actor must hold the permission required by the approval level.
- Audit actor ID/name match the authenticated user.
- P0 test proves a requester cannot approve their own HIGH/CRITICAL change.
- P0 test proves an operator cannot impersonate a manager.
- P0 test proves an engineer cannot execute a change without execution permission.

---

## SEC-002 — Internal Worker and Service Endpoints Are Public

**Severity:** P0  
**File:**

```text
src/middleware.ts
```

### Evidence

The middleware intentionally exempts:

```text
/api/v1/worker/*
/api/v1/alerts/evaluate
/api/v1/reports/execute
/api/v1/metrics/retention/prune
```

from normal user-session authentication.

Comments state that service-token hardening was deferred.

### Impact

The worker endpoints participate in trusted state transitions.

Examples:

- claiming queued jobs;
- moving jobs into RUNNING;
- returning backup results;
- returning change-execution results;
- triggering alerts;
- pruning retained metrics;
- executing reports.

A malicious caller reaching those routes may be able to interfere with job processing or inject trusted-looking results.

### Critical configuration-backup attack path

```text
Unauthenticated/internal-untrusted request
         │
         ▼
Claim CONFIG_BACKUP job
         │
         ▼
Submit manipulated rawText
         │
         ▼
createSnapshot()
         │
         ├── snapshot stored
         ├── backup compliance updated
         └── success audit generated
```

### Required remediation

Create a service-authentication boundary.

Minimum:

- service JWT;
- audience restriction;
- short expiry;
- machine identity;
- key rotation;
- scoped claims;
- replay protection / idempotency;
- private network path.

Preferred:

```text
Worker
  │
  ├── mTLS workload identity
  └── service JWT
        │
        ▼
Internal Gateway / API
        │
        ▼
Allowed worker route
```

### Acceptance criteria

- No worker route accepts anonymous requests.
- Worker token cannot call human-admin routes.
- Human session cannot impersonate a worker.
- Tokens include worker/service identity.
- Every worker action is attributed to a machine principal.
- Invalid/missing audience rejected.
- Expired token rejected.
- Token rotation supported without outage.
- Integration tests cover all worker routes.

---

## SEC-003 — Configuration Snapshots Are Stored in Plaintext

**Severity:** P0  
**Files:**

```text
prisma/schema.prisma
src/lib/config/create-snapshot.ts
```

### Evidence

`ConfigSnapshot` stores:

```text
rawText
normalizedText
```

as ordinary `String` fields.

`createSnapshot()` writes `input.rawText` directly into Prisma.

The README claims configuration snapshots are encrypted at rest using AES-256-GCM.

The source path reviewed does not provide that encryption.

### Security impact

Network configurations commonly contain highly sensitive operational data:

- SNMP communities;
- local account hashes;
- TACACS/RADIUS information;
- VPN secrets or references;
- routing topology;
- BGP peers;
- internal addressing;
- management networks;
- ACLs;
- API tokens;
- trust boundaries;
- infrastructure naming;
- authentication configuration.

A compromise of the application database therefore becomes a configuration-secret disclosure.

### Required architecture

```text
Collected configuration
      │
      ▼
Normalizer / secret classifier
      │
      ▼
Generate DEK
      │
      ▼
AES-256-GCM
      │
      ├── ciphertext → object storage
      └── wrapped DEK → KMS/Vault-backed metadata
                      │
                      ▼
                 PostgreSQL
```

Suggested fields:

```text
ConfigSnapshot
  id
  deviceId
  version
  objectKey
  encryptionKeyId
  wrappedDek
  nonce
  authTag
  sha256Plaintext
  sha256Ciphertext
  sizeBytes
  source
  metadata
```

### Additional recommendations

- Do not store raw config in application logs.
- Do not return raw config through ordinary list/detail APIs.
- Support default masking at the viewer layer.
- Require explicit `config.raw.read` / `config.download` permission.
- Audit every raw reveal/export.
- Consider re-authentication/MFA for critical devices.

### Acceptance criteria

- No raw config plaintext in production DB.
- Object-store payload encrypted.
- Wrong key cannot decrypt.
- Tampered ciphertext is detected.
- Rotation path tested.
- Restore after key rotation tested.
- Raw export audit includes authenticated principal, snapshot ID and reason.
- Secret scanner test confirms no raw secret material appears in logs.

---

## SEC-004 — Unsafe Session Secret and Demo Credentials

**Severity:** P0  
**Files:**

```text
.env.example
README.md
prisma/seed.ts
```

### Evidence

`.env.example` includes a fixed `NEXTAUTH_SECRET`.

README instructs:

```bash
cp .env.example .env
```

The demo dataset documents a shared password:

```text
faya123
```

Seed logic uses the same password for every seeded user.

### Impact

A user following the documented installation path may deploy:

- a public known session signing secret;
- public known default accounts/passwords.

### Required remediation

Change `.env.example`:

```text
NEXTAUTH_SECRET=
```

Production startup must fail if:

- missing;
- too short;
- known demo value;
- known repository value.

Demo credentials must require explicit demo mode:

```text
FAYANMS_DEMO_MODE=true
```

Production startup:

```text
if NODE_ENV=production and demo mode/default users detected:
    abort startup
```

### Acceptance criteria

- Repository contains no usable production signing secret.
- Demo credentials absent in production seed.
- Initial admin setup requires generated bootstrap flow or identity provider.
- Default-password detector is part of startup validation.
- Security test verifies known demo password cannot authenticate in production configuration.

---

## SEC-005 — Raw Configuration Download Does Not Enforce a Dedicated Permission

**Severity:** P0  
**File:**

```text
src/app/api/v1/devices/[id]/snapshots/[snapshotId]/download/route.ts
```

### Evidence

The route:

- validates IDs;
- ensures snapshot belongs to device;
- returns `snapshot.rawText`;
- writes an audit event.

The handler itself does not call a permission helper such as `requireRole()` or `requirePermission()`.

Global middleware guarantees a valid session for this route, but it does not establish that all authenticated roles are allowed to retrieve raw configurations.

The audit actor is hard-coded as `"Admin"`.

### Impact

An authenticated account with a read-oriented role may gain raw configuration export capability.

Audit evidence can state that an administrator downloaded the file even when the true actor was another user.

### Required remediation

Require:

```text
config.read.raw
or
config.download
```

Use the actual authenticated actor.

For highly sensitive devices:

- step-up authentication;
- reason field;
- ticket/change reference;
- optional dual authorization.

### Acceptance criteria

- Viewer cannot download raw config.
- Auditor behavior follows policy exactly.
- Allowed engineer/admin can download.
- Audit actor matches user session.
- Download response has `Cache-Control: no-store`.
- Security headers prevent browser caching.
- Every successful and rejected download is auditable.

---

## SEC-006 — Restore Flow Supports Seeded Auto-Approval

**Severity:** P0  
**File:**

```text
src/app/api/v1/devices/[id]/snapshots/[snapshotId]/restore/route.ts
```

### Evidence

Request body accepts:

```json
{
  "confirmHostname": "...",
  "autoApprove": true
}
```

The route:

- creates an emergency change request;
- finds seeded admin/manager accounts;
- can create a manager approval;
- can schedule the change immediately.

This is better than a direct immediate configuration push, but the authorization and approval identity remain demo-oriented.

### Risk

High-risk restore decisions can be approved using preselected system users rather than real human decision evidence.

### Required production workflow

```text
Authenticated requester
      │
      ▼
config.restore permission
      │
      ▼
snapshot validation
      │
      ▼
pre-restore backup requirement
      │
      ▼
risk classification
      │
      ▼
real human approvals
      │
      ▼
device lock
      │
      ▼
maintenance window
      │
      ▼
execution
      │
      ▼
post-check
      │
      ▼
post snapshot
      │
      ▼
evidence + audit
```

Emergency/break-glass path must be explicit and stronger, not simply an `autoApprove` boolean.

### Acceptance criteria

- Remove `autoApprove` from ordinary restore API.
- Emergency bypass requires break-glass privilege.
- Break-glass requires MFA/reason/expiry/notification.
- Restore requester cannot approve own high-risk restore.
- Pre-restore snapshot is mandatory unless technically impossible and explicitly waived.
- Restore execution acquires a per-device distributed lock.
- Post-restore validation is required before success.

---

## SEC-007 — Query-Controlled Caddy Local Reverse Proxy

**Severity:** P0  
**File:**

```text
Caddyfile
```

### Evidence

Caddy reads an `XTransformPort` query parameter and proxies to:

```text
localhost:{query.XTransformPort}
```

### Impact

If exposed externally, this lets a caller influence which localhost port is accessed through the reverse proxy.

That can expose services that were intended to be internal-only.

### Required remediation

Delete query-selected dynamic upstream routing from production.

Use a static allowlist:

```text
/app      → localhost:3000
/worker   → no public proxy
/health   → explicit health service
```

### Acceptance criteria

- No user input determines upstream host or port.
- Internal worker port cannot be accessed from public listener.
- Reverse-proxy security tests verify localhost port traversal is impossible.

---

# 8. Authentication and Authorization Review

## 8.1 Positive findings

The repository already includes useful primitives:

```text
src/lib/auth/session.ts
```

with:

- JWT session extraction;
- DB revalidation of active users;
- `requireUser()`;
- `requireRole()`;
- 401/403 error distinctions.

User creation:

```text
src/app/api/v1/admin/users/route.ts
```

also:

- avoids selecting password hashes;
- validates input with Zod;
- hashes password immediately;
- writes audit evidence;
- uses a transaction.

These are good foundations.

## 8.2 Main design problem

The repository has both:

1. modern session identity;
2. older demo identity helpers.

The two models coexist.

This creates security inconsistencies.

The production system must choose one authoritative identity model.

### Required rule

> **No business route is allowed to synthesize, default, impersonate, or guess a human actor.**

## 8.3 Permission model gap

Seeded roles contain permission arrays such as:

```text
change.approve
change.create
device.write
config.backup
report.read
```

but enforcement is primarily role-level and route-specific.

Recommended central permission engine:

```ts
authorize(principal, {
  permission: "change.approve",
  resource: {
    organizationId,
    siteId,
    deviceIds
  }
})
```

Future RBAC should support:

- tenant/org scope;
- site scope;
- device-group scope;
- functional permission;
- risk constraints;
- approval level;
- break-glass claims.

---

# 9. Audit Integrity Review

## AUD-001 — Process-Local Audit-Chain Correctness

**Severity:** P0/P1  
**File:**

```text
src/lib/audit/chain.ts
```

### Positive design

The audit-chain implementation contains several good ideas:

- SHA-256 canonical field order;
- `prevHash`;
- genesis marker;
- verification;
- backfill support;
- tamper detection;
- automatic stamping;
- audit API integration.

### Production problem

The implementation explicitly assumes:

> a single Next.js process writes every audit row.

The chain head and mutex are stored in process-global state.

This is not safe when:

- multiple web replicas run;
- serverless functions execute independently;
- multiple worker/control-plane processes write audit records;
- a process crashes after updating its memory head but before DB commit.

### Fork scenario

```text
Replica A reads tail H1
Replica B reads tail H1

Replica A computes H2A
Replica B computes H2B

Both reference H1
```

A process-local mutex cannot coordinate those writers.

### Transaction issue

The in-memory chain head advances before the surrounding database transaction is guaranteed to commit.

The implementation acknowledges a temporary phantom head.

A tamper-evident production audit log must not accept eventual self-healing as its core correctness model.

### Recommended PostgreSQL implementation

```text
BEGIN

SELECT pg_advisory_xact_lock(
  hashtext('fayanms_audit_chain')
);

SELECT latest committed audit tail;

compute new hash;

INSERT AuditEvent(...);

COMMIT
```

Alternative:

- dedicated append-only audit writer service;
- immutable event store;
- database-generated serial sequence;
- external WORM/archive anchor.

### Additional hardening

- periodic signed chain checkpoint;
- export checkpoint to independent object store;
- immutable retention;
- verification by range;
- verification of entire dataset;
- alert on chain break;
- include chain schema version.

### Acceptance criteria

- Concurrent 100+ writers cannot fork chain.
- Transaction rollback does not alter committed tail.
- Multi-replica test passes.
- Verification across >1M events supported.
- Chain break generates P0 operational alert.
- Audit records cannot be modified by ordinary application roles.

---

# 10. Configuration Management Review

## 10.1 Strong current capabilities

The repository has a meaningful configuration-management model:

- versioned snapshots;
- running/startup classification;
- SHA-256 hashes;
- normalized text;
- baselines;
- drift records;
- current/historical/baseline states;
- restore-as-change concept;
- backup policies;
- compliance state;
- audit linkage;
- change/job/user references;
- configuration diff support.

This is one of the strongest parts of the domain model.

## 10.2 Production gaps

### Storage

Raw configuration must move away from plaintext SQLite.

### Concurrency

Snapshot version:

```text
max(version) + 1
```

is not a safe distributed allocation method under production concurrency unless protected by DB-level locking/constraint retry.

### Current snapshot transition

Demoting current then inserting new current should remain transactional.

In PostgreSQL, consider:

- device-scoped advisory lock;
- unique partial index for one current snapshot;
- version sequence/locking.

### Backup success semantics

A backup should only be considered healthy after:

1. collection complete;
2. encryption complete;
3. durable object write complete;
4. checksum verified;
5. metadata committed;
6. retention linkage valid.

Recommended staged state:

```text
STAGING
  ↓
PAYLOAD_DURABLE
  ↓
METADATA_VALIDATED
  ↓
COMMITTED
```

Only `COMMITTED` snapshots should count toward compliance.

---

# 11. Change Management Review

## 11.1 Positive implementation

The change domain already contains:

- DRAFT;
- AWAITING_APPROVAL;
- APPROVED;
- SCHEDULED;
- PRE_CHECK;
- EXECUTING;
- VALIDATING;
- SUCCESSFUL;
- FAILED;
- ROLLBACK;
- ROLLBACK_FAILED;
- REJECTED;
- CANCELLED;
- PARTIAL_SUCCESS;

and models:

- requester;
- owner;
- technical owner;
- affected devices;
- ordered steps;
- risk score;
- risk level;
- approval levels;
- implementation plan;
- validation plan;
- rollback plan;
- execution jobs;
- audit evidence.

This is a strong basis.

## 11.2 Major production blockers

- acting-user impersonation;
- approval role authorization not authoritative;
- execution authorization not authoritative;
- demo failure injection exists in execution request;
- real device lock absent;
- production network change execution is simulated;
- distributed idempotency not proven;
- change number generation may require DB-safe allocation;
- no automated state-machine contract suite.

## 11.3 Production change invariants

The system should guarantee:

```text
A change cannot execute unless:
  ├── required approvals are valid
  ├── approval actors are authorized
  ├── SoD rules pass
  ├── maintenance/conflict checks pass
  ├── device locks acquired
  ├── credentials resolved safely
  ├── pre-check passes
  └── rollback path exists or waiver approved
```

### Critical tests

- same requester cannot approve HIGH/CRITICAL;
- approval cannot be replayed;
- two concurrent executions cannot target same device;
- execution cannot begin after approval becomes invalid;
- failed validation triggers policy-defined rollback;
- rollback result is separately validated;
- audit records survive worker retry;
- duplicate execution request is idempotent.

---

# 12. Incident, Alert and Operations Review

## Strengths

The product includes:

- alerts;
- alert evaluation;
- dedup/suppression concepts;
- incidents;
- severity;
- SLA;
- assignments;
- timeline;
- NOC views;
- jobs;
- maintenance;
- event/audit views;
- HA/DR simulation;
- activity-oriented UX.

This matches the intended enterprise NOC direction.

## Production gaps

### Alert evaluation authentication

Alert evaluation must not be an anonymous trust boundary.

### Distributed deduplication

Any production alert deduplication/suppression implementation must work across replicas.

### Incident event integrity

Every timeline event should record:

- actor type;
- actor ID;
- source;
- correlation ID;
- request/service principal;
- original timestamp;
- immutable event sequence.

### HA/DR

Current HA/failover is simulation-oriented and must not be represented as validated production high availability.

---

# 13. Performance and Monitoring Review

## Current strengths

The repository includes:

- metrics;
- availability;
- capacity forecasting;
- interface/device views;
- flow analytics;
- predictive health concepts;
- retention logic.

## Production architecture gap

SQLite is not an appropriate long-term telemetry store for a production NMS.

Recommended:

```text
PostgreSQL
  └── metadata

TimescaleDB
  └── time-series metrics

Object Storage
  └── large exports / raw artifacts

Redis
  └── queue/cache/locks

Optional OpenTelemetry
  └── platform telemetry
```

## Retention risk

Metric pruning is a destructive operation.

It must:

- require machine authorization;
- enforce retention contract;
- support dry-run/preflight;
- provide counts;
- record audit;
- protect compliance/legal hold data.

---

# 14. Data Architecture Review

## DATA-001 — Runtime Database State Committed to Git

**Severity:** P1

The latest commit explicitly updates:

```text
db/custom.db
db/custom.db-shm
db/custom.db-wal
.zscripts/dev.pid
```

This is not a one-time accidental leak; runtime state is intentionally being synchronized into source control.

### Risks

- configuration history disclosure;
- seeded or changed credentials;
- user/account information;
- audit records;
- infrastructure topology;
- large binary repository history;
- non-reproducible deployments;
- confusing source vs runtime state.

### Required remediation

Add:

```gitignore
/db/*.db
/db/*.db-*
/db/*.sqlite
/db/*.sqlite3
*.pid
.zscripts/*.pid
```

Remove tracked runtime data.

If any database version contained real secrets or production data:

- treat as exposure;
- remove from active repository;
- rotate affected secrets;
- assess Git history rewrite.

---

## DATA-002 — SQLite and Unsafe Deployment Migration Strategy

**Severity:** P1

Prisma datasource is SQLite.

`package.json` includes:

```text
db:push = prisma db push --accept-data-loss
```

This is useful for a demo environment but unacceptable as the production deployment mechanism.

### Production requirement

Move to PostgreSQL and create a real migration history.

Required CI:

```text
migration syntax
migration apply from N-1
migration apply from clean DB
rollback/forward strategy
schema drift check
seed isolation
data compatibility tests
```

### Acceptance criteria

- Production never executes `db push --accept-data-loss`.
- Every schema change has reviewed migration.
- Migration tested against representative data volume.
- Backup/restore procedure documented.
- Zero-downtime migration rules defined.

---

# 15. Worker and Network Automation Review

## ARCH-001 — Worker Is Explicitly a Simulator

**Severity:** P1 / product readiness blocker

File:

```text
mini-services/worker/adapters.ts
```

The source clearly states:

> “The worker is a SIMULATION engine — no real SSH/SNMP.”

That is acceptable for a prototype but means current device backup, discovery, topology, telemetry and change behavior cannot be considered production NMS functionality.

## Positive architecture to retain

The worker defines a `DeviceAdapter` contract with:

- vendor;
- capabilities;
- config flavor;
- connect();
- fetchConfig().

That abstraction should survive the production transition.

## Recommended adapter architecture

```text
Network Worker
   │
   ├── Credential Resolver
   ├── Connection Manager
   ├── Rate Limiter
   ├── Device Lock Client
   ├── Transport Layer
   │      ├── SSH
   │      ├── HTTPS
   │      ├── SNMPv3
   │      ├── NETCONF
   │      ├── RESTCONF
   │      └── gNMI
   │
   └── Vendor Adapters
          ├── Cisco IOS
          ├── Cisco IOS-XE
          ├── Cisco NX-OS
          ├── Fortinet FortiOS
          ├── Sophos SFOS
          ├── Aruba AOS-CX
          ├── HPE Comware
          ├── Juniper JunOS
          ├── Palo Alto PAN-OS
          └── Generic SNMP
```

## Adapter contract requirements

Each adapter should define:

```text
manifest
capabilities
supported versions
transport preferences
facts
inventory
interfaces
neighbors
config backup
config restore
normalization
diff helpers
validation
change application
rollback
telemetry
error classification
rate limits
tests
```

## Critical adapter tests

For every supported vendor:

- connect success;
- auth failure;
- timeout;
- host-key behavior;
- config fetch;
- large config;
- line-ending normalization;
- secret masking;
- restore dry run;
- apply failure;
- rollback;
- interrupted connection;
- permission-denied device account;
- firmware compatibility;
- parser fixtures.

---

# 16. Repository Architecture Review

## Current repository shape

The current repository is a single main application plus mini-services.

## Target monorepo

Recommended:

```text
faya-nms/
├── apps/
│   ├── web/
│   ├── api/
│   ├── network-worker/
│   ├── collector/
│   ├── scheduler/
│   └── report-worker/
│
├── packages/
│   ├── design-system/
│   ├── ui/
│   ├── types/
│   ├── api-client/
│   ├── auth/
│   ├── permissions/
│   ├── database/
│   ├── event-contracts/
│   ├── network-sdk/
│   ├── adapter-sdk/
│   ├── telemetry/
│   ├── audit/
│   ├── logger/
│   └── testing/
│
├── adapters/
│   ├── cisco-ios/
│   ├── cisco-iosxe/
│   ├── cisco-nxos/
│   ├── fortios/
│   ├── sophos-sfos/
│   ├── aruba-aos-cx/
│   ├── hpe-comware/
│   ├── junos/
│   └── panos/
│
├── infrastructure/
│   ├── docker/
│   ├── kubernetes/
│   ├── helm/
│   ├── terraform/
│   ├── monitoring/
│   └── secrets/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── adapters/
│   ├── security/
│   ├── chaos/
│   └── performance/
│
└── docs/
```

## Migration strategy

Do not perform a disruptive rewrite.

Suggested extraction order:

1. central contracts;
2. PostgreSQL persistence;
3. service auth;
4. job orchestration;
5. network worker;
6. control-plane service;
7. large artifact storage;
8. observability;
9. report worker.

---

# 17. Build and Release Engineering Review

## QA-002 — TypeScript Errors Are Ignored During Build

**Severity:** P1  
**File:**

```text
next.config.ts
```

Current:

```ts
typescript: {
  ignoreBuildErrors: true,
},
reactStrictMode: false,
```

### Risk

A build artifact can be produced while application type errors remain.

A successful production build therefore does not prove type correctness.

### Required fix

```ts
typescript: {
  ignoreBuildErrors: false,
},
reactStrictMode: true,
```

If React Strict Mode exposes unsafe side effects, fix the side effects instead of disabling the signal.

---

# 18. Automated Testing Review

## QA-001 — No Production-Grade Test Suite

**Severity:** P0 for GA

The repository `tests/` directory contains only runtime/deployment shell validation scripts.

`package.json` does not define a normal application `test` command.

No meaningful repository CI workflow was present during the audit.

The audited commit also had no combined status checks.

### Required test layers

## 18.1 Unit

Cover:

- risk scoring;
- permission evaluation;
- config normalization;
- diff;
- status transitions;
- retention;
- incident SLA logic;
- alert thresholds;
- audit hashing;
- parser logic.

## 18.2 Contract

Cover:

- API envelopes;
- worker payloads;
- job events;
- adapter contract;
- audit event schema;
- error codes;
- pagination;
- permissions.

## 18.3 Integration

Cover:

- PostgreSQL transactions;
- job claims;
- concurrency;
- idempotency;
- audit chaining;
- snapshot commit;
- retention;
- approval transitions;
- rollback.

## 18.4 E2E / Playwright

Critical journeys:

```text
sign in
device inventory
device detail
backup
snapshot view
diff
set baseline
drift
change create
approval
execute
rollback
incident
report export
admin RBAC
raw config permission
RTL
dark mode
responsive
```

## 18.5 Security

Test:

- authorization matrix;
- IDOR;
- worker service auth;
- CSRF/session handling;
- secret exposure;
- raw config access;
- webhook SSRF;
- Caddy proxy boundary;
- password policy;
- rate limit;
- replay;
- tenant/site scoping.

## 18.6 Compatibility / adapters

Hardware/simulator fixture matrix.

## 18.7 Performance

Test:

- 10k devices;
- 100k interfaces;
- millions metric samples;
- large configuration histories;
- concurrent backups;
- concurrent change workflows;
- alert bursts;
- report generation.

## 18.8 Chaos

Test:

- worker crash;
- Redis loss;
- DB failover;
- object-store timeout;
- network partition;
- duplicate completion;
- delayed job result;
- process restart;
- credential-provider outage.

---

# 19. Required CI/CD Gates

Every pull request should run:

```text
1. dependency install
2. formatting check
3. lint
4. typecheck
5. unit tests
6. contract tests
7. integration tests
8. migration validation
9. production build
10. secret scanning
11. dependency vulnerability scan
12. SAST
13. container scan
14. SBOM generation
15. license policy
16. Playwright smoke suite
```

Main/release branches additionally:

```text
adapter compatibility
security suite
full E2E
performance smoke
database upgrade test
backup/restore test
artifact signing
provenance
```

Recommended tools may include:

- GitHub Actions;
- CodeQL;
- Trivy;
- Syft/Grype;
- Gitleaks;
- Playwright;
- Vitest;
- Testcontainers;
- dependency review.

---

# 20. UX/UI Review

The UX/design system is one of the strongest repository areas.

## 20.1 Good design-governance decisions

The design-governance document defines:

- semantic color tokens;
- density modes;
- light/dark themes;
- enterprise spacing;
- status semantics;
- chart conventions;
- Lucide icons;
- technical typography;
- LTR technical islands inside RTL;
- PageHeader;
- KpiCard;
- SectionCard;
- StatusBadge families;
- EmptyState;
- ErrorState;
- HighRiskActionDialog;
- table accessibility;
- chart accessibility;
- keyboard behavior;
- reduced motion;
- WCAG 2.2 AA target.

This is consistent with the intended Apex-inspired enterprise shell + Signal-inspired operational/NOC density.

## 20.2 Strong product language

The UI is correctly oriented toward:

- operational clarity;
- high information density;
- evidence-driven workflows;
- risk visibility;
- progressive disclosure;
- technical data;
- action safety;
- consistent domain statuses.

This is much better than a generic consumer-style SaaS dashboard.

## 20.3 Evidence problem

The design-governance document contains a QA matrix whose cells are blank while text states that the gate was executed.

Therefore:

```text
Design implementation       strong
QA acceptance definition    strong
Durable verification proof  incomplete
```

Status:

> **IMPLEMENTED / NOT FULLY VERIFIED**

## 20.4 Required browser matrix

Every critical route must be automatically or manually recorded at:

```text
Width:
375
768
1024
1280
1440
1920

Zoom:
80%
100%
125%
150%
200%

Theme:
light
dark
system

Direction:
LTR
RTL

Density:
comfortable
compact
dense
```

Critical checks:

- no page horizontal overflow;
- no nested accidental scrolling;
- no KPI wrapping defects;
- no clipped menus;
- no sidebar overlap;
- keyboard focus visible;
- dialogs trap focus;
- technical LTR data remains readable in Arabic;
- charts have text alternatives;
- 200% zoom does not hide actions.

---

# 21. Navigation and Frontend Architecture Review

README describes a single visible `/` route and client-side view router.

For a production enterprise application, actual routes are preferable.

Recommended transition:

```text
/dashboard

/network/devices
/network/devices/[id]
/network/sites
/network/interfaces
/network/topology
/network/discovery

/configurations/backups
/configurations/snapshots
/configurations/baselines
/configurations/drift
/configurations/compliance

/changes
/changes/[id]
/changes/calendar
/changes/templates

/operations/noc
/operations/alerts
/operations/incidents
/operations/incidents/[id]
/operations/jobs
/operations/maintenance
/operations/events

/performance
/performance/devices
/performance/interfaces
/performance/availability
/performance/capacity
/performance/flows

/reports

/administration/users
/administration/roles
/administration/credentials
/administration/api-clients
/administration/webhooks
/administration/collectors
/administration/system
/administration/audit
```

Benefits:

- deep links;
- browser history;
- route guards;
- independent loading/error boundaries;
- server rendering where useful;
- smaller client bundles;
- cleaner E2E tests;
- easier operational bookmarks.

---

# 22. Credentials and Secret Management Review

## Positive finding

`CredentialProfile` stores a `secretRef` rather than plaintext credential material.

The API requires `vault://...`.

This is the correct conceptual direction.

## Remaining production work

A `vault://` string is only a pointer convention until a real secret provider exists.

Required components:

```text
SecretProvider
  resolve(ref, context)
  rotate(ref)
  health()
  auditAccess()
```

Providers:

- HashiCorp Vault;
- cloud KMS/secret manager;
- Kubernetes secrets only for bootstrap, not long-lived device secrets.

Network worker must receive credentials securely, preferably just in time.

Requirements:

- no secret in queue payload;
- no secret in logs;
- no secret returned to browser;
- no secret stored in ConfigSnapshot;
- clear worker memory after use where practical;
- SNMPv3 auth/privacy support;
- SSH key and known-host management.

---

# 23. API and Integration Review

## Strengths

The API often uses:

- Zod;
- structured error envelopes;
- pagination;
- correlation IDs;
- explicit status codes;
- transactions.

These patterns should be standardized into shared packages.

## Production requirements

Add:

- OpenAPI source of truth;
- generated client;
- API version policy;
- idempotency keys;
- request IDs;
- rate limits;
- service-account scopes;
- OAuth2/OIDC for integrations;
- webhook signing;
- retry-safe webhook delivery;
- SSRF protection on webhook URLs;
- pagination limits;
- consistent problem details/error contract.

---

# 24. Reporting Review

The report domain is broadly represented.

Production reporting should ensure:

- report generation runs asynchronously;
- large files are object-store artifacts;
- export permission enforced;
- sensitive report fields masked by role;
- exports audited;
- scheduled reports use service principals;
- report links expire;
- XLSX/PDF/CSV generation is tested;
- no raw config content is included by default.

---

# 25. Repository Hygiene Review

## REPO-001 — Tracked Runtime and Tool State

**Severity:** P2

Examples include:

```text
db/custom.db
db/custom.db-wal
db/custom.db-shm
.zscripts/dev.pid
```

Potentially also generated logs/build helper artifacts depending on branch state.

### Required cleanup

Create a strict source-artifact policy.

Tracked:

```text
source code
migrations
docs
fixtures
test data
schemas
deployment manifests
```

Untracked:

```text
runtime DBs
WAL/SHM
PIDs
logs
local secrets
temporary archives
generated reports
coverage
developer state
```

---

# 26. Documentation Integrity Review

## DOC-001 — README Security Claims Outrun the Source

README states:

> config snapshots encrypted at rest (AES-256-GCM)

The audited snapshot creation path persists plaintext raw config.

Documentation must not claim security properties until implementation and tests prove them.

### Required rule

Every security/readiness claim should have evidence:

```text
Claim
  │
  ├── code path
  ├── test
  ├── CI evidence
  └── operational runbook
```

Examples:

```text
"encrypted at rest"
→ encryption integration test

"WCAG 2.2 AA"
→ audit matrix + automated checks + manual results

"segregation of duties"
→ authorization tests

"tamper-evident audit"
→ multi-writer concurrency test

"HA"
→ failover test evidence
```

---

# 27. Positive Engineering Findings

This audit should not obscure the amount of useful work already present.

## 27.1 Strong domain breadth

FayaNMS already models or surfaces:

- devices;
- sites;
- interfaces;
- topology;
- discovery;
- configuration snapshots;
- baselines;
- drift;
- backup policies;
- compliance;
- change requests;
- risk;
- approvals;
- steps;
- execution;
- rollback;
- alerts;
- incidents;
- maintenance;
- jobs;
- audit;
- performance;
- capacity;
- flow analytics;
- reports;
- users;
- roles;
- credentials;
- API clients;
- webhooks;
- collectors;
- firmware;
- ZTP;
- HA/DR simulation;
- AI-assisted operational features.

## 27.2 Good API hygiene in many routes

Patterns worth preserving:

- Zod parsing;
- machine-readable error codes;
- `ok()` / `fail()` envelopes;
- correlation IDs;
- small transactions;
- explicit resource ownership checks;
- clear route documentation.

## 27.3 Good configuration-management thinking

Useful existing concepts:

- normalized configuration;
- versioned snapshots;
- baseline;
- drift;
- SHA-256 integrity;
- pre/post change snapshots;
- guarded restore concept.

## 27.4 Good design-system governance

The design governance is more mature than many early-stage enterprise repositories.

Keep it centralized.

---

# 28. Recommended Phase 19 — Production Security, Trust Boundary & Data Integrity

**Priority:** P0  
**Goal:** Make the existing control plane safe enough to begin real device integration.

## 19.1 AUTH — Remove demo identity

Tasks:

```text
P19-AUTH-001 Remove actAsUserId from approval APIs
P19-AUTH-002 Remove actAsUserId from execution APIs
P19-AUTH-003 Remove demoActor from production paths
P19-AUTH-004 Add requirePermission()
P19-AUTH-005 Add resource-scope authorization
P19-AUTH-006 Add approval-level permission rules
P19-AUTH-007 Add break-glass policy
P19-AUTH-008 Make audit actor session-derived
```

Gate:

- no production endpoint synthesizes a human actor;
- all high-risk routes have explicit permission checks;
- SoD test suite green.

## 19.2 SERVICE-AUTH — Secure internal APIs

```text
P19-SVC-001 Create service-principal schema
P19-SVC-002 Create worker JWT/mTLS auth
P19-SVC-003 Lock /worker/*
P19-SVC-004 Lock alert evaluate
P19-SVC-005 Lock report execute
P19-SVC-006 Lock retention prune
P19-SVC-007 Add scopes/audiences
P19-SVC-008 Add token rotation
P19-SVC-009 Add replay/idempotency protection
```

Gate:

- anonymous internal action impossible.

## 19.3 CONFIG-SEC — Encrypt configuration artifacts

```text
P19-CFG-001 Add object storage abstraction
P19-CFG-002 Add KMS abstraction
P19-CFG-003 Define encrypted config envelope
P19-CFG-004 Encrypt on snapshot commit
P19-CFG-005 Decrypt only in privileged service path
P19-CFG-006 Migrate existing snapshots
P19-CFG-007 Add masking
P19-CFG-008 Add key rotation
P19-CFG-009 Add tamper tests
```

Gate:

- zero production raw config plaintext in DB.

## 19.4 AUDIT — Make audit chain transaction-safe

```text
P19-AUD-001 Move audit chain to PostgreSQL
P19-AUD-002 Add DB advisory lock
P19-AUD-003 Remove process-global correctness dependency
P19-AUD-004 Add concurrent writer tests
P19-AUD-005 Add whole-chain verifier
P19-AUD-006 Add periodic immutable checkpoint
P19-AUD-007 Alert on verification failure
```

Gate:

- concurrent multi-replica audit tests pass.

## 19.5 REPO — Remove runtime state from Git

```text
P19-REP-001 Ignore DB/WAL/SHM
P19-REP-002 Ignore PID/log runtime files
P19-REP-003 Remove tracked runtime artifacts
P19-REP-004 Assess history exposure
P19-REP-005 Rotate any exposed secrets
```

## 19.6 PROXY — Remove dynamic localhost routing

```text
P19-PROXY-001 Remove XTransformPort proxy behavior
P19-PROXY-002 Static route allowlist
P19-PROXY-003 Internal worker port private
P19-PROXY-004 Add reverse-proxy security test
```

### Phase 19 exit gate

**PASS only if:**

- no demo actor path remains in production;
- no internal route accepts anonymous action;
- raw config is encrypted at rest;
- raw download permission tested;
- restore authorization tested;
- Caddy dynamic proxy removed;
- audit chain concurrent test passes;
- known default secrets rejected;
- no runtime DB state tracked.

---

# 29. Phase 20 — Verification and CI Foundation

**Priority:** P0 before production integration

Tasks:

```text
P20-001 Remove ignoreBuildErrors
P20-002 Enable React Strict Mode
P20-003 Add test runner
P20-004 Add unit tests
P20-005 Add API contract tests
P20-006 Add integration DB tests
P20-007 Add Playwright
P20-008 Add security authorization matrix
P20-009 Add GitHub Actions
P20-010 Add secret scanning
P20-011 Add SAST
P20-012 Add dependency scan
P20-013 Add container scan
P20-014 Add SBOM
P20-015 Add migration test
P20-016 Add browser QA matrix
```

### Phase 20 gate

Required commands:

```text
lint           PASS
typecheck      PASS
unit           PASS
contract       PASS
integration    PASS
e2e-smoke      PASS
security       PASS
build          PASS
migration      PASS
secret scan    PASS
SAST           PASS
```

No build bypass flags allowed.

---

# 30. Phase 21 — Production Persistence and Job Infrastructure

**Priority:** P1

## Database

```text
P21-DB-001 PostgreSQL schema
P21-DB-002 Prisma migration history
P21-DB-003 Data migration tool
P21-DB-004 N-1 upgrade test
P21-DB-005 Backup/restore runbook
P21-DB-006 connection pooling
```

## Redis / orchestration

```text
P21-JOB-001 Redis
P21-JOB-002 distributed locks
P21-JOB-003 idempotency
P21-JOB-004 retry policy
P21-JOB-005 DLQ
P21-JOB-006 heartbeat/lease
P21-JOB-007 orphan recovery
P21-JOB-008 cancellation
```

## Time-series

```text
P21-MET-001 TimescaleDB
P21-MET-002 retention policies
P21-MET-003 aggregation
P21-MET-004 capacity sizing
```

## Object storage

```text
P21-OBJ-001 MinIO/S3 adapter
P21-OBJ-002 encrypted config objects
P21-OBJ-003 reports
P21-OBJ-004 large audit exports
P21-OBJ-005 retention/immutability
```

---

# 31. Phase 22 — Real Network Automation

**Priority:** P1

## Worker foundation

```text
P22-WRK-001 Python worker service
P22-WRK-002 adapter SDK
P22-WRK-003 service auth
P22-WRK-004 secret provider
P22-WRK-005 SSH transport
P22-WRK-006 SNMPv3 transport
P22-WRK-007 NETCONF
P22-WRK-008 RESTCONF
P22-WRK-009 HTTPS APIs
P22-WRK-010 gNMI
P22-WRK-011 rate limiting
P22-WRK-012 per-device lock
P22-WRK-013 timeout/retry taxonomy
```

## Vendor certification order

### Cisco

```text
P22-CIS-001 IOS
P22-CIS-002 IOS-XE
P22-CIS-003 NX-OS
```

### Fortinet

```text
P22-FGT-001 FortiGate discovery
P22-FGT-002 config backup
P22-FGT-003 API health
P22-FGT-004 restore/change
```

### Sophos

```text
P22-SOP-001 XGS/SFOS authentication
P22-SOP-002 inventory
P22-SOP-003 backup
P22-SOP-004 change/validation
```

### HPE / Aruba

```text
P22-HPE-001 AOS-CX
P22-HPE-002 Comware if required
P22-HPE-003 SNMP
P22-HPE-004 REST/API
```

### Gate

At least one representative supported device/OS version per declared production adapter must pass:

```text
discover
inventory
backup
diff
baseline
drift
safe change
validation
rollback
```

---

# 32. Phase 23 — Control Plane Separation

**Priority:** P1

Gradually extract business logic from Next.js route handlers.

Target:

```text
apps/web
  UI / BFF-only concerns

apps/api
  NestJS control plane

apps/network-worker
  device data plane

apps/scheduler
  recurring orchestration

apps/report-worker
  exports
```

Move first:

1. authentication/authorization contracts;
2. jobs;
3. audit;
4. configuration metadata;
5. change state machine;
6. incidents;
7. reports.

Avoid a big-bang rewrite.

---

# 33. Phase 24 — Production UX Certification

Tasks:

```text
P24-UX-001 Browser matrix automation
P24-UX-002 375px overflow checks
P24-UX-003 200% zoom checks
P24-UX-004 Arabic RTL checks
P24-UX-005 dark/light visual regression
P24-UX-006 density visual regression
P24-UX-007 keyboard-only E2E
P24-UX-008 screen-reader audit
P24-UX-009 chart alternatives
P24-UX-010 high-risk dialog consistency
```

Gate requires recorded evidence rather than blank QA matrices.

---

# 34. Phase 25 — Production Hardening & GA

## Scale test targets

Initial adjustable targets:

```text
10,000 managed devices
100,000+ interfaces
500 concurrent backup jobs
100 concurrent change jobs
millions of metric samples
millions of audit records
large configuration histories
```

## Chaos

Test:

```text
worker crash
API restart
DB failover
Redis outage
object-store outage
network partition
duplicate completion
late completion
device timeout
credential provider outage
disk pressure
```

## Security

Required:

```text
SAST
DAST
dependency scan
container scan
API penetration test
RBAC/IDOR
service-auth review
SSRF
webhook review
credential exposure
config encryption
audit integrity
session security
MFA/break-glass
```

## Operational readiness

Require:

- OpenTelemetry traces;
- Prometheus metrics;
- structured logs;
- alerting;
- dashboards;
- SLOs;
- runbooks;
- incident playbooks;
- backup/restore for FayaNMS itself;
- disaster-recovery test;
- upgrade/rollback test.

---

# 35. Production GA Hard Blockers

FayaNMS must not reach production GA with any of the following:

```text
unauthorized raw configuration access
client-controlled approval identity
anonymous worker/service mutation
known default session secret
known production default password
plaintext raw configuration storage
audit-chain fork under concurrent writers
untrusted restore auto-approval
user-selected internal reverse-proxy port
build succeeding with TypeScript errors
no automated authorization test suite
runtime production DB committed to Git
production schema changes via accept-data-loss
simulated device behavior labeled as production
```

---

# 36. Recommended Security Invariants

These invariants should be encoded in automated tests.

## Identity

```text
The client never chooses the actor.
```

## Authorization

```text
Every mutation has an explicit permission.
```

## Separation of duties

```text
The requester cannot approve a HIGH/CRITICAL change.
```

## Service trust

```text
Only authenticated machine principals can call worker APIs.
```

## Configuration confidentiality

```text
Raw configuration is encrypted before durable storage.
```

## Audit

```text
Every privileged action is attributable to the real principal.
```

## Audit integrity

```text
Concurrent writers cannot fork or corrupt the audit chain.
```

## Change execution

```text
Two active changes cannot mutate the same device concurrently unless explicitly allowed.
```

## Restore

```text
A restore cannot silently bypass approval and validation.
```

## Backup truth

```text
A snapshot is not compliant until its durable payload and metadata are committed and verified.
```

## Release

```text
A production build cannot bypass typecheck or mandatory tests.
```

---

# 37. Recommended Repository Ownership / Worktrees

For parallel implementation:

```text
fayanms-wt-security
fayanms-wt-authz
fayanms-wt-database
fayanms-wt-audit
fayanms-wt-network-worker
fayanms-wt-adapters
fayanms-wt-observability
fayanms-wt-testing
fayanms-wt-design-system
```

Ownership boundaries:

## Security/Auth

Own:

```text
auth
permissions
service principals
break glass
session
high-risk server authorization
```

## Database

Own:

```text
PostgreSQL
migrations
Redis
TimescaleDB
object storage metadata
```

## Audit

Own:

```text
hash chain
append logic
verification
retention
immutable checkpoints
```

## Network Worker

Own:

```text
transport
worker runtime
credential resolution
locks
connection management
adapter SDK
```

## Adapter worktree

Own:

```text
Cisco
Fortinet
Sophos
HPE/Aruba
Juniper
Palo Alto
```

## Testing

Own:

```text
unit
contract
integration
Playwright
security
performance
chaos
```

## Cross-worktree rule

Shared contracts must not be duplicated.

Canonical shared packages should own:

```text
permissions
domain statuses
job states
event contracts
adapter interfaces
API DTOs
audit event schema
design-system primitives
```

---

# 38. Production Readiness Gate Matrix

| Gate | Current | Required |
|---|---|---|
| Repository foundation | PARTIAL | Stable monorepo + CI |
| Design system | STRONG / unverified | Automated evidence |
| App shell | STRONG / unverified | Route/viewport matrix |
| Authentication | PARTIAL | Secure defaults + MFA/OIDC path |
| Authorization | FAIL | Permission engine |
| SoD | FAIL | Session-bound approvers |
| Service authentication | FAIL | Machine identity |
| Inventory | DEMO PASS | Real discovery |
| Config backup | DEMO PASS | Real collection + encryption |
| Diff/baseline/drift | PROTOTYPE PASS | Real config source + tests |
| Change management | FUNCTIONAL / SECURITY FAIL | Trusted actor model |
| Change execution | SIMULATED | Real adapter execution |
| Rollback | SIMULATED | Device-certified rollback |
| Alerts | DEMO PASS | Secure evaluation + real telemetry |
| Incidents | PROTOTYPE PASS | Integration + SLA evidence |
| Performance | SIMULATED | Real collectors + Timescale |
| Reporting | PROTOTYPE PASS | async production worker |
| Audit | PARTIAL | DB-safe multi-writer chain |
| Database | FAIL | PostgreSQL migrations |
| Worker | SIMULATED | Production network worker |
| Tests | FAIL | Full automated suite |
| CI/CD | FAIL | Mandatory status checks |
| Security | FAIL | P0 closure |
| GA | BLOCKED | All P0/P1 gates |

---

# 39. Suggested Immediate Implementation Order

The safest order is:

```text
1. Freeze new feature work
2. Remove dynamic Caddy proxy
3. Remove/disable known auth defaults
4. Remove acting-user impersonation
5. Add centralized permissions
6. Secure internal worker routes
7. Protect raw config download
8. Remove restore auto-approval
9. Encrypt configuration storage
10. Replace audit-chain process lock
11. Add automated tests
12. Add CI
13. Stop committing runtime DB state
14. Migrate to PostgreSQL
15. Add Redis/distributed locks
16. Add object storage
17. Build real network worker
18. Certify vendor adapters
19. Extract control plane
20. Execute production/chaos/security/UX certification
```

---

# 40. Recommended “Definition of Done” for Every Future Task

A task is not complete merely because UI renders or an endpoint returns success.

Every production task should provide:

```text
Implementation
  ├── source code
  ├── data migration if needed
  ├── authorization
  ├── error handling
  ├── audit
  ├── observability
  └── documentation

Verification
  ├── unit test
  ├── integration/contract test
  ├── E2E where user-visible
  ├── negative/security test
  └── build/typecheck

Evidence
  ├── commands
  ├── results
  ├── screenshots for critical UX
  └── known limitations
```

Allowed implementation statuses:

```text
NOT_STARTED
PARTIAL
IMPLEMENTED_UNVERIFIED
VERIFIED
BLOCKED
NOT_APPLICABLE
```

Do not label simulated or unverified features `production-ready`.

---

# 41. Final Assessment

FayaNMS has evolved far beyond a basic dashboard.

The repository contains a meaningful operational product model and many components worth preserving.

The strongest aspects are:

- enterprise NMS domain breadth;
- configuration-management concepts;
- change state-machine design;
- NOC/incident/reporting coverage;
- centralized design governance;
- Arabic/RTL support;
- Zod/API envelope conventions;
- audit-aware engineering mindset;
- worker abstraction;
- high-risk UX patterns.

However, production readiness is blocked because trusted workflows still rely on demo mechanisms.

The most urgent architectural transition is:

```text
Demo identity
      ↓
real authenticated principal

Public internal endpoints
      ↓
machine-authenticated service boundary

Plaintext configuration DB rows
      ↓
encrypted object storage + KMS

Process-local audit mutex
      ↓
database-transaction serialization

SQLite
      ↓
PostgreSQL + migrations

Simulated adapters
      ↓
real network-worker adapter SDK

manual/unverified quality
      ↓
mandatory automated CI gates
```

The recommended strategy is therefore:

> **Harden first, then integrate real devices.**

Connecting the current repository directly to production routers, switches or firewalls before closing the P0 findings would create unacceptable confidentiality, authorization, audit-integrity and operational risk.

---

# 42. Final Recommendation

The next official milestone should be:

## **FayaNMS Phase 19 — Production Security, Trust Boundary & Data Integrity Remediation**

Feature expansion should be temporarily secondary to:

1. authoritative identity;
2. RBAC/permissions;
3. trusted approvals;
4. service authentication;
5. encrypted configuration storage;
6. audit-chain correctness;
7. repository/data cleanup;
8. automated testing and CI.

After Phase 19 and Phase 20 pass, proceed to:

> **Production Persistence → Real Network Automation → Vendor Certification → Control-Plane Separation → GA Hardening**

That path preserves the substantial product work already completed while converting FayaNMS from a sophisticated simulated NMS into a defensible production enterprise platform.

---

# Appendix A — High-Priority Files Reviewed

```text
README.md
.env.example
.gitignore
package.json
next.config.ts
Caddyfile

prisma/schema.prisma
prisma/seed.ts

src/middleware.ts

src/lib/auth/session.ts
src/lib/auth/acting-admin.ts
src/lib/audit/chain.ts
src/lib/config/create-snapshot.ts

src/app/api/v1/admin/users/route.ts
src/app/api/v1/admin/audit-chain/backfill/route.ts
src/app/api/v1/credentials/route.ts

src/app/api/v1/changes/route.ts
src/app/api/v1/changes/[id]/approvals/route.ts
src/app/api/v1/changes/[id]/execute/route.ts
src/app/api/v1/_lib/actor.ts

src/app/api/v1/devices/[id]/snapshots/[snapshotId]/download/route.ts
src/app/api/v1/devices/[id]/snapshots/[snapshotId]/restore/route.ts

src/app/api/v1/worker/claim/route.ts
src/app/api/v1/worker/complete/route.ts
src/app/api/v1/alerts/evaluate/route.ts
src/app/api/v1/metrics/retention/prune/route.ts

mini-services/worker/adapters.ts

docs/design-governance.md
tests/
.zscripts/build.sh
```

---

# Appendix B — Evidence URLs

Repository:

```text
https://github.com/Faya-Corporation/FayaNMS
```

Audited commit:

```text
https://github.com/Faya-Corporation/FayaNMS/commit/3a9488061e9053ebbf1b30de3a1f9189a30840af
```

Key files:

```text
https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/README.md

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/.env.example

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/src/middleware.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/src/lib/auth/session.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/src/lib/auth/acting-admin.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/src/lib/audit/chain.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/src/lib/config/create-snapshot.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/prisma/schema.prisma

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/prisma/seed.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/mini-services/worker/adapters.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/docs/design-governance.md

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/next.config.ts

https://github.com/Faya-Corporation/FayaNMS/blob/3a9488061e9053ebbf1b30de3a1f9189a30840af/Caddyfile
```

---

# Appendix C — Suggested Next Audit After Remediation

After Phase 19/20 implementation, perform a second audit with this exact scope:

```text
1. authorization matrix review
2. service-principal penetration tests
3. configuration-encryption cryptographic review
4. PostgreSQL migration review
5. audit-chain concurrency test
6. job idempotency/race audit
7. network-worker trust-boundary review
8. adapter fixture review
9. raw configuration secret-leak scan
10. Playwright full route matrix
11. RTL/dark/density visual regression
12. dependency/container/SAST review
13. production deployment manifest review
14. chaos tests
15. upgrade/rollback test
16. self-backup/self-recovery test
```

The next readiness score should only increase for items that have implementation **and reproducible evidence**.
