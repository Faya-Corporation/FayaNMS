import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  BRAND_SOCIAL_ALT,
  BRAND_THEME_COLOR,
  BRAND_TITLE,
  BRAND_TITLE_TEMPLATE,
  FAYANMS_BRAND,
  siteUrl,
} from "../../src/lib/brand/identity";

/**
 * Brand identity unit tests (task R3-a).
 *
 * Covers re-audit findings:
 *  - B1-004 — metadata identity helpers (BRAND_TITLE / BRAND_TITLE_TEMPLATE /
 *    BRAND_THEME_COLOR / BRAND_SOCIAL_ALT) must exist, be derived from the
 *    single FAYANMS_BRAND source, and never drift from the governed values;
 *  - B3-029 — siteUrl() must fail fast in production (missing/localhost
 *    origin rejected) while keeping the localhost dev fallback;
 *  - B2-027 — the brand governance now has a dedicated automated test suite
 *    (this file) instead of relying on validation scripts alone.
 *
 * ENV HYGIENE: bun test runs every file in ONE process, so any env mutation
 * here is snapshotted in beforeEach and restored in afterEach — nothing
 * leaks into the other suites (tests/auth, tests/audit, tests/config and
 * the sibling tests/brand files).
 */

const ROOT = join(import.meta.dir, "..", "..");

describe("FAYANMS_BRAND — governed identity values (B1-004)", () => {
  test("name / descriptor / edition / shortName are exactly the governed strings", () => {
    expect(FAYANMS_BRAND.name).toBe("FayaNMS");
    expect(FAYANMS_BRAND.descriptor).toBe("Network Operations Management");
    expect(FAYANMS_BRAND.edition).toBe("Enterprise");
    expect(FAYANMS_BRAND.shortName).toBe("FayaNMS");

    // Non-empty invariants (governance contract, not just literals).
    expect(FAYANMS_BRAND.name.length).toBeGreaterThan(0);
    expect(FAYANMS_BRAND.descriptor.length).toBeGreaterThan(0);
    expect(FAYANMS_BRAND.edition.length).toBeGreaterThan(0);
    expect(FAYANMS_BRAND.shortName.length).toBeGreaterThan(0);
  });

  test("colors: primary #2563EB and accent #0891B2 (the two governed brand hues)", () => {
    expect(FAYANMS_BRAND.colors.primary).toBe("#2563EB");
    expect(FAYANMS_BRAND.colors.accent).toBe("#0891B2");
  });

  test("mark asset paths: static brand variant + micro derivative are governed", () => {
    expect(FAYANMS_BRAND.assets.markBrand).toBe("/brand/fayanms-mark-brand.svg");
    expect(FAYANMS_BRAND.assets.markMicro).toBe("/brand/fayanms-mark-micro.svg");
  });

  test("every asset path starts with '/' and resolves to an existing file under public/", () => {
    for (const [key, assetPath] of Object.entries(FAYANMS_BRAND.assets)) {
      expect(assetPath.startsWith("/")).toBe(true);
      const onDisk = join(ROOT, "public", assetPath.replace(/^\//, ""));
      expect({ key, onDisk, exists: existsSync(onDisk) }).toEqual({
        key,
        onDisk,
        exists: true,
      });
    }
  });
});

describe("derived identity helpers (B1-004)", () => {
  test("BRAND_TITLE is '<name> — <descriptor>' composed from FAYANMS_BRAND", () => {
    expect(BRAND_TITLE).toBe(`${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`);
    expect(BRAND_TITLE).toBe("FayaNMS — Network Operations Management");
  });

  test("BRAND_TITLE_TEMPLATE carries the '%s' placeholder and the product name", () => {
    expect(BRAND_TITLE_TEMPLATE).toContain("%s");
    expect(BRAND_TITLE_TEMPLATE).toContain(FAYANMS_BRAND.name);
    expect(BRAND_TITLE_TEMPLATE).toBe("%s · FayaNMS");
  });

  test("BRAND_THEME_COLOR mirrors colors.primary", () => {
    expect(BRAND_THEME_COLOR).toBe(FAYANMS_BRAND.colors.primary);
    expect(BRAND_THEME_COLOR).toBe("#2563EB");
  });

  test("BRAND_SOCIAL_ALT equals the canonical document title", () => {
    expect(BRAND_SOCIAL_ALT).toBe(BRAND_TITLE);
  });
});

describe("siteUrl()", () => {
  // bun-types declares process.env readonly; bun test runs every file in ONE
  // process, so we mutate through a mutable alias and RESTORE the saved
  // originals in afterEach — no env leaks into the other suites.
  const env = process.env as Record<string, string | undefined>;
  let savedSiteUrl: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedSiteUrl = env.NEXT_PUBLIC_SITE_URL;
    savedNodeEnv = env.NODE_ENV;
  });

  afterEach(() => {
    if (savedSiteUrl === undefined) {
      delete env.NEXT_PUBLIC_SITE_URL;
    } else {
      env.NEXT_PUBLIC_SITE_URL = savedSiteUrl;
    }
    if (savedNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = savedNodeEnv;
    }
  });

  test("development fallback: no env → http://localhost:3000", () => {
    delete env.NEXT_PUBLIC_SITE_URL;
    expect(env.NODE_ENV).not.toBe("production");
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  test("respects an explicit https origin (trailing slash normalized away)", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://nms.example.com/";
    expect(siteUrl()).toBe("https://nms.example.com");
  });

  test("throws on a value that is not a URL", () => {
    env.NEXT_PUBLIC_SITE_URL = "not-a-url";
    expect(() => siteUrl()).toThrow();
  });

  test("throws on a non-http(s) scheme (ftp://)", () => {
    env.NEXT_PUBLIC_SITE_URL = "ftp://files.example.com";
    expect(() => siteUrl()).toThrow();
  });

  test("production simulation: missing env fails fast (B3-029)", () => {
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      delete env.NEXT_PUBLIC_SITE_URL;
      expect(() => siteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  test("production simulation: localhost origin is rejected", () => {
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
      expect(() => siteUrl()).toThrow(/localhost/);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  test("production simulation: a real https origin returns exactly (trailing slash stripped)", () => {
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      env.NEXT_PUBLIC_SITE_URL = "https://example.com";
      expect(siteUrl()).toBe("https://example.com");
      env.NEXT_PUBLIC_SITE_URL = "https://example.com/";
      expect(siteUrl()).toBe("https://example.com");
    } finally {
      env.NODE_ENV = prev;
    }
  });
});
