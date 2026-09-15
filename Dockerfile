# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# FayaNMS app image — T1 of docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md.
# Multi-stage bun build → Next.js standalone runtime (next.config.ts
# output:"standalone").
#
# Deployment contract (do not weaken without updating the runbook):
#   * NEXT_PUBLIC_SITE_URL is a BUILD-TIME arg carrying the REAL canonical
#     origin. It is baked into the client bundle (metadataBase / OG absolutes)
#     and siteUrl() throws in production without it (B3-029). Never build with
#     a placeholder — it is a public hostname, not a secret.
#   * DATABASE_URL is NOT baked into the image: production persistence is
#     PostgreSQL (Phase 21 slice 1) and the URL is composed by compose.yml from
#     POSTGRES_PASSWORD (postgresql://fayanms:…@postgres:5432/fayanms). The
#     startup security policy aborts boot when DATABASE_URL is missing or not a
#     postgres URL — a misconfigured container can never serve traffic.
#   * Runtime is non-root with a PINNED uid (10001). With no local state
#     (Phase 21 moved persistence to PostgreSQL) the uid is defense-in-depth:
#     a compromised process cannot write outside tmp. The provision flow no
#     longer needs any chown handback.
#   * Runtime base is debian-slim (NOT alpine): the Prisma query engine and the
#     sharp prebuilt binaries are produced in the glibc build stage and are
#     incompatible with musl. Keep libc/openssl consistent across stages.
# ─────────────────────────────────────────────────────────────────────────────

# SUPPLY-001-A: base images are digest-pinned (immutable inputs). The tag
# stays for readability; the digest is authoritative. Bump procedure:
# resolve the new tag's digest from the registry (docker buildx imagetools
# inspect oven/bun:NEW_TAG | grep Digest), update here, commit, and let CI
# build + scan the new image.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM deps AS build
# Fail fast with a human message instead of a deep siteUrl()/next-build throw.
ARG NEXT_PUBLIC_SITE_URL
RUN test -n "$NEXT_PUBLIC_SITE_URL" || { \
      echo "BUILD FAILED: pass the REAL canonical origin as the NEXT_PUBLIC_SITE_URL build arg (e.g. http://fayanms.corp.example.com — localhost and *.local are rejected in production). See docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md §T1." >&2; \
      exit 1; }
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY . .
RUN bunx prisma generate \
 && bun run build

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root runtime user with a pinned uid (see header note).
RUN addgroup --system faya \
 && adduser --system --uid 10001 --ingroup faya faya

COPY --from=build --chown=faya:faya /app/.next/standalone ./
# Prisma client + query engine: explicit copy as a standalone-tracing safety
# net — boot fails fast without them, so prove presence on a clean machine,
# not just the build host (runbook T1 acceptance criteria).
COPY --from=build --chown=faya:faya /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=faya:faya /app/node_modules/@prisma  ./node_modules/@prisma
# Schema ships with the image so one-off provisioning (prisma db push against
# the PostgreSQL service) can run from the build stage via the compose
# `provision` service.
COPY --from=build --chown=faya:faya /app/prisma ./prisma

USER faya
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "server.js"]
