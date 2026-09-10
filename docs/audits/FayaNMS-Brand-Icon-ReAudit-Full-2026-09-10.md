# FayaNMS — Brand & Iconography Full Re-Audit

**Repository:** `fayafatehi/FayaNMS`  
**Default branch:** `main`  
**Audited commit:** `e3564ae9a37019ee65c7918b40695d19aa69941b` (`e3564ae`)  
**Audit date:** 2026-09-10  
**Previous brand/icon audit baseline:** `d72cc9e`  
**Previous score:** **52/100**  
**Current re-audit score:** **82/100**  
**Target before calling the brand/icon system production-governed:** **95+/100**

---

# 1. Executive Summary

The FayaNMS brand and iconography implementation has improved substantially since the first audit.

The original audit found a fragmented identity:

1. an external Z-AI / ChatGLM favicon;
2. Lucide `Waypoints` used as a temporary FayaNMS product mark;
3. a separate animated Z-style `public/logo.svg`;
4. a 216-icon FayaNMS project icon kit that existed as an uploaded artifact rather than a governed runtime system;
5. no canonical brand source of truth, metadata suite, icon registries, social assets, or validation pipeline.

The current `main` head, `e3564ae`, implements a large part of the prescribed remediation:

- a FayaNMS brand identity object exists;
- canonical brand master assets exist;
- browser/app metadata is local;
- `public/logo.svg` is now the FayaNMS mark and no longer animated;
- 12 v2 icons were added to the original 216-icon set;
- navigation now uses governed custom FayaNMS domain icons;
- device and vendor glyphs are integrated into device inventory/detail and driver catalog surfaces;
- Lucide remains the generic UI/status icon language;
- brand documentation is extensive;
- local validation and raster-generation scripts exist.

That implementation is **real and valuable**.

However, the re-audit found that the repository is **not yet at the claimed “B0–B3 complete / fully governed” state**.

The most important remaining problems are:

- `Waypoints` is still used as a FayaNMS pseudo-logo in the **application loading screen and mobile navigation drawer**.
- Sidebar and sign-in still **hand-compose** mark + literal brand name/descriptor instead of using the canonical lockup/source-of-truth.
- The raster pipeline says it uses a single SVG master but actually **duplicates the complete mark geometry and brand constants in code**.
- Apple, Open Graph and Twitter artwork also duplicate the mark geometry.
- The documentation claims strict automatic validation of geometry, catalog coverage, tone drift, extras, raster dimensions and consumer coverage, but the current validators enforce only a subset of those rules.
- The documented brand CI gate is stored under `docs/ci/ci-gate.yml`; **there is no active `.github/workflows/` directory**, current `main` has no status checks, and the branch is unprotected.
- GitHub repository topics are still empty and the public About description does not follow the brand playbook's explicit “demo platform” truthfulness language.
- README uses a `currentColor` SVG through `<img>`, which cannot reliably inherit GitHub page text color and therefore is not a robust theme-aware brand presentation.
- The favicon policy says “simplified micro-mark”, but both `icon.svg` and ICO generation still use the full 24×24 mark.
- Brand guidelines forbid brand gradients, while the Open Graph/Twitter card implementation creates a blue-to-cyan gradient strip.
- Known device roles such as `TOP_OF_RACK`, `WAN_GATEWAY`, `WIRELESS_CONTROLLER`, and `LOAD_BALANCER` deliberately fall back to a generic device glyph even though the product already knows their semantics.

**Conclusion:** the identity architecture is now strong, but governance is partially aspirational. The next work should be a **Brand Governance Completion phase**, not another wholesale visual redesign.

---

# 2. Audit Method

This re-audit independently inspected the current GitHub repository rather than accepting the latest commit message as proof.

## 2.1 Verified repository state

The audit inspected:

- current `main` branch head;
- repository metadata;
- current branch-protection state;
- current commit status checks;
- brand source-of-truth code;
- Next.js metadata and PWA manifest;
- primary brand SVGs;
- brand components;
- shell/sidebar/mobile/loading surfaces;
- sign-in branding;
- navigation icon registry;
- icon renderer;
- vendor and device registries;
- device inventory integration;
- device detail integration;
- device-driver integration;
- v2 icon masters;
- brand documentation;
- validation scripts;
- raster generation;
- CI gate definition;
- CODEOWNERS;
- README presentation.

## 2.2 What was not independently executed

This pass is a static repository/repository-settings audit.

The latest commit message states that the author locally verified:

- TypeScript;
- lint;
- local validators;
- browser rendering;
- light/dark;
- 375px overflow;
- OG rendering.

Those claims are useful evidence, but this re-audit did **not independently run the application or browser suite**, because no checked-in GitHub Actions evidence currently exists for this commit.

Therefore:

> Local verification claimed by the commit is recorded as implementation evidence, but not treated as an independently reproduced production gate.

---

# 3. Current Readiness Scorecard

| Dimension | Previous | Current | Verdict |
|---|---:|---:|---|
| Core product identity consistency | 25 | **82** | Major improvement; Waypoints remains in mobile/loading |
| Local favicon / application metadata | 15 | **92** | External favicon removed; micro-mark policy still incomplete |
| Brand asset completeness | 30 | **92** | Canonical mark/variants/social/app assets present |
| Color/token identity | 92 | **88** | Strong palette, but several hardcoded duplicates and social gradient rule conflict |
| Typography | 88 | **88** | Inter + JetBrains Mono remain appropriate |
| Generic UI icon consistency | 88 | **94** | Lucide separation is preserved |
| Navigation icon semantics | 78 | **94** | Governed custom navigation mapping implemented |
| Operational status icon architecture | 92 | **94** | Existing semantic Lucide system preserved |
| Device-type iconography | 45 | **76** | Integrated, but several known roles still collapse to generic |
| Vendor/adapter iconography | 30 | **92** | Seven vendor mappings incl. Juniper/Palo Alto |
| Custom domain icon integration | 20 | **95** | 228-icon system represented and navigation integrated |
| Accessibility | 82 | **84** | Good defaults; standalone device icon naming still weak |
| GitHub/repository brand presence | 30 | **62** | README improved; topics empty, About mismatch, social upload unverified |
| Asset governance documentation | 35 | **94** | Excellent documentation |
| Asset governance enforcement | 20 | **58** | Validators are incomplete relative to docs |
| CI / non-bypassable governance | 0 | **15** | CI definition exists only under docs; branch unprotected |
| **Overall** | **52** | **82** | **Strong implementation, incomplete enforcement** |

---

# 4. Previous Audit Remediation Matrix

| Previous finding | Current status | Re-audit result |
|---|---|---|
| External Z-AI/ChatGLM favicon | **RESOLVED** | Local Next.js metadata now used |
| Stale animated Z-style `public/logo.svg` | **RESOLVED** | Replaced with static canonical mark |
| `Waypoints` pseudo-logo in sidebar | **RESOLVED on desktop** | Desktop sidebar uses FayaNMS mark |
| `Waypoints` pseudo-logo in sign-in | **RESOLVED visually** | FayaNMS mark used, but lockup still hand-built |
| `Waypoints` eliminated from all brand surfaces | **NOT RESOLVED** | Still present in loading and mobile drawer |
| No brand source of truth | **PARTIALLY RESOLVED** | `FAYANMS_BRAND` exists but consumers still hardcode values |
| 216-icon pack not integrated | **RESOLVED** | Governed runtime directory/registry architecture exists |
| Missing 12 v2 icons | **RESOLVED** | All 12 sampled additions exist |
| Missing Juniper/Palo Alto project glyphs | **RESOLVED** | Both are present and mapped |
| Generic sidebar icons | **RESOLVED** | 43 sidebar views now mapped to FayaNMS glyphs |
| Device/vendor glyphs absent from inventory | **RESOLVED** | Both integrated |
| Driver cards text-only | **RESOLVED** | Vendor glyphs now present |
| No metadata/social asset suite | **MOSTLY RESOLVED** | Local metadata + generated social/app assets exist |
| No validation scripts | **RESOLVED structurally** | Scripts exist, but contract coverage is incomplete |
| No CI enforcement | **NOT RESOLVED** | Workflow remains inactive |
| GitHub topics/social settings incomplete | **PARTIALLY RESOLVED** | social asset generated; topics remain empty |

