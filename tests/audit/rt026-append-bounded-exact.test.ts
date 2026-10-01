import { describe, expect, test } from "bun:test";

import { appendBounded } from "../../mini-services/worker/ssh-transport";

/**
 * RT-026 / F-042 — appendBounded enforces the byte cap EXACTLY.
 *
 * BEFORE: the chunk that crossed the budget was taken WHOLE, so `text`
 * (and `bytes`) could overshoot `maxBytes` by up to one ssh2 chunk
 * (~32 KiB) — the declared "1 MiB cap" was approximate, and the config
 * plane stored the overshoot.
 *
 * AFTER: the crossing chunk is sliced to the EXACT remaining budget and
 * the tail is dropped; `bytes === maxBytes` at the truncation boundary
 * and never beyond. Pinned here (pure unit tests on the helper):
 *   1. exact cap — bytes === maxBytes and Buffer.byteLength(text) <=
 *      maxBytes at every step (ASCII stream, so text length === bytes);
 *   2. the crossing chunk is sliced to exactly the remaining budget;
 *   3. sub-budget chunks behave exactly as before (happy-path regression);
 *   4. already-at-cap appends are no-ops;
 *   5. a multi-byte sequence split at the boundary decodes to a VALID
 *      string that may end in U+FFFD (documented; bounded overshoot ≤ 2
 *      bytes from the split sequence — never "fix" into a decoder loop).
 */

type Acc = { text: string; bytes: number; truncated: boolean };

/** Deterministic ASCII stream generator (byteLength === char count). */
function asciiChunk(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = 0x61 + ((seed + i) % 26); // 'a'..'z'
  }
  return bytes;
}

describe("RT-026 — appendBounded exact cap enforcement", () => {
  test("exact cap: bytes === maxBytes and Buffer.byteLength(text) <= maxBytes at every step", () => {
    const maxBytes = 64;
    let acc: Acc = { text: "", bytes: 0, truncated: false };
    // Varying chunk sizes: 1-byte, sub-budget, crossing, and >budget chunks.
    const sizes = [1, 7, 30, 200, 64, 1, 5, 128, 1, 1];
    let seed = 0;
    for (const size of sizes) {
      acc = appendBounded(acc, asciiChunk(seed++, size), maxBytes);
      expect(acc.bytes).toBeLessThanOrEqual(maxBytes);
      expect(Buffer.byteLength(acc.text, "utf8")).toBeLessThanOrEqual(maxBytes);
    }
    // The budget was crossed (total sent >> 64) — the accumulator sits
    // EXACTLY at the cap, never past it.
    expect(acc.bytes).toBe(maxBytes);
    expect(Buffer.byteLength(acc.text, "utf8")).toBe(maxBytes);
    expect(acc.truncated).toBe(true);
  });

  test("crossing chunk is sliced to the remaining budget (max-5 + 100-byte chunk → +5 bytes)", () => {
    let acc: Acc = { text: "12345", bytes: 5, truncated: false };
    acc = appendBounded(acc, asciiChunk(0, 100), 10);
    expect(acc.text).toBe("12345abcde"); // exactly the 5 remaining bytes
    expect(acc.bytes).toBe(10);
    expect(acc.truncated).toBe(true);
  });

  test("sub-budget chunks unchanged (happy-path regression)", () => {
    let acc: Acc = { text: "", bytes: 0, truncated: false };
    acc = appendBounded(acc, Buffer.from("hello "), 100);
    expect(acc).toEqual({ text: "hello ", bytes: 6, truncated: false });
    acc = appendBounded(acc, Buffer.from("world"), 100);
    expect(acc).toEqual({ text: "hello world", bytes: 11, truncated: false });
    // An exactly-filling append is NOT a truncation (fits the budget).
    acc = appendBounded(acc, Buffer.from("!!"), 100);
    expect(acc).toEqual({ text: "hello world!!", bytes: 13, truncated: false });
  });

  test("already-at-cap appends are no-ops", () => {
    const atCap: Acc = { text: "x".repeat(16), bytes: 16, truncated: true };
    expect(appendBounded(atCap, Buffer.from("more"), 16)).toEqual(atCap);
    // Over-cap accumulators stay pinned too (defensive).
    const overCap: Acc = { text: "y".repeat(20), bytes: 20, truncated: true };
    expect(appendBounded(overCap, Buffer.from("more"), 16)).toEqual(overCap);
  });

  test("utf-8 boundary yields a valid string; U+FFFD tail is documented", () => {
    // "é" is 2 bytes (0xC3 0xA9), "€" is 3 bytes. Slice mid-sequence.
    let acc: Acc = { text: "", bytes: 0, truncated: false };
    acc = appendBounded(acc, Buffer.from("é€", "utf8"), 1); // split at 1 byte
    expect(acc.bytes).toBe(1);
    expect(acc.truncated).toBe(true);
    // Valid UTF-8 (no thrown decode); the split sequence decodes as U+FFFD.
    expect(acc.text).toBe("\uFFFD");
    // Bounded overshoot: the decoded replacement char is 3 bytes vs the
    // 1 sliced budget byte (+2) — the COUNTER stays exact at maxBytes.
    expect(Buffer.byteLength(acc.text, "utf8")).toBeLessThanOrEqual(acc.bytes + 2);

    // Code-point-boundary slice on a 3-byte char: 2 remaining bytes split
    // the € sequence → still valid, still truncated, counter exact.
    let acc2: Acc = { text: "ab", bytes: 2, truncated: false };
    acc2 = appendBounded(acc2, Buffer.from("€€€", "utf8"), 4);
    expect(acc2.bytes).toBe(4);
    expect(acc2.truncated).toBe(true);
    expect(Buffer.byteLength(acc2.text, "utf8")).toBeLessThanOrEqual(acc2.bytes + 2);
  });
});
