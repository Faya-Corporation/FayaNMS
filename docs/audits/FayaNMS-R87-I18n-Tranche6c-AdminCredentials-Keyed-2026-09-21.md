# FayaNMS — R87: i18n Tranche 6c — admin-credentials keyed (2026-09-21)

**Branch:** `main` (single-branch repo) · **Base:** `7aef0a3` (R86 confirm) · **Suite files:** 81 → 82

## 1. What landed

One view fully keyed — the R56 `PENDING_VIEWS` debt ledger's eighth shrink:
**16 → 15 entries (600 → 574 candidates)**.

- `admin-credentials-view.tsx` (ADMINISTRATION → "Credential Profiles") —
  the WHOLE view through the NEW `credentials` namespace: **39 leaves** per
  locale (the view had no pre-existing namespace). The round resumed the
  prior session's uncommitted WIP honestly (the R85 precedent) and
  machine-verified it end-to-end instead of redoing it: the pre-tranche
  enumeration was re-run with the exact r56 regexes (26 candidates =
  16 PROP + 10 JSX == the ledger ceiling; the WIP tree at ZERO), the
  dictionary math re-checked, and the round completed to gates/LIVE/docs.

## 2. The keyed inventory (including the non-swept plane)

Swept plane — 26 candidates, matching the ledger ceiling exactly
(16 PROP + 10 JSX):

- PageHeader title + description.
- Four KPI label+description pairs.
- The Gate G7 notice title ("Secrets are always masked").
- The Profiles card pair.
- Error title; empty pair; table aria-label; the eight column headers.

Non-swept plane (hand-cleaned):

- The breadcrumb labels (`{ label: "Administration" }` /
  `{ label: "Credential Profiles" }`) — object syntax, invisible to both
  sweep regexes → `breadcrumb.administration` / `breadcrumb.credentials`
  (the second mirrors the nav-verbatim title).
- `AUTH_METHOD_LABEL` (module map) replaced by `AUTH_KEYS` resolved via
  `` t(`authMethod.${authKey}`) `` at render with raw-token fallback —
  the R86 KIND_KEYS precedent. The fallback is load-bearing:
  `CredentialProfileRow.type` is an open `string` contract in
  `api-client.ts`, so unknown tokens render as the API value exactly as
  before. SNMPv3/HTTPS stay in the map: the pre-tranche EN chip rendered
  "SNMPv3", NOT the raw SNMPV3 token — dropping them would be a visible
  EN regression; both stay Latin protocol names in BOTH locales.
- The Gate G7 notice body split AROUND the `vault://…` code token
  (`notice.bodyStart` / `notice.bodyEnd`) — the R83 revoke-dialog split
  precedent; the font-mono span keeps its styling and the EN render is
  byte-exact vs the pre-tranche output.
