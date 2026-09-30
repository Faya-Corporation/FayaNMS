# Dependency Report — FayaNMS (branch `GLM/full-audit-and-fix`)

Ran from `/home/z/faya-nms` on 2026-09-29 (sandbox, bun 1.3.14). Lockfiles: root `bun.lock` (680 packages installed; `bun install --frozen-lockfile` verified clean in BASELINE.md) and `mini-services/worker/bun.lock` (2 runtime/dev deps).

## 1. Vulnerability / advisory scan

**Command (1): `bun pm audit 2>&1 | head -40`** — `bun pm audit` is **not a supported subcommand** in bun 1.3.14. Exact output (trimmed): bun printed the generic `bun pm` help text listing available subcommands (`scan`, `pack`, `bin`, `list`, `why`, `whoami`, `view`, `version`, `pkg`, `hash`, `cache`, `migrate`, `untrusted`, `trust`, `default-trusted`) — there is no `audit` entry (the native replacement is `bun pm scan`). Exit after pipe: 0 (usage text, not an audit result).

**Availability probe: `bunx --yes npm-audit-html --help 2>&1 | head -3`** — **timed out and was killed after 90 s** with no output (sandbox has no reliable registry egress for ad-hoc package fetches). Tool availability could not be established; nothing was installed into the repo.

**Fallback: `npm audit --json 2>&1 | head -20`** — fails; repo has no npm lockfile. Exact output:

```
npm error code ENOLOCK
npm error audit This command requires an existing lockfile.
npm error audit Try creating one first with: npm i --package-lock-only
npm error audit Original error: loadVirtual requires existing shrinkwrap file
{
  "error": { "code": "ENOLOCK", "summary": "This command requires an existing lockfile.", ... }
}
```

**Bonus probe: `bun pm scan 2>&1`** (the bun-native scanner suggested by the help text) — also unavailable as configured. Exact output:

```
To use 'bun pm scan', configure a security scanner in bunfig.toml:
  [install.security]
  scanner = "package_name"
Security scanners can be npm packages that export a scanner object.
error: no security scanner configured
```

**Advisory verdict:** **no vulnerability advisories could be confirmed or ruled out in-sandbox.** The project's standing advisory controls are in CI, not the sandbox: `osv-scanner` and Trivy (HIGH/CRITICAL gate) with sha256-verified binaries and `--redact`, plus gitleaks — all green at base `38fbdfb` (run 36609478829; see BASELINE.md / A5 notes). Those CI results are the best available advisory signal.

## 2. Currency scan

**Command (2): `bun outdated 2>&1 | head -40`** (repo root) — exact output (trimmed to the table):

```
bun outdated v1.3.14 (0d9b296a)
| Package                  | Current | Update  | Latest      |
|--------------------------|---------|---------|-------------|
| @prisma/client           | 6.19.3  | 6.19.3  | 7.10.0      |
| @tanstack/react-query    | 5.90.19 | 5.90.19 | 5.104.0     |
| framer-motion            | 12.26.2 | 12.26.2 | 13.4.6      |
| lucide-react             | 0.525.0 | 0.525.0 | 1.48.0      |
| next                     | 16.3.4  | 16.3.4  | 16.3.7      |
| next-intl                | 4.9.2   | 4.9.2   | 4.14.8      |
| prisma                   | 6.19.3  | 6.19.3  | 8.0.0-rc.19 |
| react                    | 19.2.3  | 19.2.3  | 19.3.0      |
| react-day-picker         | 9.14.0  | 9.14.0  | 10.0.1      |
| react-dom                | 19.2.3  | 19.2.3  | 19.3.0      |
| react-hook-form          | 7.87.0  | 7.89.0  | 7.89.0      |
| react-resizable-panels   | 3.0.6   | 3.0.6   | 4.14.1      |
| recharts                 | 2.15.4  | 2.15.4  | 3.10.1      |
| sharp                    | 0.35.4  | 0.35.5  | 0.35.5      |
| tailwind-merge           | 3.6.0   | 3.7.0   | 3.7.0       |
| zod                      | 4.6.2   | 4.6.5   | 4.6.5       |
| eslint (dev)             | 9.39.5  | 9.39.5  | 10.11.0     |
| eslint-config-next (dev) | 16.3.4  | 16.3.7  | 16.3.7      |
```

**Command (3): `cd mini-services/worker && bun outdated 2>&1 | head -20`** — exact output:

```
bun outdated v1.3.14 (0d9b296a)
| Package           | Current | Update | Latest |
|-------------------|---------|--------|--------|
| ssh2              | 1.16.0  | 1.16.0 | 1.17.0 |
| @types/ssh2 (dev) | 1.15.0  | 1.15.0 | 1.15.6 |
```

Reading: 18 root packages are behind `Latest`, but almost all gaps are **major-version jumps** (Prisma 6→7, framer-motion 12→13, recharts 2→3, react-day-picker 9→10, react-resizable-panels 3→4, eslint 9→10) that are upgrade projects, not patch debt. Within-range updates available now: `next` 16.3.4 → 16.3.7, `eslint-config-next` → 16.3.7, `sharp` → 0.35.5, `tailwind-merge` → 3.7.0, `zod` → 4.6.5, `react-hook-form` → 7.89.0; worker: `ssh2` 1.16.0 → 1.17.0, `@types/ssh2` → 1.15.6. None of these can be tied to a specific advisory from this sandbox (see §1).

