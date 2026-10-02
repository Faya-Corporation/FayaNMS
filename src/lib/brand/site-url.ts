/**
 * Canonical site URL — SERVER-ONLY origin resolution (F-026, batch 9).
 *
 * The origin is read at RUNTIME from `SITE_URL` (deliberately NOT a
 * `NEXT_PUBLIC_*` variable — that prefix makes Next.js inline the build-time
 * value into every client bundle that includes the defining module, which is
 * exactly how the published GHCR images froze
 * `NEXT_PUBLIC_SITE_URL=https://fayanms.invalid` into their client bundles;
 * audit F-026: the ONLY value consumer is the root layout's metadataBase, a
 * server-side metadata evaluation — no client surface needs the origin).
 *
 * Re-audit B3-029 contract PRESERVED (not weakened — it moved with the
 * variable): silently emitting localhost/wrong-origin metadata in production
 * is a branding/SEO defect, so a production RUNTIME without the variable
 * fails fast at call time. Localhost is rejected outside development/test.
 * Because the evaluation is per-request (root layout generateMetadata under
 * `dynamic = "force-dynamic"`), host-side values now take effect WITHOUT a
 * rebuild — the F-026 fix proper.
 *
 * Server-only by construction: import this from server components / route
 * metadata only. Client components must never need the site origin.
 */

export function siteUrl(): string {
  const raw = process.env.SITE_URL;

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SITE_URL is required in production — set it to the canonical https:// origin (runtime env, no rebuild needed) so metadataBase/OG URLs are absolute and correct."
      );
    }
    return "http://localhost:3000";
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `SITE_URL must be an http(s) URL, got: "${raw}"`
    );
  }
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "0.0.0.0" ||
    parsed.hostname.endsWith(".local");
  if (isLocal && process.env.NODE_ENV === "production") {
    throw new Error(
      `SITE_URL must not point at localhost in production (got "${raw}") — deploy with the canonical public origin.`
    );
  }
  return parsed.toString().replace(/\/$/, "");
}
