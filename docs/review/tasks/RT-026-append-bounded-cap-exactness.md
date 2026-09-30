# RT-026 — appendBounded: exact cap enforcement (append only the remaining bytes)

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-042 | A2-10 | P3 | S | Low — pure-function fix with existing unit-pinned tests to extend |

## Problem & evidence

`mini-services/worker/ssh-transport.ts:339-361` — `appendBounded`:
```ts
// This chunk crosses the budget: take the whole chunk, drop the rest.
return {
  text: current.text + chunk.toString(),
  bytes: current.bytes + chunkBytes,
  truncated: true,
};
```
The crossing chunk is taken WHOLE, so `text` overshoots `maxBytes` by up to one ssh2 chunk (documented comment even admits it). The declared per-stream output budget is soft: the detection plane re-bounds via `ANALYSIS_MAX_BYTES`, but the config plane stores the overshoot.

## Impact

Output budget overshoot up to one chunk (~32 KiB typical ssh2 window); declared invariants ("1 MiB cap") are approximate.

## Root cause

Chunk-granularity shortcut in the accumulator (the comment says "no partial re-slicing" — the fix is a bounded slice, which is cheap).

## Required change

`mini-services/worker/ssh-transport.ts`, `appendBounded` (lines 344-360): in the crossing branch, append ONLY the remaining budget and drop the tail:
```ts
const remaining = maxBytes - current.bytes;
const sliced = typeof chunk === "string"
  ? Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8")
  : chunk.subarray(0, remaining).toString("utf8");
return { text: current.text + sliced, bytes: maxBytes, truncated: true };
```
Notes:
- Byte-accurate UTF-8 slicing: `Buffer.subarray` can split a multi-byte sequence at the boundary; the trailing replacement char (\uFFFD) is acceptable at a truncation boundary (the stream is `truncated: true` anyway) — state this in a comment so nobody "fixes" it into an unbounded decoder loop.
- Update the function's doc comment (lines 333-338): "past the budget the chunk is sliced to the exact remaining budget and the tail is dropped; truncation is reported."

## Tests to add

File: `tests/audit/rt026-append-bounded-exact.test.ts` (pure unit tests — the function is already unit-pinned per its doc comment; find the existing pin with `rg -n "appendBounded" tests/` and extend that file or add this one importing the helper).

1. `exact cap: text never exceeds maxBytes` — accumulate chunks crossing the budget (varying chunk sizes incl. 1-byte and >budget chunks) → `bytes === maxBytes` and `Buffer.byteLength(text) <= maxBytes` for every step.
2. `crossing chunk is sliced to remaining` — current.bytes = max-5, chunk of 100 bytes → text grows by exactly 5 bytes' worth, `truncated === true`.
3. `sub-budget chunks unchanged` — non-crossing appends behave exactly as before (regression on the happy path).
4. `already-at-cap appends are no-ops` — `bytes >= maxBytes` → unchanged, `truncated: true`.
5. `utf-8 boundary yields valid string` — multi-byte chunk sliced at a code-point boundary → `text` is valid UTF-8 (no thrown decode) and may end with U+FFFD (documented).

## Acceptance criteria

- [ ] `appendBounded` enforces `bytes <= maxBytes` exactly; overshoot impossible.
- [ ] `truncated` flag semantics unchanged; callers (`sshExecText` lines 395-408, and any other `rg -n "appendBounded" mini-services/`) unchanged.
- [ ] Existing ssh-transport suites stay green.
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/rt026-append-bounded-exact.test.ts   # new suite green
bun test tests/audit/ssh-hostkey-guard.test.ts tests/audit/r50-detection-contract.test.ts   # ssh-plane peers green
bun test tests/                                            # no regressions
node_modules/typescript/bin/tsc --noEmit                   # exit 0
bun run lint                                               # 0 errors
```

## Rollout & rollback notes

One pure function; revert-safe. Detection-plane behavior unchanged (ANALYSIS_MAX_BYTES still re-bounds). Note: the SESSION driver's ring-buffer desync issue (A2-09/F-041) is a DIFFERENT defect and stays deferred — do not conflate in review.


## Status

Fixed (dbb7e0a)
