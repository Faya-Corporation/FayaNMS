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
#   * Runtime base is Bun's digest-pinned Debian 13 distroless image (NOT
#     alpine): the Prisma query engine and sharp prebuilt binaries are produced
#     in the glibc build stage and are incompatible with musl. Keep libc/openssl
#     consistent across stages while excluding the build-stage package manager
#     and utility surface from the shipped runtime.
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
# R76 (run 35422501995): next build type-checks the WHOLE repo per the root
# tsconfig (include: **/*.ts — the documented "src/ + worker zero-error
# policy"), so the worker's TS files must resolve ssh2/@types/ssh2 inside
# this build — exactly what ci.yml's "Install worker dependencies (frozen)"
# step provides to the gate/e2e/browser jobs. The BUILD stage installs them
# frozen; the runtime stage stays worker-free (it copies only the standalone
# output + prisma client/schema — see below), so the audited image is
# unchanged. Worker node_modules in the context are excluded by
# .dockerignore; this installs fresh from the committed lockfile instead.
COPY mini-services/worker/package.json mini-services/worker/bun.lock ./mini-services/worker/
RUN cd mini-services/worker && bun install --frozen-lockfile
COPY . .
# R77 (run 35423093770): under Bun 1.3.14 in this environment, `next build`
# COMPLETES SUCCESSFULLY (full route summary printed) and THEN Bun segfaults
# at process exit (its own teardown bug — bun.report/1.3.14/Bn10d9b296i2Fqk
# ogC4664tE+++Pw9jypDA2Agr+E; deterministic, after-the-fact). The build's
# SUCCESS is therefore verified by its ARTIFACTS, not by the crashing
# process's exit code: .next/BUILD_ID + .next/standalone must exist or the
# RUN fails — a genuinely failed build cannot produce them in this fresh
# stage, so the gate stays exactly as strong.
RUN bunx prisma generate \
 && bun run build; code=$?; \
    if [ ! -f .next/BUILD_ID ] || [ ! -d .next/standalone ]; then \
      echo "BUILD FAILED: no build artifacts (bun exit $code)" >&2; exit 1; \
    fi; \
    if [ "$code" -ne 0 ]; then \
      echo "NOTE: bun exited $code AFTER a successful build (known 1.3.14 teardown segfault, artifacts verified)" >&2; \
    fi

FROM oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Distroless runtime: no package manager, shell, or utility package surface.
# The build stage remains Debian/glibc-compatible for Prisma and sharp; the
# final stage carries only Bun, libc, CA roots, and the traced application.

COPY --from=build --chown=10001:10001 /app/.next/standalone ./
# Prisma client + query engine: explicit copy as a standalone-tracing safety
# net — boot fails fast without them, so prove presence on a clean machine,
# not just the build host (runbook T1 acceptance criteria).
COPY --from=build --chown=10001:10001 /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=10001:10001 /app/node_modules/@prisma  ./node_modules/@prisma
# Schema ships with the image so one-off provisioning (prisma db push against
# the PostgreSQL service) can run from the build stage via the compose
# `provision` service.
COPY --from=build --chown=10001:10001 /app/prisma ./prisma

USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "const r = await fetch('http://127.0.0.1:3000/'); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["server.js"]