---

# 5. Strengths to Preserve

## PASS-001 — Three-tier architecture is the correct long-term model

The repository now clearly separates:

```text
Tier 1 — FayaNMS brand
Tier 2 — FayaNMS domain / device / vendor icons
Tier 3 — Lucide generic UI / status
```

This is preferable to replacing every standard icon with custom artwork.

Preserve this decision.

---

## PASS-002 — External unrelated favicon is removed

`src/app/layout.tsx` no longer sets the favicon to the old external Z-AI URL.

Local metadata files now own browser/application identity.

This is a major improvement for:

- self-hosted environments;
- offline behavior;
- enterprise trust;
- branding consistency;
- third-party dependency reduction.

---

## PASS-003 — Canonical brand identity object exists

`src/lib/brand/identity.ts` defines:

```text
name
shortName
descriptor
edition
description
tagline
primary color
hover color
accent
asset paths
repository URL
```

This is the right architectural center.

The remaining task is to make all consumers truly use it.

---

## PASS-004 — Legacy `public/logo.svg` is static and canonical

The file now uses:

```text
24×24
fill none
stroke currentColor
stroke-width 2
round caps
round joins
```

The old breathing Z-style animation is gone.

---

## PASS-005 — Navigation domain icons are now governed

`src/lib/icons/navigation-icons.ts` maps the sidebar's current domains to FayaNMS custom glyphs.

Examples:

```text
network.devices      → devices
network.topology     → topology
network.firmware     → firmware
network.ztp          → zero-touch-provisioning
config.cmdb          → cmdb
perf.flows           → flow-analytics
perf.predictive      → predictive-health
admin.drivers        → device-drivers
```

This is a clear improvement in product identity.

---

## PASS-006 — Sidebar renderer keeps the 20px navigation contract

`DomainIcon` renders both Lucide and FayaNMS branches at the same 20px navigation size.

Preserve this.

---

## PASS-007 — Vendor coverage now matches the current adapter family

Current project glyph mapping includes:

```text
cisco
fortinet
sophos
hpe
juniper
palo
generic
```

Juniper and Palo Alto were missing from the first icon-kit version and are now present.

---

## PASS-008 — Vendor glyphs remain project glyphs

The documentation correctly distinguishes these from official vendor trademarks.

This is the safe and visually coherent direction for a multi-vendor prototype.

---

## PASS-009 — Device/vendor/status semantics are separated

Device inventory now follows the correct model:

```text
device-type icon → what it is
vendor glyph     → who makes/supports it
status badge     → how it behaves
```

This is much better than tinting a vendor logo to communicate state.

---

## PASS-010 — Device detail integration is good

The device detail header includes:

- device-type icon;
- hostname;
- vendor glyph;
- vendor/model text;
- status badge;
- site/role context.

The information hierarchy is appropriate.

---

## PASS-011 — Existing semantic status architecture was preserved

The application continues to use its centralized Lucide-backed status registry rather than duplicating status meaning inside the new icon kit.

This should remain unchanged.

---

## PASS-012 — The 12 proposed Icon Kit v2 additions exist

The re-audit independently sampled the following current files:

```text
firmware.svg
zero-touch-provisioning.svg
cmdb.svg
flow-analytics.svg
predictive-health.svg
vendor-juniper.svg
vendor-palo-alto.svg
ask-network.svg
ai-rca.svg
collector-rebalance.svg
failover-test.svg
configuration-encrypted.svg
```

The sampled SVGs consistently use the intended outline geometry:

```text
viewBox 0 0 24 24
fill none
stroke currentColor
stroke-width 2
round caps
round joins
```

---

# 6. New / Remaining Findings

# B0-001 — `Waypoints` still survives as a FayaNMS pseudo-logo

**Priority:** B0 — brand release blocker  
**File:** `src/components/shell/app-shell.tsx`

The first audit explicitly required retiring `Waypoints` as a product mark.

The current implementation still imports:

```ts
import { Waypoints } from "lucide-react";
```

and uses it in two brand contexts.

## Loading screen

```tsx
<span className="... bg-primary/10 text-primary">
  <Waypoints className="size-6" />
</span>
```

## Mobile navigation drawer

```tsx
<span className="... bg-primary text-primary-foreground">
  <Waypoints className="size-4.5" />
</span>
FayaNMS
```

This means a user can still see two product identities depending on application state or viewport.

## Required fix

Replace both with canonical components.

Loading:

```tsx
<FayaNMSMark size="lg" tone="brand" />
```

Mobile drawer:

```tsx
<FayaNMSLockup variant="horizontal" showDescriptor />
```

or a compact lockup pattern designed specifically for the sheet header.

## Acceptance

Repository-wide brand check should reject `Waypoints` when used in brand/shell contexts.

A search for `Waypoints` may remain valid for an actual topology feature, but never for:

```text
brand
loading
auth
sidebar header
mobile shell header
report cover
```

---

# B0-002 — Brand governance is not active in GitHub CI

**Priority:** B0 — production governance blocker  
**Files/settings:**

```text
docs/ci/ci-gate.yml
.github/workflows/   ← absent
GitHub main branch protection
GitHub required checks
```

The repository contains a CI definition, but it is stored under:

```text
docs/ci/ci-gate.yml
```

Its own header explicitly says it must be copied to:

```text
.github/workflows/ci.yml
```

before it is active.

The repository currently has:

```text
.github/CODEOWNERS
```

but no active workflow directory.

Current `main` is also unprotected and the audited commit has no GitHub status checks.

Therefore:

> `brand:validate` and `brand:validate-icons` are currently developer conventions, not non-bypassable repository controls.

## Required fix

Create/activate:

```text
.github/workflows/ci.yml
```

Then require at minimum:

```text
lint
typecheck
tests
brand:validate
brand:validate-icons
production build
```

Enable branch protection/ruleset:

```text
PR required
1+ approval
CODEOWNERS where applicable
required CI gate
conversation resolution
no force push
no branch deletion
```

## Gate

Do not describe brand governance as “CI-enforced” until a pushed commit has a green required check.

---

# B1-003 — Canonical lockup is not actually the only brand-composition path

**Priority:** B1  
**Files:**

```text
src/components/brand/fayanms-lockup.tsx
src/components/shell/app-sidebar.tsx
src/components/auth/sign-in-gate.tsx
src/components/shell/app-shell.tsx
```

`FayaNMSLockup` says:

> The ONLY way product identity is composed in app surfaces — no screen may hand-assemble mark + name.

But multiple screens still do exactly that.

## Sidebar

Current pattern:

```text
FayaNMSMark
literal "FayaNMS"
translated subtitle
```

## Sign-in

Current pattern:

```text
FayaNMSMark
literal "FayaNMS"
literal "Network Operations Management"
```

## Mobile sheet

Current pattern is worse:

```text
Waypoints
literal "FayaNMS"
```

## Required fix

All identity composition should use:

```tsx
<FayaNMSLockup />
```

with clear variants for:

```text
desktop sidebar
collapsed sidebar
sign-in
mobile drawer
loading
report cover
```

If localization requires the descriptor to be translated, add that as an explicit lockup API rather than reconstructing the brand outside the component.

---

# B1-004 — `FAYANMS_BRAND` is only a partial source of truth

**Priority:** B1  
**Files:**

