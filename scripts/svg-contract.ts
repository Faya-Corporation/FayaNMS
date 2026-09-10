/**
 * Shared SVG contract parsing for the FayaNMS brand validators.
 *
 * Used by BOTH `scripts/validate-brand-assets.ts` (`bun run brand:validate`)
 * and `scripts/validate-icon-registry.ts` (`bun run brand:validate-icons`);
 * each script remains independently runnable via its own bun command.
 *
 * The Tier-2 contract (re-audit §9.3, B1-008) is enforced on the ROOT <svg>
 * open tag only — parsed from the first `<svg…>` open tag, not hand-split —
 * and on a whole-file prohibited-content scan. Nothing here weakens the
 * documented contract: attributes must appear verbatim (exact value strings,
 * double-quoted), so e.g. `viewBox='0 0 24 24'` or `viewBox="0 0 24  24"`
 * fail.
 */

/** The EXACT root-attribute contract every Tier-2 icon master must declare. */
export const TIER2_ROOT_CONTRACT: ReadonlyArray<readonly [string, string]> = [
  ["viewBox", "0 0 24 24"],
  ["fill", "none"],
  ["stroke", "currentColor"],
  ["stroke-width", "2"],
  ["stroke-linecap", "round"],
  ["stroke-linejoin", "round"],
];

/** Tier-1 (brand master) prohibited content — B1-008/§9.2. */
const TIER1_PROHIBITED: ReadonlyArray<readonly [RegExp, string]> = [
  [/<script\b/i, "<script>"],
  [/<animate\b/i, "SVG animation (<animate…>)"],
  [/<filter\b/i, "<filter>"],
  [/<style\b/i, "<style>"],
  [/<foreignObject\b/i, "<foreignObject>"],
  [/xlink:href/i, "xlink:href reference"],
  [/\shref\s*=\s*["']https?:/i, "external href (http/https)"],
  [/<image\b[^>]*\s(?:xlink:)?href\s*=\s*["']https?:/i, "<image> with remote src"],
];

/**
 * Tier-2 (runtime icon) prohibited content — the whole file is scanned,
 * gradients/filters/styles/scripts/animation/external references all fail.
 * Pattern list per re-audit §9.3 / task spec (href catch covers both quote
 * styles — strictly stronger than the written `href="http`).
 */
const TIER2_PROHIBITED: ReadonlyArray<readonly [RegExp, string]> = [
  [/<linearGradient\b/i, "<linearGradient>"],
  [/<radialGradient\b/i, "<radialGradient>"],
  [/<filter\b/i, "<filter>"],
  [/<style\b/i, "<style>"],
  [/<script\b/i, "<script>"],
  [/<animate\b/i, "SVG animation (<animate…>)"],
  [/<foreignObject\b/i, "<foreignObject>"],
  [/\shref\s*=\s*["']https?:/i, "external href (http/https)"],
  [/xlink:href/i, "xlink:href reference"],
];

export interface SvgContractViolation {
  check: string;
  detail: string;
}

/** First `<svg…>` open tag of the document (root element only), or null. */
export function parseSvgRootTag(source: string): string | null {
  return source.match(/<svg[^>]*>/)?.[0] ?? null;
}

function scanProhibited(
  source: string,
  rules: ReadonlyArray<readonly [RegExp, string]>
): SvgContractViolation[] {
  const out: SvgContractViolation[] = [];
  for (const [pattern, label] of rules) {
    if (pattern.test(source)) out.push({ check: "prohibited", detail: label });
  }
  return out;
}

/**
 * Brand-master (Tier-1) sanity: valid root open tag + prohibited-content
 * scan. `<text>` is ALLOWED (regenerable wordmark/lockup masters are
 * text-based by policy — docs/brand/ASSET-MANIFEST.md).
 */
export function checkBrandMasterSvg(
  fileName: string,
  source: string
): SvgContractViolation[] {
  const out: SvgContractViolation[] = [];
  const root = parseSvgRootTag(source);
  if (!root) {
    out.push({ check: "root", detail: "no <svg> root open tag found" });
  } else if (!/xmlns\s*=\s*"http:\/\/www\.w3\.org\/2000\/svg"/.test(root)) {
    out.push({ check: "root", detail: "root lacks the SVG namespace declaration" });
  }
  out.push(...scanProhibited(source, TIER1_PROHIBITED));
  return out.map((v) => ({ ...v, detail: `${fileName}: ${v.detail}` }));
}

/**
 * Tier-2 icon contract (re-audit §9.3) for one runtime icon master:
 * exact root attributes, prohibited content anywhere, and no hardcoded
 * palette colors (every fill/stroke attribute must be "none" or
 * "currentColor"). Returns one violation object per problem.
 */
export function checkTier2IconContract(
  fileName: string,
  source: string
): SvgContractViolation[] {
  const out: SvgContractViolation[] = [];

  const root = parseSvgRootTag(source);
  if (!root) {
    out.push({ check: "root", detail: `${fileName}: no <svg> root open tag found` });
  } else {
    for (const [attr, expected] of TIER2_ROOT_CONTRACT) {
      if (!root.includes(`${attr}="${expected}"`)) {
        out.push({
          check: "root-attr",
          detail: `${fileName}: root must declare ${attr}="${expected}"`,
        });
      }
    }
  }

  for (const { detail } of scanProhibited(source, TIER2_PROHIBITED)) {
    out.push({ check: "prohibited", detail: `${fileName}: ${detail}` });
  }

  // Hardcoded palette colors — any fill/stroke anywhere that is not
  // "none"/"currentColor" breaks the colorless-master contract. The
  // lookbehind keeps e.g. data-fill=… from matching; stroke-width is not
  // matched because the attribute name is delimited by `=`.
  for (const m of source.matchAll(/(?<![-\w])(fill|stroke)="([^"]*)"/g)) {
    const value = m[2];
    if (value !== "none" && value !== "currentColor") {
      out.push({
        check: "hardcoded-color",
        detail: `${fileName}: ${m[1]}="${value}" — masters must be colorless (none/currentColor)`,
      });
    }
  }

  return out;
}
