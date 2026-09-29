# RT-029 — Caddy access logs: stdout (docker-owned retention) instead of container-local file

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-058 | A5-06 | P3 | S | Low — logging config only; the audit flags the current path as likely crash-looping on first boot (Unverified) |

## Problem & evidence

`deploy/oci/Caddyfile:16-19` + `deploy/oci/compose.yml:147-150`:
```
log {
  output file /var/log/caddy/fayanms-access.log
  format json
}
```
- No `/var/log/caddy` mount exists in the caddy service (volumes: Caddyfile, caddy-data, caddy-config only).
- The official `caddy:2-alpine` image does not ship `/var/log/caddy`, so the file writer likely errors at provision on first staging boot → crash-loop → the deploy health gate fails (audit confidence: Unverified — the mechanism is documented Caddy behavior, the boot outcome wasn't reproduced).
- Even if the dir existed, logs land in container-local FS: lost on recreation.

## Impact

Broken/ephemeral access logs; potential caddy crash-loop blocking the deploy gate.

## Root cause

File-output logging configured without the matching volume/dir; docker json-file driver (already configured with rotation in compose, lines 161-165) is the intended log owner.

## Required change

1. **`deploy/oci/Caddyfile`** lines 16-19: replace the file output with stdout JSON:
   ```
   log {
     output stdout
     format json
   }
   ```
   (Docker's json-file driver — `max-size: 10m`, `max-file: 5`, compose.yml:161-165 — owns retention.)
2. No compose volume changes needed (the `/var/log/caddy` mount alternative is explicitly NOT chosen — stdout is simpler and container-recreation-safe).
3. Runbook touch: if `docs/runbooks/observability.md` or `deployment.md` mentions the access-log file path, update the one line to "docker logs fayanms-staging-caddy-1 (json-file rotation)" (`rg -n "fayanms-access" docs/ deploy/`).

## Tests to add

File: `tests/audit/rt029-caddy-log-stdout.test.ts` (config police, style of `tests/audit/monitoring-compose.test.ts`).

1. `caddy logs to stdout` — parse `deploy/oci/Caddyfile`: `output stdout` present; no `output file /var/log/...` remains.
2. `no orphaned log volume/dir` — negative case: no `/var/log/caddy` reference anywhere in `deploy/oci/` (compose volumes stay minimal).
3. `json format preserved` — `format json` retained (structured logs for the runbook's query examples).
4. `docker log rotation still configured` — compose caddy service keeps its json-file max-size/max-file options (retention ownership assertion).

## Acceptance criteria

- [ ] Access logs go to stdout as JSON; retention owned by the docker json-file driver.
- [ ] No reference to an unmounted log path remains.
- [ ] Runbook references updated if they existed.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt029-caddy-log-stdout.test.ts   # new suite green
bun test tests/audit/deploy-hardening.test.ts          # deploy peers green
bun test tests/                                        # no regressions
node_modules/typescript/bin/tsc --noEmit               # exit 0
bun run lint                                           # 0 errors
# Staging smoke after deploy: docker compose logs caddy | head   → JSON access lines
```

## Rollout & rollback notes

Config-only; if an operator preferred file logs, the alternative (mount a dedicated dir) is a two-line revert+volume. Rollback = restore the file block (and add the missing volume this time).
