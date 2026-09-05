/**
 * FayaNMS — Line diff engine (Task 3-b).
 *
 * Pure functions, zero dependencies (no diff/jsdiff — implemented in-house
 * per the no-new-packages constraint). Algorithm: common prefix/suffix trim
 * followed by a classic LCS dynamic-programming pass on the remaining
 * middle (Int32 table); adjacent removed+added runs are then paired into
 * "changed" rows when their token overlap is >= 60%, so the split view can
 * show side-by-side modified lines like a code-review tool.
 */

export type DiffRowType = "equal" | "added" | "removed" | "changed";

export interface DiffRow {
  type: DiffRowType;
  /** 1-based line number in the FROM text (removed/changed/equal rows). */
  aLine?: number;
  /** 1-based line number in the TO text (added/changed/equal rows). */
  bLine?: number;
  aText?: string;
  bText?: string;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/** Token-overlap threshold for pairing a removal+addition into a "changed" row. */
const PAIR_SIMILARITY_THRESHOLD = 0.6;

/** Middle-region cell budget for the LCS table (guards pathological inputs). */
const LCS_CELL_CAP = 1_500_000;

type Op =
  | { type: "equal"; aIndex: number; bIndex: number }
  | { type: "removed"; aIndex: number }
  | { type: "added"; bIndex: number };

/**
 * Token-level overlap between two lines: |shared tokens| / min(|A|, |B|).
 * Tokens are lowercase alphanumeric runs; multiset semantics (duplicates
 * count). Returns 1 for two empty lines, 0 when either side is empty.
 */
export function tokenOverlap(x: string, y: string): number {
  const tokenize = (line: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const token of line.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  };

  const a = tokenize(x);
  const b = tokenize(y);
  if (a.size === 0 && b.size === 0) return 1;

  let aTotal = 0;
  for (const count of a.values()) aTotal += count;
  let bTotal = 0;
  for (const count of b.values()) bTotal += count;
  const smaller = Math.min(aTotal, bTotal);
  if (smaller === 0) return 0;

  let shared = 0;
  for (const [token, count] of a) {
    const other = b.get(token);
    if (other) shared += Math.min(count, other);
  }
  return shared / smaller;
}

/** LCS operation list for the (already prefix/suffix-trimmed) middle region. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, bIndex) => ({ type: "added", bIndex }));
  if (m === 0) return a.map((_, aIndex) => ({ type: "removed", aIndex }));

  // Guard: beyond the cell budget fall back to a full block replace — the
  // pairing pass still converts similar lines into "changed" rows.
  if (n * m > LCS_CELL_CAP) {
    return [
      ...a.map((_, aIndex) => ({ type: "removed" as const, aIndex })),
      ...b.map((_, bIndex) => ({ type: "added" as const, bIndex })),
    ];
  }

  // dp[i * (m + 1) + j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: "removed", aIndex: i });
      i += 1;
    } else {
      ops.push({ type: "added", bIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "removed", aIndex: i });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "added", bIndex: j });
    j += 1;
  }
  return ops;
}

/**
 * Diff two line arrays into render rows. Equal lines carry both a/b
 * numbers and texts; a removed line immediately followed (in diff order)
 * by a similar addition (>= 60% token overlap) is emitted as a single
 * "changed" row so split view aligns the two variants side by side.
 */
export function diffLines(a: string[], b: string[]): DiffRow[] {
  // 1. Trim the common prefix/suffix — real config edits are local, so the
  //    LCS middle usually shrinks to a handful of lines.
  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const rows: DiffRow[] = [];

  const pushEqual = (index: number) => {
    rows.push({
      type: "equal",
      aLine: index + 1,
      bLine: index + 1,
      aText: a[index],
      bText: b[index],
    });
  };
  for (let i = 0; i < start; i += 1) pushEqual(i);

  // 2. LCS ops over the middle, then 3. pair adjacent removals/additions.
  const ops = lcsOps(a.slice(start, endA), b.slice(start, endB));

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === "equal") {
      rows.push({
        type: "equal",
        aLine: start + op.aIndex + 1,
        bLine: start + op.bIndex + 1,
        aText: a[start + op.aIndex],
        bText: b[start + op.bIndex],
      });
      k += 1;
      continue;
    }

    // Collect one diff region (mixed removals/additions until next equal).
    const removed: number[] = [];
    const added: number[] = [];
    while (k < ops.length) {
      const regionOp = ops[k];
      if (regionOp.type === "equal") break;
      if (regionOp.type === "removed") removed.push(regionOp.aIndex);
      else added.push(regionOp.bIndex);
      k += 1;
    }

    const pairCount = Math.min(removed.length, added.length);
    for (let p = 0; p < pairCount; p += 1) {
      const aText = a[start + removed[p]];
      const bText = b[start + added[p]];
      if (tokenOverlap(aText, bText) >= PAIR_SIMILARITY_THRESHOLD) {
        rows.push({
          type: "changed",
          aLine: start + removed[p] + 1,
          bLine: start + added[p] + 1,
          aText,
          bText,
        });
      } else {
        rows.push({
          type: "removed",
          aLine: start + removed[p] + 1,
          aText,
        });
        rows.push({
          type: "added",
          bLine: start + added[p] + 1,
          bText,
        });
      }
    }
    for (let r = pairCount; r < removed.length; r += 1) {
      rows.push({ type: "removed", aLine: start + removed[r] + 1, aText: a[start + removed[r]] });
    }
    for (let q = pairCount; q < added.length; q += 1) {
      rows.push({ type: "added", bLine: start + added[q] + 1, bText: b[start + added[q]] });
    }
  }

  for (let i = endA; i < a.length; i += 1) pushEqual(i);

  return rows;
}

/** Tally a row list into the four counters used by the stats chips. */
export function diffStats(rows: DiffRow[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const row of rows) {
    if (row.type === "added") stats.added += 1;
    else if (row.type === "removed") stats.removed += 1;
    else if (row.type === "changed") stats.changed += 1;
    else stats.unchanged += 1;
  }
  return stats;
}
