# FayaNMS — R60: R52 Re-audit INFO Polish Zeroed Out — 2026-09-18

Branch `z_ai_v2` · follow-up to the R52 full end-to-end production re-audit
(PASS, zero P1/P2) and the R58/R59 program close-out.

## 1. Why

The R52 re-audit closed with **four INFO notes labeled "optional polish"**:

1. `ci.yml` service-container postgres is tag-pinned (CI-only, ephemeral);
2. `.gitignore:29` CERT-006 comment path imprecision;
3. README "Bun ≥ 1.1" loose floor vs CI 1.3.14;
4. no dependabot/renovate — codified as roadmap item HC-5.

Note 4 closed in R57 (HC-5). This round closes 1–3 — **the INFO list is now
EMPTY**, leaving the audit trail with literally zero open notes of any
severity.

## 2. What changed (no app code touched)

| # | File | Change |
|---|---|---|
| 1 | `.github/workflows/ci.yml` | all THREE `postgres:16-alpine` service containers digest-pinned with the **existing SUPPLY-001-A registry resolution** (`sha256:cf78e766…20685` — the same byte-strict digest `compose.yml` already pins; no new resolution introduced, one image one truth). Inline comment records the rationale. CI-only and ephemeral, but no longer a mutable tag-pinned base input. |
| 2 | `.gitignore` | CERT-006 exemption comment now references the FULL unambiguous path `mini-services/worker/harness/tls/README.md` (was the ambiguous bare `harness/tls/README.md`), which exists on disk. |
| 3 | `README.md` | Bun floor raised **≥ 1.1 → ≥ 1.3.14** (badge label + alt text + prerequisites line) with the rationale: the floor is the version CI and the digest-pinned `oven/bun:1.3.14` runtime images actually validate; older Bun is untested/unsupported. |

## 3. Test pins — `tests/audit/r60-reaudit-info-polish.test.ts` (4 pins)

| # | Pin |
|---|---|
| 1 | EVERY `image:` line in ci.yml carries an `@sha256` digest; all three postgres containers byte-equal the SUPPLY-001-A digest; `compose.yml` pins the identical digest (one image, one truth) |
| 2 | .gitignore CERT-006 comment carries the full explicit path AND that README exists on disk; the ambiguous bare path is gone |
| 3 | README documents the 1.3.14 floor (badge URL, alt text, prerequisites + rationale); no stale `≥ 1.1` Bun claim remains anywhere; floor byte-equals the digest-pinned `oven/bun:1.3.14` runtime |
| 4 | The full four-note list reads as closed: HC-5 dependabot config still present + pins 1–3 |

## 4. Gates (CI env shape)

| Gate | Result |
|---|---|
| `bun run lint` | clean |
| `bunx tsc --noEmit` | exit 0 |
| `bun test tests/` | **943 → 947 pass / 18 skip / 0 fail** (8,017 expects, 57 files) |

`ci.yml` additionally parsed locally as a one-off (PyYAML): valid; all three
service images resolve to the digest-pinned reference.

## 5. LIVE verification

App root 200 · `/api/v1/meta` 200. Config/docs-only round — no UI surface
changed, no browser journey claims beyond health.

## 6. Honest scope

- GitHub Actions still does not execute here (runner-blocked, OWNER-CI-001);
  the ci.yml edit is structurally pinned + locally parsed; execution proof
  lands with HC-6 on real runners.
- The digest reuse is deliberate: pinning a SECOND resolution of the same
  image:tag would create two "truths" — the repo's established byte-strict
  pin (resolved 2026-09-15, re-resolution procedure documented inline) is
  authoritative.
