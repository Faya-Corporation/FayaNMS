# RT-010 — Bounded response accumulation in the WebAPI transport (device-facing DoS)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-011 | A2-01 | P2 | S | Low — adds a cap with a typed error; legitimate SFOS configs are far below the cap |

## Problem & evidence

`mini-services/worker/webapi-transport.ts:130-138` (inside `postJson`, the response handler):
```ts
const chunks: Buffer[] = [];
res.on("data", (chunk: Buffer) => chunks.push(chunk));
res.on("end", () => { ... body: Buffer.concat(chunks).toString("utf8") ... });
```
No byte cap. Contrast: the SSH plane bounds every stream via `appendBounded` at a 1 MiB default (`mini-services/worker/ssh-transport.ts:339-361, 368-375`). The WebAPI plane is the only transport where a hostile/compromised "device" answering `GetConfig` with an unbounded/streamed body can balloon worker memory (OOM).

## Impact

Device-facing memory-exhaustion vector on the one transport without an output budget; everything else in the worker is bounded.

## Root cause

The SFOS transport predates/omits the shared bounded-accumulator discipline applied to SSH.

## Required change

1. **`mini-services/worker/webapi-transport.ts`**:
   - Add a constant `const WEBAPI_MAX_RESPONSE_BYTES = 4 * 1_048_576; // 4 MiB — GetConfig responses are config text; observed SFOS output stays well under 1 MiB` (module scope, near `DEFAULT_TIMEOUT_MS`).
   - Add a new `WebApiError` code to the union (line 45-52): `"WEBAPI_RESPONSE_TOO_LARGE"`.
   - In the response handler: accumulate with a running byte count; on a chunk that crosses the cap, `req.destroy(new WebApiError("WEBAPI_RESPONSE_TOO_LARGE", \`WebAPI response exceeded ${WEBAPI_MAX_RESPONSE_BYTES} bytes\`))` (aborting the response stream is the suggested-fix behavior — do not merely truncate, the JSON envelope would be silently corrupt) and reject. Cleanest shape: keep a `let bytes = 0` next to `chunks`, check inside `res.on("data", ...)`, and reference `req` from the closure (it is in scope).
   - Surface the typed error through the existing error mapping in `req.on("error", ...)` (WebApiError instances already re-thrown as-is, line 145-149) — no extra mapping needed.
2. Optional (recommended, small): export the constant so the harness/tests can reference it; keep it out of any public contract doc unless the runbook lists transport budgets.

## Tests to add

File: `tests/audit/rt010-webapi-bounded-response.test.ts` (style of `tests/audit/sfos-webapi.test.ts`, which already exercises this module against the local harness).

1. `oversized response aborts with WEBAPI_RESPONSE_TOO_LARGE` — point the transport at a local TLS server (harness pattern) that streams > 4 MiB → the promise rejects with `code === "WEBAPI_RESPONSE_TOO_LARGE"` and the connection is destroyed; worker memory stays bounded (assert via the rejection, not RSS).
2. `legitimate GetConfig under the cap still parses` — normal-size envelope → `webApiFetchConfigText` returns config text unchanged (no regression).
3. `cap is chunk-boundary independent` — server sends many small chunks totaling > cap (drip pattern) → still aborts (guards an implementation that only checks per-chunk size).
4. `typed error carries no response body excerpt` — negative/log-hygiene assertion: the error message contains no device data (message includes only the byte count).

## Acceptance criteria

- [ ] No unbounded `chunks.push` path remains in `webapi-transport.ts`; the response stream is destroyed past 4 MiB with a typed error.
- [ ] Existing SFOS happy paths (probe + config) unchanged (`tests/audit/sfos-webapi.test.ts` stays green).
- [ ] Error code joins the `WebApiError` union (typecheck enforces exhaustiveness where handled).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt010-webapi-bounded-response.test.ts   # new suite green
bun test tests/audit/sfos-webapi.test.ts                      # transport regression suite green
bun test tests/                                               # no regressions
node_modules/typescript/bin/tsc --noEmit                      # exit 0
bun run lint                                                  # 0 errors
```

## Rollout & rollback notes

Single-module worker change; worker images are rebuilt independently (`Dockerfile.worker`). Rollback = revert the file. If a real SFOS device ever exceeds 4 MiB of config text (not observed; SFOS configs are tens–hundreds of KiB), the typed failure surfaces in the job with a clear code — raise the constant in the same file.
