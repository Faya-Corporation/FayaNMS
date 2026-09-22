# Repository Guidelines

## Project Structure & Module Organization

FayaNMS is a Next.js 16 + TypeScript application using Bun, PostgreSQL, and Prisma. Routes and UI live under `src/app/` and `src/components/`; shared logic is in `src/lib/`, API hooks in `src/hooks/api/`, and client state in `src/stores/`. The Bun worker is in `mini-services/worker/`. Schema, seeds, and migrations are in `prisma/`. Tests are grouped under `tests/` by concern (`audit`, `auth`, `brand`, `browser`, `e2e`, etc.); fixtures are in `tests/fixtures/`. Localization files are `messages/en.json` and `messages/ar.json`. Deployment, monitoring, scripts, and operator docs live in `deploy/`, `monitoring/`, `scripts/`, and `docs/`.

## Build, Test, and Development Commands

Use Bun 1.3.14 or newer and install both lockfiles before development:

```bash
bun install --frozen-lockfile
(cd mini-services/worker && bun install --frozen-lockfile)
bun run db:deploy                 # apply committed Prisma migrations
bun run dev                       # app on port 3000
(cd mini-services/worker && bun run dev)  # worker on port 3030
```

Run `bun run lint`, `bunx tsc --noEmit`, and `bun run build:gate` for linting, type checking, and production builds. The standard suite is `bun test tests/`; release journeys use `FAYANMS_E2E=1 bun test tests/e2e/`, and Chromium journeys use `bunx playwright install --with-deps chromium` followed by `FAYANMS_BROWSER_E2E=1 bun test tests/browser/`.

## Coding Style & Naming Conventions

Follow the existing TypeScript/React style and ESLint configuration: two-space indentation, semicolons, and single-purpose modules. Name React components and types in PascalCase, functions and variables in camelCase, and test files as `*.test.ts` or `*.test.tsx`. Preserve English/Arabic translation-key parity and use established domain folders.

## Testing Guidelines

Add focused tests beside the relevant concern under `tests/`; security, authorization, audit, migration, and worker changes should include regression coverage. Keep tests deterministic and use the repository PostgreSQL setup. Browser-facing changes should include a browser journey or accessibility assertion where appropriate.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects such as `feat(discovery): ...`, `fix(telemetry): ...`, `docs(progress): ...`, or `test(auth): ...`. Keep commits focused. PRs should explain behavior and risk, link an issue or audit item, list verification commands, and include screenshots for UI changes. Expect CI gate, E2E, browser, scan, and container/ARM64 checks to pass; call out migration, configuration, or security changes.

## Security & Configuration Tips

Copy `.env.example` and generate local secrets; never commit credentials or production `.env` files. Use `prisma migrate deploy` for committed schema changes; reserve `db:push:force` for intentional disposable resets. Review `docs/security/`, deployment runbooks, and relevant audit tests when changing auth, secrets, network access, or live-device behavior.