## 3. Major dependencies & pinned versions (from package.json)

Runtime/stack: Bun 1.3.14 · Next.js 16 App Router · PostgreSQL (Prisma 6).

| Dependency | Declared (package.json) | Resolved current (bun.lock / bun outdated) | Notes |
|---|---|---|---|
| next | `16.3.4` (exact) | 16.3.4 | Update-available range: 16.3.7 |
| react / react-dom | `19.2.3` (exact) | 19.2.3 | |
| next-auth | `4.24.15` (exact) | 4.24.15 | v4 line; credentials + JWT strategy |
| next-intl | `4.9.2` (exact) | 4.9.2 | en/ar dictionaries (exact parity, 2850 keys) |
| prisma / @prisma/client | `^6.11.1` | 6.19.3 | Latest major is 7/8-rc — deliberate major lag |
| zod | `^4.0.2` | 4.6.2 | patch update available |
| @tanstack/react-query | `5.90.19` (exact) | 5.90.19 | |
| framer-motion | `12.26.2` (exact) | 12.26.2 | |
| recharts | `^2.15.4` | 2.15.4 | v3 is a major migration |
| tailwindcss (+postcss) | `^4` | 4.x | shadcn/ui New York set on Radix primitives |
| typescript (dev) | `^5` | 5.x (repo-pinned via node_modules) | |
| z-ai-web-dev-sdk | `^0.0.18` | 0.0.18.x | backend-only AI integration |
| playwright (dev) | `1.62.1` (exact) | 1.62.1 | browser/e2e journeys |
| axe-core (dev) | `4.13.0` (exact) | 4.13.0 | a11y checks |
| **worker:** ssh2 | `1.16.0` (exact) | 1.16.0 | only runtime dep of the Bun worker; 1.17.0 available |
| **worker:** @types/ssh2 (dev) | `1.15.0` (exact) | 1.15.0 | 1.15.6 available |

Additional supply-chain posture (from package.json + A5): root `overrides`/`resolutions` pin transitive deps (lodash 4.18.0, js-yaml 4.3.2, prismjs 1.30.0, brace-expansion, minimatch, picomatch, etc.); CI actions are SHA-pinned; container bases are digest-pinned and non-root (A5 clean list). Dependabot covers the two bun ecosystems but not github-actions (F-065).

## 4. Honest summary — what could and could not be determined

**Determined:** exact installed versions (bun.lock, frozen install verified clean); currency gaps per package for both workspaces (tables above); that the advisory tooling paths in this sandbox are all unavailable (`bun pm audit` unsupported, `bun pm scan` unconfigured, `bunx npm-audit-html` unreachable, `npm audit` ENOLOCK); and that CI's osv-scanner/Trivy HIGH/CRITICAL gates were green at base `38fbdfb`.

**Not determined:** whether any pinned/resolved version carries a known CVE (no advisory database was reachable from this sandbox); whether the in-range updates (next 16.3.7, ssh2 1.17.0, sharp 0.35.5, zod 4.6.5, …) are security-relevant; and GHCR image scan status post-base (container workflow is disabled at repo level by owner request, so scans only ran while it was enabled).

**Recommendation:** run `bun pm scan` with a configured scanner (or `osv-scanner`/`npm audit` against a generated lockfile) from a network-capable environment, and re-enable the container certification workflow to restore the image-level HIGH/CRITICAL gate; until then, treat CI runs at base as the only advisory evidence.

## 5. Post-audit round-trip — CI scan gate (2026-09-30, main agent)

The first PR run (#14, 36768543791) and its scan job re-ran on 2026-09-30 exposed
advisory drift that post-dates base `38fbdfb` (lockfiles were byte-identical to
base, so the branch did not introduce it — the advisories were published after
base's last green scan):

| Package | Was | Now | Advisories |
|---|---|---|---|
| next | 16.3.4 | **16.3.6** | GHSA-vcvr-r3jv-pc5j (Critical 9.5) |
| brace-expansion (v1 chain, 6 instances) | 1.1.18 (repo `resolutions` pin) | **1.1.21** | GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr |
| brace-expansion (v5 chain) | 5.0.9 | **5.0.12** | same three, v5 range |

Changes: `package.json` bumps the `next` dev-pinned version and refreshes the
repo's own `resolutions` pins (`brace-expansion@^1` → 1.1.21, new
`brace-expansion@^5` → 5.0.12); `@types/node` added to devDependencies pinned
at `22.20.2` (a full in-range regen let `bun-types@1.4.2`'s `*` range pull
@types/node 26, whose `KeyObject.export` typings break compile — the repo
targets the 22.x typings). `bun.lock` regenerated: all other moves are
in-range patch/minor refreshes (typescript-eslint 8.71, @swc/core 1.16.13,
zod 4.6.5, …).

**Verification:** `osv-scanner` v2.5.1 (CI's exact binary + checksum +
`osv-scanner.toml`) against both lockfiles: **No issues found**. tsc 0, lint 0,
`build:gate` 0, full suite unchanged on seeded and fresh-DB replicas (1627/19/2
R61-only). Worker lockfile untouched (was already clean).