```text
src/lib/brand/identity.ts
src/app/layout.tsx
src/components/brand/fayanms-mark.tsx
src/components/brand/fayanms-wordmark.tsx
src/components/shell/app-sidebar.tsx
src/components/auth/sign-in-gate.tsx
src/app/apple-icon.tsx
src/app/opengraph-image.tsx
src/app/twitter-image.tsx
scripts/generate-brand-raster-assets.ts
```

The code declares that `FAYANMS_BRAND` is the single source of truth, but brand literals remain duplicated.

Examples include:

```text
"FayaNMS — Network Operations Management"
"%s · FayaNMS"
creator: "FayaNMS"
publisher: "FayaNMS"
themeColor: "#2563EB"
text-[#2563EB]
BLUE = "#2563EB"
ACCENT = "#0891B2"
"Network Operations Management"
```

## Required fix

Create helper exports:

```ts
export const BRAND_TITLE = `${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`;
export const BRAND_THEME_COLOR = FAYANMS_BRAND.colors.primary;
```

Prefer CSS token classes:

```text
text-primary
```

inside application components.

For metadata/raster consumers, import from brand identity.

## Validation

Add a regression scanner for prohibited raw brand literals outside approved SoT/master files.

---

# B1-005 — Raster generator duplicates the logo geometry

**Priority:** B1  
**File:** `scripts/generate-brand-raster-assets.ts`

The script's comment says:

> Single source: the SVG mark master.

But the implementation does not read the master.

It defines a new `markSvg()` function containing the full mark geometry again:

```text
outer circle
3 node circles
3 connecting lines
```

This is a second source of geometric truth.

If `fayanms-mark.svg` changes, generated app icons/favicon/social preview can remain visually old while validation still succeeds.

## Required architecture

Choose one:

### Option A — shared geometry module

Create:

```text
src/lib/brand/mark-geometry.ts
```

Example:

```ts
export const FAYANMS_MARK_GEOMETRY = ...
export function renderFayaNMSMarkSvg(...)
```

Consume it from:

```text
FayaNMSMark component
raster generator
Apple icon
OG/Twitter
static master generator
```

### Option B — canonical SVG file is actual source

The generator reads:

```text
public/brand/fayanms-mark.svg
```

and uses Sharp/SVG transforms to recolor/compose it.

Option B more closely matches the current documentation.

---

# B1-006 — Apple/OG/Twitter artwork duplicates the same mark geometry

**Priority:** B1  
**Files:**

```text
src/app/apple-icon.tsx
src/app/opengraph-image.tsx
src/app/twitter-image.tsx
```

Each independently inlines the brand mark geometry.

This creates at least four mark definitions:

```text
public/brand/fayanms-mark.svg
FayaNMSMark.tsx
generate-brand-raster-assets.ts
apple-icon.tsx
opengraph-image.tsx
twitter-image.tsx
```

The project says it has one source of truth, but currently has multiple geometric implementations.

## Required fix

Create a shared, dependency-light brand artwork primitive for `ImageResponse` and build scripts.

Suggested tree:

```text
src/lib/brand/
├── identity.ts
├── mark-geometry.ts
├── social-copy.ts
└── types.ts

src/components/brand/
├── fayanms-mark.tsx
├── fayanms-lockup.tsx
└── social-card.tsx
```

---

# B1-007 — Brand guidelines forbid gradients, but OG/Twitter use a gradient

**Priority:** B1 — direct specification violation  
**Files:**

```text
docs/brand/BRAND-GUIDELINES.md
src/app/opengraph-image.tsx
src/app/twitter-image.tsx
```

Guidelines say:

```text
primary and accent are never blended into gradients for brand surfaces
```

The social image implementation uses:

```ts
linear-gradient(90deg, BLUE, ACCENT)
```

on the top brand strip.

That is a direct code-vs-policy conflict.

## Recommended fix

Keep the guideline and remove the gradient.

Use:

```text
solid #2563EB top rule
separate #0891B2 accent marker
```

or a split two-color geometric treatment without interpolation.

This better matches FayaNMS's calm enterprise/NOC language.

---

# B1-008 — Documented validator guarantees exceed real validator behavior

**Priority:** B1 — governance integrity  
**Files:**

```text
docs/brand/ICONOGRAPHY.md
docs/brand/ASSET-MANIFEST.md
scripts/validate-brand-assets.ts
scripts/validate-icon-registry.ts
```

This is the largest governance-quality problem after inactive CI.

The documentation states that validation enforces substantially more than the scripts currently check.

## Docs claim icon validation enforces

```text
exact viewBox 0 0 24 24
fill none
stroke currentColor
stroke-width 2
round line caps
round line joins
no gradients
no filters
no style blocks
catalog synchronization
raw-path prohibition
registry/file coverage
master/consumer coverage
```

## Current `validate-icon-registry.ts` actually checks mainly

```text
disk filenames ↔ FayanmsIconName union
navigation registry targets exist
hardcoded vendor probes resolve
hardcoded device probes resolve
```

It does not parse each SVG and enforce the geometry contract.

## `validate-brand-assets.ts` checks some SVG properties

It verifies:

```text
viewBox exists
runtime master has stroke="currentColor"
body fill/stroke attrs are none/currentColor
animation patterns absent
```

but does not prove:

```text
viewBox exactly equals 0 0 24 24
stroke-width exactly 2
caps = round
joins = round
root fill = none
no gradients
no filters
no style
no embedded scripts
catalog row coverage
raster dimensions
asset extras
wordmark text synchronization
```

`COLOR_ATTR` is also declared but unused.

## Required fix

Make the scripts match the documentation.

Do **not** weaken the docs to match the scripts.

---

# B1-009 — Icon catalog is not part of the executable validation gate

**Priority:** B1  
**Files:**

```text
docs/brand/ICON-CATALOG.md
scripts/validate-icon-registry.ts
```

The documentation says catalog count/coverage is governed.

The current validator does not parse `ICON-CATALOG.md`.

Therefore all of the following could happen without the validator noticing:

```text
missing catalog row
duplicate catalog row
wrong icon name
stale total
wrong v2 designation
wrong semantic recommendation
```

## Required fix

Parse the catalog and enforce:

```text
disk icon names == type union icon names == catalog icon names
```

Report:

```text
missing in catalog
phantom in catalog
duplicates
count mismatch
```

---

# B1-010 — “No orphaned icons” is not actually enforced

**Priority:** B1

The current exact match between disk names and the TypeScript union is not equivalent to proving an icon has a consumer.

Many kit icons are intended as a reusable icon library and may not yet appear in runtime screens.

The documentation currently says:

> a master without a consumer is a validation failure.

That rule is too strong for a reusable icon catalog and is not enforced anyway.

## Recommended governance model

Separate:

```text
cataloged icon
registered icon
runtime-referenced icon
```

Policy:

- every disk master must be cataloged;
- every registry reference must resolve;
- runtime-unused masters are allowed;
- unused masters are reported as **warnings**, not failures;
- “required runtime icons” can have an explicit must-use list.

This is more honest and maintainable.

---

# B1-011 — Vendor validation is hardcoded instead of derived from the adapter registry

**Priority:** B1  
**File:** `scripts/validate-icon-registry.ts`

The validator contains:

```ts
const VENDOR_KEYS = [
  "cisco",
  "fortinet",
  "sophos",
  "hpe",
  "juniper",
  "palo",
  "generic",
  ...
];
```

The comment says this protects the driver catalog, but the validator does not import the real driver/adapter source.

If a new adapter is added:

```text
arista
mikrotik
checkpoint
extreme
...
```

the brand validator can remain green until someone manually remembers to update `VENDOR_KEYS`.

## Required fix

Derive from the actual adapter registry:

```ts
for (const adapter of adapters) {
  assert(vendorIconFor(adapter.vendor) !== GENERIC_VENDOR_ICON || adapter.vendor === "generic");
}
```

Also assert a display label exists.

---

# B1-012 — Known device roles intentionally lose useful icon semantics

**Priority:** B1 — UX scanability  
**Files:**

```text
src/lib/icons/device-icons.ts
src/components/views/device-detail-view.tsx
```

The product already knows roles such as:

```text
CORE_ROUTER
EDGE_ROUTER
BRANCH_ROUTER
FIREWALL
CORE_SWITCH
ACCESS_SWITCH
TOP_OF_RACK
WIRELESS_CONTROLLER
LOAD_BALANCER
WAN_GATEWAY
```

But `deviceIconFor()` only recognizes substring families:

```text
firewall
router
switch
server/appliance
cloud/virtual
```

So the following known roles fall back to `device-generic`:

```text
TOP_OF_RACK
WIRELESS_CONTROLLER
LOAD_BALANCER
WAN_GATEWAY
```

That wastes product knowledge.

## Minimum remediation

Create canonical role metadata:

```ts
const DEVICE_ROLE_META = {
  CORE_ROUTER: { label: "Core router", icon: "device-router" },
  EDGE_ROUTER: { label: "Edge router", icon: "device-router" },
  BRANCH_ROUTER: { label: "Branch router", icon: "device-router" },
  CORE_SWITCH: { label: "Core switch", icon: "device-switch" },
  ACCESS_SWITCH: { label: "Access switch", icon: "device-switch" },
  TOP_OF_RACK: { label: "Top of rack", icon: "device-switch" },
  WAN_GATEWAY: { label: "WAN gateway", icon: "device-router" },
  LOAD_BALANCER: { label: "Load balancer", icon: "device-server" },
  WIRELESS_CONTROLLER: { label: "Wireless controller", icon: "device-server" },
};
```

## Better v3 extension

Add dedicated device glyphs:

```text
device-wireless-controller
device-load-balancer
device-wan-gateway
device-access-point
```

Only add them if the product exposes these concepts repeatedly.

---

# B1-013 — README primary mark is not safely theme-aware

**Priority:** B1  
**Files:**

```text
README.md
public/brand/fayanms-mark.svg
```

README renders:

```html
<img src="public/brand/fayanms-mark.svg" ... />
```

The primary SVG uses:

```xml
stroke="currentColor"
```

An SVG loaded as an external `<img>` does not inherit the GitHub page's parent `color` property.

Therefore the mark is not reliably “brand blue through currentColor” in README contexts and may render as the SVG's default current color instead.

## Required fix

Separate runtime currentColor semantics from static brand artwork.

Recommended:

```text
public/brand/fayanms-mark.svg          → static brand-primary blue
public/icons/fayanms/fayanms-mark.svg  → currentColor icon master
FayaNMSMark.tsx                        → currentColor runtime component
```

Or create explicit:

```text
fayanms-mark-brand.svg
fayanms-mark-white.svg
```

and use the correct static asset in README/social/docs.

---

# B1-014 — “Simplified favicon mark” policy is documented but not implemented

**Priority:** B1  
**Files:**

```text
docs/brand/BRAND-GUIDELINES.md
public/brand/README.md
src/app/icon.svg
scripts/generate-brand-raster-assets.ts
```

Guidelines say the 16px favicon uses a simplified derivative.

But the current SVG favicon and ICO generator use the same full mark:

```text
outer ring
3 outlined nodes
3 connectors
```

At 16px, multiple 2px strokes and tiny outlined circles can become optically heavy or muddy.

## Required fix

Introduce a micro-mark optimized for 16–20px.

Suggested:

```text
public/brand/fayanms-mark-micro.svg
```

Possible geometry:

```text
ring
3 solid nodes
simplified hub
reduced connector detail
```

Test at:

```text
16
20
24
32
```

Do not simply scale the 24px master down and call it “simplified”.

---

# B1-015 — GitHub repository topics remain empty

**Priority:** B1 — repository brand/discoverability  
**Setting:** GitHub About/topics

The brand playbook recommends focused topics such as:

```text
nms
network-management
network-automation
network-monitoring
network-configuration
configuration-backup
change-management
incident-management
noc
snmp
netconf
restconf
network-operations
nextjs
typescript
```

Current repository metadata shows:

```text
topics: []
```

## Required fix

Apply the recommended topic set.

This is not code work; it is a repository setting.

---

# B1-016 — GitHub About description conflicts with the truthfulness playbook

**Priority:** B1

The current public repository description presents FayaNMS as an enterprise NMS and lists many capabilities/vendors.

The brand playbook specifically recommends keeping **demo semantics visible**:

> Enterprise multi-vendor network operations, configuration, change, incident and performance management — a self-contained demo platform.

The README itself is careful and explicitly describes the project as a demo/control-plane prototype.

The About description should not be more production-sounding than the README.

## Recommended description

```text
FayaNMS is a self-contained enterprise NMS demo/control-plane for multi-vendor inventory, configuration backup, change workflows, incidents, NOC monitoring, performance, automation, audit and reporting.
```

This remains strong while being accurate.

---

# B1-017 — Brand paths are not protected by CODEOWNERS

**Priority:** B1  
**File:** `.github/CODEOWNERS`

Current CODEOWNERS protects security/CI areas but does not explicitly protect the identity system.

Add:

```text
/public/brand/                         @fayafatehi
/public/icons/fayanms/                 @fayafatehi
/src/lib/brand/                        @fayafatehi
/src/components/brand/                 @fayafatehi
/src/lib/icons/                        @fayafatehi
/src/components/icons/                 @fayafatehi
/docs/brand/                           @fayafatehi
/scripts/validate-brand-assets.ts      @fayafatehi
/scripts/validate-icon-registry.ts     @fayafatehi
/scripts/generate-brand-raster-assets.ts @fayafatehi
```

This only becomes enforceable after branch protection requires CODEOWNERS review.

---

# B2-018 — `FayaNMSMark` brand tone hardcodes the hex color

**Priority:** B2  
**Files:**

```text
src/components/brand/fayanms-mark.tsx
src/components/brand/fayanms-wordmark.tsx
```

Both contain:

```text
text-[#2563EB]
```

The design token already exists.

Prefer:

```text
text-primary
```

for application rendering.

Use brand identity hex only for non-CSS artifacts.

This removes one more drift source.

---

# B2-019 — Mark size API and documented minimums are inconsistent

**Priority:** B2

`FayaNMSMark` defines:

```text
xs = 14
sm = 20
md = 24
lg = 32
```

The brand guide defines:

```text
sign-in = 40
docs/report = 64+
```

but the component cannot render 40 or 64 via named variants.

The sign-in screen actually uses the 20px `sm` mark inside a 40px tile.

## Fix options

Either:

1. change the documented guidance to distinguish **container size** from **glyph size**; or
2. extend the component:

```text
xl = 40
2xl = 64
```

Recommended: document both tile and glyph size explicitly.

---

# B2-020 — `NetworkDeviceIcon` standalone accessible name is not useful

**Priority:** B2  
**File:** `src/components/icons/network-device-icon.tsx`

Standalone mode currently emits:

```text
"Device type glyph"
```

regardless of actual device type.

A standalone router icon should expose something like:

```text
"Router"
```

not a generic implementation description.

## Required fix

Create:

```ts
deviceIconLabelFor(type)
```

Return meaningful semantic labels.

---

# B2-021 — Custom icon renderer should use `aria-label` for standalone semantics

**Priority:** B2  
**File:** `src/components/icons/fayanms-icon.tsx`

The renderer currently uses:

```tsx
title={title}
role={title ? "img" : undefined}
```

A stronger contract is:

```tsx
aria-label={title}
role={title ? "img" : undefined}
```

The native `title` attribute may remain optional for hover affordance, but should not be the primary accessibility-name API.

Keep icon-only button accessible names at the button level.

---

# B2-022 — Driver view renders a calibrated 24×24 outline glyph at 12px

**Priority:** B2  
**File:** `src/components/views/admin-drivers-view.tsx`

Current use:

```tsx
<FayanmsIcon name="configuration" size={12} />
```

The documented scale starts at:

```text
xs = 14px
```

The numeric escape hatch technically permits 12, but 2px-stroke custom geometry becomes tight at that size.

Prefer:

```text
14px minimum
```

unless visual QA explicitly proves 12px is clean across Windows/macOS/browser scaling.

---

# B2-023 — Static wordmark/lockup SVGs depend on installed fonts

**Priority:** B2  
**Files:**

```text
public/brand/fayanms-wordmark.svg
public/brand/fayanms-lockup-horizontal.svg
other static lockups
```

The static SVG uses:

```xml
<text font-family="Inter, 'DejaVu Sans', sans-serif">
```

If the viewer does not have Inter, glyph metrics change.

This is acceptable for a flexible typographic template, but not fully deterministic as a brand “master”.

## Options

### Deterministic external master

Convert final external wordmark lettering to paths.

### Flexible typography

Keep `<text>` and explicitly document:

> External lockups are typographic templates and may render with the fallback sans-serif if Inter is unavailable.

Do not imply pixel-identical reproduction if fonts are not embedded/path-converted.

---

# B2-024 — OG and Twitter implementations are duplicated

**Priority:** B2  
**Files:**

```text
src/app/opengraph-image.tsx
src/app/twitter-image.tsx
```

They are almost identical.

This doubles drift risk.

## Required fix

Create:

```text
src/components/brand/social-card.tsx
```

or:

```text
src/lib/brand/social-card.tsx
```

Then both metadata routes wrap the shared visual.

---

# B2-025 — Navigation registry is not actually exhaustive at the type level

**Priority:** B2  
**File:** `src/lib/icons/navigation-icons.ts`

Current declaration uses:

```ts
as const satisfies Record<string, NavIcon>
```

This validates values, but does not prove that every desired navigation key exists.

The runtime/validator currently compensates by scanning sidebar code.

## Better model

Define a canonical sidebar-key type first:

```ts
type SidebarViewKey = ...;
```

Then:

```ts
const NAVIGATION_ICONS = {
  ...
} satisfies Record<SidebarViewKey, NavIcon>;
```

Or derive the sidebar config from the registry so there is only one mapping.

---

# B2-026 — Brand asset manifest contains a favicon path inconsistency

**Priority:** B2  
**Files:**

```text
docs/brand/ASSET-MANIFEST.md
scripts/generate-brand-raster-assets.ts
src/app/favicon.ico
```

The manifest's raster section refers to:

```text
public/brand/favicon.ico
```

The generator actually writes:

```text
src/app/favicon.ico
```

and the public brand directory does not expose a `favicon.ico` entry.

This is a documentation defect.

## Fix

Document the actual canonical location:

```text
src/app/favicon.ico
```

If a second downloadable public brand ICO is desired, deliberately generate both and list both.

---

# B2-027 — No dedicated automated brand component / E2E test suite is present

**Priority:** B2

The previous plan proposed:

```text
tests/brand-assets.test.ts
tests/icon-registry.test.ts
tests/icon-accessibility.test.tsx
tests/e2e/brand-shell.spec.ts
```

The current implementation relies on validation scripts and local browser verification.

That is useful, but different from component/E2E regression coverage.

## Recommended minimum

Add tests for:

```text
FayaNMSMark accessibility modes
FayaNMSLockup variants
FayanmsIcon decorative vs standalone semantics
vendor fallback
device-role mappings
all navigation icons resolving
metadata output
no Waypoints identity regression
mobile drawer canonical mark
loading state canonical mark
```

Visual regression should include:

```text
sign-in
desktop sidebar expanded
desktop sidebar collapsed
mobile drawer
loading shell
device inventory
driver catalog
light
dark
LTR
RTL
```

---

# B2-028 — Package name still exposes the starter/template origin

**Priority:** B2 / repository polish  
**File:** `package.json`

Current package name:

```json
"name": "nextjs_tailwind_shadcn_ts"
```

For a private package this is not a runtime defect, but it is visible technical residue.

Rename to:

```json
"name": "fayanms"
```

or an organization namespace if one exists:

```json
"name": "@faya/fayanms"
```

Keep:

```json
"private": true
```

---

# B3-029 — `siteUrl()` can silently emit localhost metadata in production

**Priority:** B2/B3  
**File:** `src/lib/brand/identity.ts`

Current:

```ts
return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
```

This is appropriate for local development but unsafe as a silent production fallback.

If production deploys without the environment variable, absolute metadata may point to localhost.

## Required fix

```ts
if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_SITE_URL) {
  throw new Error("NEXT_PUBLIC_SITE_URL is required in production");
}
```

Validate URL protocol/host.

Allow localhost only in dev/test.

---

# B3-030 — Current commit is unsigned

**Priority:** B3 — optional governance hardening

Current head reports GitHub commit verification as unsigned.

This is not a brand defect, but once brand/master paths become protected, signed commits or a repository ruleset can add provenance for high-impact identity changes.

Treat this as optional unless the organization adopts signed-commit policy globally.

---

# 7. Documentation Quality Audit

The current `docs/brand/` suite is a major improvement.

Current documents include:

```text
ACCESSIBILITY.md
ASSET-MANIFEST.md
BRAND-GUIDELINES.md
ICON-CATALOG.md
ICONOGRAPHY.md
SOCIAL-REPOSITORY.md
VENDOR-GLYPHS.md
```

and:

```text
docs/adr/ADR-brand-icon-architecture.md
```

## Strong areas

The documentation does well at defining:

- brand personality;
- three-tier icon model;
- no vendor dominance;
- status-vs-brand separation;
- minimum sizes;
- RTL behavior;
- accessibility;
- vendor trademark policy;
- raster derivative policy;
- GitHub playbook;
- honest badge policy.

## Main documentation problem

The docs frequently describe desired validation guarantees as if they are already executable.

The next phase should make:

```text
documentation contract == validator behavior == CI enforcement
```

That should become a non-negotiable invariant.

---

# 8. Full Target Brand Architecture v2.1

```text
FayaNMS/
├── public/
│   ├── brand/
│   │   ├── fayanms-mark-brand.svg          # static brand-blue external mark
│   │   ├── fayanms-mark-micro.svg          # NEW 16–20px optimized mark
│   │   ├── fayanms-mark-mono.svg
│   │   ├── fayanms-mark-white.svg
│   │   ├── fayanms-wordmark.svg
│   │   ├── fayanms-wordmark-white.svg
│   │   ├── fayanms-lockup-horizontal.svg
│   │   ├── fayanms-lockup-horizontal-white.svg
│   │   ├── fayanms-lockup-stacked.svg
│   │   ├── fayanms-noc-mark.svg
│   │   ├── fayanms-network-shield.svg
│   │   ├── app-icon-192.png
│   │   ├── app-icon-512.png
│   │   ├── app-icon-maskable-192.png
│   │   ├── app-icon-maskable-512.png
│   │   ├── github-social-preview.png
│   │   └── README.md
│   │
│   └── icons/
│       └── fayanms/
│           └── 228+ currentColor icon masters
│
├── src/
│   ├── app/
│   │   ├── icon.svg
│   │   ├── favicon.ico
│   │   ├── apple-icon.tsx
│   │   ├── opengraph-image.tsx
│   │   ├── twitter-image.tsx
│   │   ├── manifest.ts
│   │   └── layout.tsx
│   │
│   ├── components/
│   │   ├── brand/
│   │   │   ├── fayanms-mark.tsx
│   │   │   ├── fayanms-wordmark.tsx
│   │   │   ├── fayanms-lockup.tsx
│   │   │   ├── fayanms-product-badge.tsx
│   │   │   ├── social-card.tsx             # NEW
│   │   │   └── index.ts
│   │   └── icons/
│   │       ├── fayanms-icon.tsx
│   │       ├── domain-icon.tsx
│   │       ├── device-vendor-icon.tsx
│   │       ├── network-device-icon.tsx
│   │       └── index.ts
│   │
│   └── lib/
│       ├── brand/
│       │   ├── identity.ts
│       │   ├── mark-geometry.ts             # NEW / recommended
│       │   ├── social-copy.ts               # NEW / optional
│       │   ├── types.ts
│       │   └── index.ts
│       └── icons/
│           ├── types.ts
│           ├── navigation-icons.ts
│           ├── vendor-icons.ts
│           ├── device-icons.ts
│           ├── device-role-meta.ts          # NEW
│           └── index.ts
│
├── scripts/
│   ├── validate-brand-assets.ts             # STRENGTHEN
│   ├── validate-icon-registry.ts            # STRENGTHEN
│   ├── validate-brand-consumers.ts          # NEW
│   └── generate-brand-raster-assets.ts      # REFACTOR
│
├── tests/
│   └── brand/
│       ├── identity.test.ts
│       ├── icon-registry.test.ts
│       ├── accessibility.test.tsx
│       └── shell-brand.test.tsx
│
└── .github/
    └── workflows/
        └── ci.yml                            # ACTIVATE
```

---

# 9. Strengthened Brand Validator Specification

`brand:validate` should become deterministic and comprehensive.

## 9.1 Brand master inventory

Assert exact governed Tier-1 set.

Fail on:

```text
missing governed master
unknown extra master
duplicate semantic role
invalid extension
```

Allow generated raster derivatives through an explicit generated list.

---

## 9.2 SVG parsing

Do not rely only on regex.

Use an XML parser or a narrow safe parser.

Check:

```text
valid SVG
valid root
viewBox expected for each master
no script
no external href
no remote image
no foreignObject unless explicitly allowed
no animation
no filters unless explicitly allowed
```

---

## 9.3 Tier-2 icon geometry

For every custom domain icon:

```text
viewBox == "0 0 24 24"
width == 24 or omitted by policy
height == 24 or omitted by policy
fill == none
stroke == currentColor
stroke-width == 2
stroke-linecap == round
stroke-linejoin == round
```

Reject:

```text
gradient
filter
embedded stylesheet
hardcoded palette color
script
external resource
```

---

## 9.4 Brand color validation

Validate against:

```text
FAYANMS_BRAND.colors.primary
FAYANMS_BRAND.colors.primaryHover
FAYANMS_BRAND.colors.accent
```

Do not maintain an unrelated list of duplicate literal values inside the validator.

---

## 9.5 Raster validation

Read dimensions with Sharp.

Assert:

```text
app-icon-192          192×192
app-icon-512          512×512
maskable-192          192×192
maskable-512          512×512
github-social-preview 1280×640
favicon ICO           16/32/48
```

Optionally hash generated outputs and support:

```bash
bun run brand:raster
git diff --exit-code public/brand src/app/favicon.ico
```

That catches stale committed derivatives.

---

# 10. Strengthened Icon Registry Validator

The validator should compare four data sets:

```text
disk masters
TypeScript FayanmsIconName
catalog names
registry references
```

## Hard failures

```text
disk not in type union
type union not on disk
disk not in catalog
catalog not on disk
registry target missing
duplicate catalog name
invalid geometry
invalid name
```

## Warnings

```text
cataloged icon currently unused by runtime
rare numeric render size under 14px
deprecated alias
```

---

# 11. New Brand Consumer Validator

Create:

```text
scripts/validate-brand-consumers.ts
```

Purpose: prevent the exact regressions found by this re-audit.

## Blocked patterns

Outside approved SoT/master files:

```text
Waypoints used in brand shell/header/auth
literal "FayaNMS" in app identity composition
literal "Network Operations Management"
text-[#2563EB]
direct /icons/fayanms/*.svg raw references
external identity URLs
duplicate mark geometry signatures
```

This can be AST-based for TS/TSX.

Do not naïvely forbid the word “FayaNMS” from all documentation/user text.

Scope the rules to known identity composition APIs.

---

# 12. Device Role Metadata Refactor

Currently role labels live separately from icon inference.

Create one source:

```ts
export const DEVICE_ROLE_META = {
  CORE_ROUTER: {
    label: "Core router",
    icon: "device-router",
    family: "router",
  },
  ...
} as const;
```

Use it from:

```text
device detail
device list
filters
reports
topology
command palette
device-icon resolver
validation tests
```

Fallback only for truly unknown roles.

---

# 13. Social Artwork Refactor

Current:

```text
OG card          duplicates mark/colors/layout
Twitter card     duplicates mark/colors/layout
GitHub preview   duplicates mark/colors/layout in raster generator
Apple icon       duplicates mark
```

Target:

```text
brand identity
      ↓
shared brand geometry
      ↓
shared social composition tokens
   ↙       ↓          ↘
OG      Twitter     GitHub PNG
```

Keep output dimensions surface-specific, but not visual logic duplicated.

---

# 14. GitHub Repository Completion Tasks

## Required now

```text
GH-BR-001 apply repository topics
GH-BR-002 align About description with demo truthfulness
GH-BR-003 upload generated social preview
GH-BR-004 activate .github/workflows/ci.yml
GH-BR-005 protect main
GH-BR-006 require brand CI gates
GH-BR-007 add brand paths to CODEOWNERS
```

## Intentionally deferred

Website URL:

```text
leave empty until a real docs/product URL exists
```

This is correct current behavior.

## Separate legal decision

License:

```text
repository currently has no selected license
```

Do not add a license badge until an actual license is chosen.

---

# 15. Implementation Roadmap

# Phase BR-C0 — Close visible identity inconsistencies

**Goal:** one product identity everywhere.

Tasks:

```text
BR-C0-001 replace Waypoints loading mark
BR-C0-002 replace Waypoints mobile drawer mark
BR-C0-003 migrate desktop sidebar to FayaNMSLockup
BR-C0-004 migrate sign-in to FayaNMSLockup
BR-C0-005 remove literal product name/descriptor from identity composition
BR-C0-006 add regression test/search for Waypoints-as-brand
```

### Gate

A viewport/state sweep must show the same canonical mark for:

```text
initial loading
unauthenticated sign-in
desktop expanded
desktop collapsed
mobile drawer
RTL mobile drawer
dark mode
```

---

# Phase BR-C1 — Make the source of truth real

Tasks:

```text
BR-C1-001 shared mark geometry/master loader
BR-C1-002 refactor FayaNMSMark
BR-C1-003 refactor Apple icon
BR-C1-004 refactor OG image
BR-C1-005 refactor Twitter image
BR-C1-006 refactor raster generator
BR-C1-007 consume FAYANMS_BRAND colors/copy
BR-C1-008 replace text-[#2563EB] with token
BR-C1-009 production-safe siteUrl validation
```

### Gate

Changing the canonical brand primary/name/descriptor or mark geometry in one approved source must propagate to every generated/runtime identity surface without hand-editing multiple implementations.

---

# Phase BR-C2 — Validator truthfulness

Tasks:

```text
BR-C2-001 exact SVG geometry validation
BR-C2-002 prohibited SVG-feature validation
BR-C2-003 catalog parser
BR-C2-004 catalog/disk/type exact-set comparison
BR-C2-005 derive vendor coverage from actual adapter registry
BR-C2-006 raster dimension validation
BR-C2-007 stale generated-asset detection
BR-C2-008 brand consumer validator
BR-C2-009 fix ASSET-MANIFEST favicon path
BR-C2-010 remove unused/dead validator constants
```

### Gate

Every documented “validator fails when…” statement has a corresponding executable test.

---

# Phase BR-C3 — Device semantics and accessibility

Tasks:

```text
BR-C3-001 centralize device role metadata
BR-C3-002 map TOP_OF_RACK correctly
BR-C3-003 map WAN_GATEWAY correctly
BR-C3-004 map LOAD_BALANCER correctly
BR-C3-005 map WIRELESS_CONTROLLER correctly
BR-C3-006 decide whether dedicated v3 glyphs are warranted
BR-C3-007 semantic standalone device icon labels
BR-C3-008 aria-label contract for meaningful custom icons
BR-C3-009 normalize minimum custom glyph size
BR-C3-010 favicon micro-mark
```

---

# Phase BR-C4 — Repository governance

Tasks:

```text
BR-C4-001 activate CI workflow
BR-C4-002 protect main
BR-C4-003 require CI status checks
BR-C4-004 add brand CODEOWNERS
BR-C4-005 GitHub topics
BR-C4-006 About description
BR-C4-007 verify social preview upload
BR-C4-008 add brand unit/component tests
BR-C4-009 add shell visual regression
BR-C4-010 optional signed-commit/ruleset policy
```

### Final gate

No direct push to `main` can merge a brand/icon change that fails validation.

---

# 16. Required Test Matrix

## Brand shell

Test:

```text
375
768
1024
1280
1440
1920
```

States:

```text
loading
sign-in
authenticated
mobile nav open
sidebar expanded
sidebar collapsed
```

Themes:

```text
light
dark
system
```

Direction:

```text
LTR
RTL
```

Zoom:

```text
80%
100%
125%
150%
200%
```

---

## Icon legibility

For representative custom icons:

```text
14
16
20
24
32
```

Test:

```text
1x DPR
1.25x Windows scaling
1.5x
2x
dark
light
muted
active
disabled
```

---

## Micro-mark

Test:

```text
16
20
24
32
48
180
192
512
```

The 16px form must not visually collapse.

---

## Vendor/device rows

Test:

```text
all 7 current vendors
unknown vendor
missing vendor
all known device roles
unknown role
very long hostname
very long vendor/model
RTL
dense mode
```

---

# 17. Proposed v3 Icon Additions

Do **not** expand the icon kit simply to increase its count.

Only add new icons when a repeated semantic concept warrants distinct scanning.

Recommended candidates:

| Icon | Priority | Reason |
|---|---|---|
| `fayanms-mark-micro` | High | favicon/app micro identity |
| `device-wireless-controller` | Medium | known repeated role |
| `device-load-balancer` | Medium | known repeated role |
| `device-wan-gateway` | Medium | known repeated role |
| `device-access-point` | Low/future | useful if wireless inventory expands |
| `vendor-arista` | Future | only when adapter exists |
| `vendor-mikrotik` | Future | only when adapter exists |
| `vendor-check-point` | Future | only when adapter exists |

Do not create vendor glyphs before actual adapter/product support exists.

---

# 18. Files to Modify — Exact Remediation Set

## B0 / immediate

```text
src/components/shell/app-shell.tsx
src/components/shell/app-sidebar.tsx
src/components/auth/sign-in-gate.tsx
src/components/brand/fayanms-lockup.tsx
```

## Brand SoT

```text
src/lib/brand/identity.ts
src/lib/brand/types.ts
src/components/brand/fayanms-mark.tsx
src/components/brand/fayanms-wordmark.tsx
src/app/layout.tsx
```

## Artwork generation

```text
src/app/apple-icon.tsx
src/app/opengraph-image.tsx
src/app/twitter-image.tsx
scripts/generate-brand-raster-assets.ts
```

## New shared files

```text
src/lib/brand/mark-geometry.ts
src/components/brand/social-card.tsx
```

## Validators

```text
scripts/validate-brand-assets.ts
scripts/validate-icon-registry.ts
scripts/validate-brand-consumers.ts
```

## Icon/device semantics

```text
src/lib/icons/types.ts
src/lib/icons/navigation-icons.ts
src/lib/icons/vendor-icons.ts
src/lib/icons/device-icons.ts
src/lib/icons/device-role-meta.ts
src/components/icons/fayanms-icon.tsx
src/components/icons/network-device-icon.tsx
src/components/icons/device-vendor-icon.tsx
```

## Brand assets

```text
public/brand/fayanms-mark.svg
public/brand/fayanms-mark-micro.svg
public/brand/README.md
README.md
```

## Documentation

```text
docs/brand/BRAND-GUIDELINES.md
docs/brand/ICONOGRAPHY.md
docs/brand/ICON-CATALOG.md
docs/brand/ASSET-MANIFEST.md
docs/brand/SOCIAL-REPOSITORY.md
docs/brand/ACCESSIBILITY.md
docs/brand/VENDOR-GLYPHS.md
docs/adr/ADR-brand-icon-architecture.md
```

## Governance

```text
.github/CODEOWNERS
.github/workflows/ci.yml
```

## Tests

```text
tests/brand/identity.test.ts
tests/brand/icon-registry.test.ts
tests/brand/accessibility.test.tsx
tests/brand/shell-brand.test.tsx
tests/e2e/brand-shell.spec.ts
```

---

# 19. Acceptance Criteria

## Identity

- no `Waypoints` used as a product identity;
- loading/mobile/sidebar/sign-in all use canonical FayaNMS brand components;
- no old Z-style visual remains;
- no external favicon/brand URL;
- no hand-built mark + literal name on product shell surfaces.

## Single source of truth

- product name/descriptor/edition/color are imported from brand identity;
- canonical mark geometry exists in one implementation source;
- raster/social/Apple artifacts derive from the same source;
- changing the primary mark does not require six manual edits.

## Icons

- custom masters obey exact geometry contract;
- all disk masters are cataloged;
- all registry references resolve;
- vendor registry is validated against actual adapters;
- device roles use intentional mappings;
- generic UI remains Lucide.

## Accessibility

- decorative icons are hidden;
- standalone semantic icons have useful labels;
- icon-only controls are named at the control level;
- brand does not convey status;
- RTL does not mirror brand/vendor/device geometry.

## Repository governance

- active GitHub workflow exists;
- `main` protected;
- brand validators required;
- CODEOWNERS protects brand paths;
- repository topics populated;
- About description reflects demo maturity;
- social preview manually verified.

---

# 20. Production Brand Gate

FayaNMS may call the brand/icon subsystem **production-governed** only after all of the following are true:

```text
[ ] No Waypoints pseudo-brand remains
[ ] Canonical lockup used on every app identity surface
[ ] Brand literals centralized
[ ] Mark geometry single-sourced
[ ] Social/Apple/raster artwork uses shared geometry
[ ] OG/Twitter gradient policy conflict resolved
[ ] Micro favicon mark implemented or policy corrected
[ ] Exact SVG geometry validator implemented
[ ] Catalog validation implemented
[ ] Vendor validation derives from adapters
[ ] Device role metadata centralized
[ ] Accessibility standalone labels fixed
[ ] ASSET-MANIFEST matches actual paths
[ ] Active GitHub Actions workflow
[ ] Main branch protected
[ ] Brand CI checks required
[ ] Brand CODEOWNERS paths present
[ ] GitHub topics populated
[ ] About description aligned
[ ] Social preview verified
[ ] Brand component tests green
[ ] Visual shell regression green
```

---

# 21. Recommended Updated Score After Remediation

If the above plan is completed:

| Area | Target |
|---|---:|
| Identity consistency | 98 |
| Metadata | 98 |
| Asset completeness | 98 |
| Color/token identity | 96 |
| Navigation semantics | 98 |
| Device/vendor iconography | 95 |
| Accessibility | 95 |
| Repository branding | 95 |
| Documentation | 97 |
| Validator enforcement | 98 |
| CI governance | 98 |
| **Overall** | **97/100** |

The final few points would depend on real visual-regression evidence, production deployment branding, legal/license decisions, and actual long-term change governance.

---

# 22. Recommended Implementation Order

Do not start by drawing more icons.

Use this order:

```text
1. Remove remaining Waypoints pseudo-brand
2. Use FayaNMSLockup everywhere
3. Refactor brand identity constants
4. Single-source mark geometry
5. Refactor social/Apple/raster generation
6. Strengthen validators
7. Centralize device-role semantics
8. Add micro favicon
9. Add tests
10. Activate CI
11. Protect main
12. Apply GitHub repository settings
13. Only then consider v3 icon expansion
```

This sequence fixes structural drift before adding additional artwork.

---

# 23. Key Audit Decision

The current visual direction should **not be redesigned from scratch**.

The protected-network ring/node mark is sufficiently aligned with the product.

The blue/cyan palette is appropriate.

The Lucide + custom-domain separation is appropriate.

The 228-icon kit is more than sufficient for the current product.

The next investment should be **consistency, derivation, validation and enforcement**, not visual proliferation.

---

# 24. Final Verdict

## Previous state

```text
52/100
Coherent design system, fragmented identity
```

## Current state

```text
82/100
Strong brand/icon architecture, incomplete governance and residual identity drift
```

## Production recommendation

**CONDITIONAL PASS for the visual/icon architecture.**

**FAIL for “fully governed / production-enforced” status until the B0/B1 findings are closed.**

The current implementation demonstrates the correct architecture and has already fixed most of the original visible problems. The remaining work is much smaller than the first audit, but it is important because it determines whether the brand system is merely well documented or genuinely impossible to drift accidentally.

---

# Appendix A — Current Verified Brand Files

Verified/observed in the current repository:

```text
public/brand/
  README.md
  app-icon-192.png
  app-icon-512.png
  app-icon-maskable-192.png
  app-icon-maskable-512.png
  fayanms-lockup-horizontal-white.svg
  fayanms-lockup-horizontal.svg
  fayanms-lockup-stacked.svg
  fayanms-mark-mono.svg
  fayanms-mark-white.svg
  fayanms-mark.svg
  fayanms-network-shield.svg
  fayanms-noc-mark.svg
  fayanms-wordmark-white.svg
  fayanms-wordmark.svg
  github-social-preview.png
```

Note:

```text
src/app/favicon.ico
```

is generated by the raster script and should be documented there rather than as `public/brand/favicon.ico`.

---

# Appendix B — v2 Icon Additions Verified

```text
public/icons/fayanms/firmware.svg
public/icons/fayanms/zero-touch-provisioning.svg
public/icons/fayanms/cmdb.svg
public/icons/fayanms/flow-analytics.svg
public/icons/fayanms/predictive-health.svg
public/icons/fayanms/vendor-juniper.svg
public/icons/fayanms/vendor-palo-alto.svg
public/icons/fayanms/ask-network.svg
public/icons/fayanms/ai-rca.svg
public/icons/fayanms/collector-rebalance.svg
public/icons/fayanms/failover-test.svg
public/icons/fayanms/configuration-encrypted.svg
```

---

# Appendix C — Representative Existing Masters Sampled

Representative pre-v2 masters sampled during re-audit include:

```text
devices.svg
backups.svg
fayanms-mark.svg
```

Their sampled geometry is consistent with the intended 24×24 currentColor outline language.

This re-audit did not execute an XML parse over every icon master; that is precisely why strengthening the repository validator remains a finding.

---

# Appendix D — Current Repository Settings Observed

At audit time:

```text
repository visibility: public
default branch: main
main protected: no
active commit statuses: none
topics: []
homepage: null
license: null
active .github/workflows directory: absent
CODEOWNERS: present
```

`homepage: null` is currently aligned with the brand playbook because no real public product/docs URL has been declared.

`license: null` should remain honestly unbadged until the project owner chooses a license.

---

# Appendix E — Audit Evidence Paths

Primary paths reviewed:

```text
README.md
package.json
.github/CODEOWNERS
docs/ci/ci-gate.yml
docs/brand/BRAND-GUIDELINES.md
docs/brand/ICONOGRAPHY.md
docs/brand/ICON-CATALOG.md
docs/brand/ASSET-MANIFEST.md
docs/brand/SOCIAL-REPOSITORY.md
docs/brand/VENDOR-GLYPHS.md
docs/brand/ACCESSIBILITY.md
docs/adr/ADR-brand-icon-architecture.md

src/lib/brand/identity.ts
src/lib/brand/types.ts
src/app/layout.tsx
src/app/manifest.ts
src/app/icon.svg
src/app/apple-icon.tsx
src/app/opengraph-image.tsx
src/app/twitter-image.tsx

src/components/brand/fayanms-mark.tsx
src/components/brand/fayanms-wordmark.tsx
src/components/brand/fayanms-lockup.tsx
src/components/brand/fayanms-product-badge.tsx

src/components/icons/fayanms-icon.tsx
src/components/icons/domain-icon.tsx
src/components/icons/device-vendor-icon.tsx
src/components/icons/network-device-icon.tsx

src/lib/icons/types.ts
src/lib/icons/navigation-icons.ts
src/lib/icons/vendor-icons.ts
src/lib/icons/device-icons.ts
src/lib/navigation/sidebar-config.ts

src/components/shell/app-shell.tsx
src/components/shell/app-sidebar.tsx
src/components/shell/sidebar-nav.tsx
src/components/auth/sign-in-gate.tsx

src/components/views/devices-view.tsx
src/components/views/device-detail-view.tsx
src/components/views/admin-drivers-view.tsx
src/components/domain/status-icon.tsx

scripts/validate-brand-assets.ts
scripts/validate-icon-registry.ts
scripts/generate-brand-raster-assets.ts

public/logo.svg
public/brand/*
public/icons/fayanms/*
```

---

# Appendix F — Suggested Commit Series

Keep remediation reviewable.

```text
fix(brand): remove remaining Waypoints identity surfaces
refactor(brand): make lockup the only app identity composition
refactor(brand): centralize mark geometry and social artwork
fix(brand): align OG/Twitter composition with no-gradient policy
feat(brand): add favicon micro-mark
fix(icons): centralize device role metadata
fix(a11y): improve standalone custom icon semantics
test(brand): enforce exact SVG and catalog contracts
test(brand): add shell brand regression coverage
ci: activate required brand validation workflow
chore(github): protect brand assets with CODEOWNERS
docs(brand): reconcile enforcement claims and canonical paths
chore(repo): align package and GitHub metadata
```

---

# Appendix G — Final Release Checklist

Before closing the re-audit:

```text
Brand identity
[ ] app loading canonical
[ ] sign-in canonical
[ ] desktop sidebar canonical
[ ] collapsed sidebar canonical
[ ] mobile drawer canonical
[ ] no unrelated mark
[ ] no duplicate brand composition

Metadata
[ ] icon.svg verified
[ ] ICO verified 16/32/48
[ ] Apple 180 verified
[ ] PWA 192 verified
[ ] PWA 512 verified
[ ] maskable safe zone verified
[ ] OG 1200×630 verified
[ ] Twitter 1200×630 verified
[ ] GitHub 1280×640 verified
[ ] production metadata URL verified

Icon registry
[ ] exact disk/type/catalog parity
[ ] navigation parity
[ ] adapter/vendor parity
[ ] device-role parity
[ ] no broken paths
[ ] exact SVG geometry

Accessibility
[ ] decorative semantics
[ ] icon-only controls named
[ ] meaningful standalone icons named
[ ] status not color-only
[ ] RTL brand invariant
[ ] reduced motion unaffected

Repository
[ ] topics
[ ] About
[ ] social preview
[ ] workflow
[ ] branch protection
[ ] required checks
[ ] CODEOWNERS

QA
[ ] light
[ ] dark
[ ] LTR
[ ] RTL
[ ] 375
[ ] 768
[ ] 1024
[ ] 1280
[ ] 1440
[ ] 1920
[ ] 80% zoom
[ ] 100%
[ ] 125%
[ ] 150%
[ ] 200%
```

---

**End of FayaNMS Brand & Iconography Full Re-Audit — 2026-09-10**