- The error-message reason fallback ("The credential list could not be
  loaded." — lowercase, invisible to PROP_RE) → `error.reasonFallback`.
- The `"Never"` rotation fallback → `row.never` (R86
  `registry.row.never` precedent; AR أبدًا reuse pinned).
- The device-count template `` `${profile.deviceCount} device${…}` `` →
  `row.devices` as an ICU plural (en one/other; ar
  zero/one/two/few/many/other — the R84 `row.counts` precedent).
- The lowercase `ref: ` tooltip prefix → `row.ref` = `"ref: {ref}"` /
  `"المرجع: {ref}"` (the {ref} value stays the font-mono data-plane
  `vault://…` string).

## 3. Dictionaries

- NEW `credentials` namespace tail-inserted after `perfOverview` —
  byte-preserving (+69/−0 lines per file, zero rewrites).
- Dictionary 1,851 → **1,890 = 1,890 leaves**, deep parity both
  directions (script-verified + machine-pinned).
- Terminology: بيانات الاعتماد (nav verbatim — both the title and the
  second breadcrumb), الإدارة (nav groups verbatim), الخزينة (the vault
  stem — تديرها الخزينة / مراجع الخزينة / مع الخزينة), تدوير (rotation —
  آخر تدوير / سجل التدوير), أبدًا (R86 verbatim), الملفات (profiles).
  All new leaves are static strings EXCEPT `row.ref` (`{ref}`) and
  `row.devices` (ICU plural) — pinned.

## 4. Survivors (documented in-source + machine-pinned)

- The `••••••••` SECRET_MASK bullet token: secrets are never rendered in
  ANY locale (Gate G7) — the mask is locale-neutral by design.
- The `vault://…` technical reference inside the split notice body and
  the font-mono `ref:` value (data-plane secretRef strings).
- date-fns `formatDistanceToNow` English relative time at BOTH call
  sites (the Last-rotation KPI value + the row cells) — no ar locale
  wired anywhere (device-config-tab / R83-R86 precedent; live-verified:
  the AR view keeps `9 days ago` inside the Arabic sentence).
- The em-dash placeholders (the KPI loading `—` values and the
  zero-device cells).
- Data-plane row values: profile name / username / port / notes +
  `title={notes}` (live-verified: the AR table keeps the English
  `Config Backup — SSH key` name and note text — data-plane content).
- The header role chip ("Administrator") is shell-level data-plane —
  outside this view's scope.

## 5. Governance

- r56 sweep ledger: `admin-credentials-view.tsx` entry REMOVED — **15
  entries remaining**, live candidate sum over the ledgered files **574**
  (600 − 26), computed from the tree by the new pin (not quoted).
  Ceilings == live on every entry.
- Sweep header R87 paragraph + ledger doc comment updated.
- r81/r82/r83/r84/r85/r86 numeric pins updated to HEAD truth per the
  R82→R81 convention (15 entries / 574 sum); r85's and r86's
  dictionary-total pins updated to 1,890 = 1,890.
- NEW `tests/audit/r87-i18n-tranche-6c.test.ts` — 22 pins (286
  expects): 39 leaves ×2 locales, dictionary totals 1,890 = 1,890, deep
  parity both directions, non-empty values, TWO `useTranslations
  ("credentials")` hooks (view + ProfileRow — the R84 multi-scope
  precedent), ZERO sweep, 36 absent-literal source pins, 34
  keyed-call-site pins, 8 dynamic-key pins (AUTH_KEYS map + raw-token
  fallback), ledger removal + exact-15 numeric ledger + LIVE sum == 574
  computed from the tree, static-value shape except
  `row.ref`/`row.devices`, ICU category shapes (en one/other; ar
  zero/one/two/few/many/other), nav-verbatim title in BOTH locales,
  breadcrumb reuse pins, the row.never أبدًا reuse, SNMPv3/HTTPS Latin
  pins in both locales, the AR API_TOKEN/HTTPS Latin survivor (OFFLINE
  precedent), and the data-plane/date-fns survivor pins.

## 6. Verification

- **Gates:** lint 0 · tsc 0 · i18n suites in isolation
  **140/140** (r56+r80..r87) · full suite
  **1196/18/0 in the CI gate env shape** (Postgres :5433; 11,551 expects,
  82 files; reconciliation 1174@R86 + 22 r87) · bare
  **1167/18/29** (29 = the unchanged R64 hermeticity contract; fail
  blocks re-enumerated: R50.8 ×8, service JWT ×7, R51-A1 ×4, R50 ×4,
  SAFE-002 ×3, R62 P1-1, P1-007 ×2 — identical block set to R85/R86).
- **LIVE (agent-browser, admin@faya.local, EN + AR rtl/ar):**
  - EN: h1 `Credential Profiles`; breadcrumbs Administration /
    Credential Profiles; description; the four KPI pairs byte-exact
    (`Credential profiles 3` / `SSH profiles 2` / `API tokens 1` /
    `Last rotation 9 days ago`); the G7 notice + the `vault://…` split;
    the Profiles card pair; eight headers (`Name | Auth method |
    Username | Secret | Port | Devices | Last rotated | Notes`); the
    dynamic-key auth chips EXERCISED LIVE (`SSH key` / `API token` /
    `SSH password` — three of five AUTH_KEYS); the Secret-column tooltip
    `Vault-managed — secrets are never displayed` +
    `ref: vault://ssh/config-backup` ({ref} live); `••••••••` on every
    row with NO secret material anywhere in the DOM; zero-device rows
    render the `—` survivor.
  - AR (`ar / rtl` asserted; the active view persisted across the
    locale reload): h1 بيانات الاعتماد; breadcrumbs الإدارة / بيانات
    الاعتماد; full AR chrome (ملفات بيانات الاعتماد / ملفات SSH / رموز
    API / آخر تدوير; تُقنَّع الأسرار دائمًا + the split body; الملفات
    card; eight Arabic headers الاسم | طريقة المصادقة | اسم المستخدم |
    السر | المنفذ | الأجهزة | آخر تدوير | ملاحظات; chips مفتاح SSH /
    رمز API / كلمة مرور SSH; tooltip تديرها الخزينة — لا تُعرض الأسرار
    أبدًا + المرجع: vault://ssh/config-backup); API_TOKEN/HTTPS stay
    Latin inside the AR KPI description (pinned OFFLINE precedent).
  - Honest live-coverage note: the demo DB's three profiles cover
    SSH_PASSWORD / SSH_KEY / API_TOKEN only — the `snmpv3`/`https` chips
    and the `row.devices` ICU branches (all rows have 0 devices → `—`)
    are dictionary- and test-pinned but not wire-exercised this round;
    the dynamic-key mechanism itself is live-verified through three
    chips in BOTH locales.
  - Zero console errors / MISSING_MESSAGE / page errors in BOTH locales;
    mobile 390 no h-overflow (AR, on the view — scrollWidth == 390).
    3 screenshots (agent-ctx, untracked).

## 7. Ledger after R87

15 entries / **574 candidates** (from 32 entries / 824 at R56):
admin-api-clients (27), admin-integrations (47), admin-users (51),
alerts (36), backup-compliance (30), backups (61), change-approvals (33),
change-detail (52), changes (27), discovery (43), drift (30), events
(27), incident-detail (43), maintenance (38), snapshots (29).

Next tranches by ascending size: the three 27s (admin-api-clients,
changes, events), snapshots (29), drift (30), backup-compliance (30),
change-approvals (33), alerts (36), maintenance (38), discovery (43),
incident-detail (43), admin-integrations (47), admin-users (51),
change-detail (52), backups (61). End-state rule unchanged: empty
ledger → the sweep flips to forbid candidates in every view.

db/, .env, PAT never staged.
